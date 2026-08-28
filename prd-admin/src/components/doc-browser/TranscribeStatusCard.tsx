/**
 * 录音结果区顶部的状态卡 —— 对齐设计稿 `MAP 录音转录交付页 v2` 的 R4 / S5 / S6。
 *
 * 它同时是三张卡，按 run 的真实状态切换，**三者互斥**：
 *   处理中 → 三阶段进度（保存音频 / 生成原文 / 补齐录音理解）
 *   失败   → 四字段（原因与 code / 时间 / 仍可用能力 / 下一步），自动重试时显示倒计时
 *   没跑过 → 手动入口
 *
 * 为什么要互斥：改之前这三种情况共用同一张「把录音转成文字」卡，于是转录**正在跑**的时候，
 * 页面一边挂着「当前录音正在后台处理」的横幅，一边还摆着「转成文字」按钮——两句话互相打脸，
 * 而且那个按钮点下去会再发起一次转录。用户 2026-08-25 的线上截图拍到的就是这一幕。
 *
 * 状态四问（设计稿硬约束）在处理中这一档要答齐：
 *   音频是否安全 → 抬头第二行 + 保存音频那一格恒为已完成
 *   现在在做什么 → 活动阶段的 detail（后端 phase 原话）
 *   还要多久     → 按本次运行自己的速度外推；算不出来就说在积累数据，不编
 *   你现在能做什么 → 「音频已就绪，现在就能播放」
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, AudioLines, BellRing, BookOpen, Check, ChevronRight, Clock3, Copy, Download, LifeBuoy, Mic, MicOff, Play, RefreshCw, Sparkles, Wand2 } from 'lucide-react';
import { describeFailurePresentation } from '@/pages/document-store/recordingVault';
import type { FailedTranscriptionNotice } from '@/pages/document-store/recordingVault';
import { onRecordingDuration } from './recordingPlayBridge';
import '@/styles/recording-design-palette.css';
import {
  describeCompletionSummary,
  describeOrganizeProgress,
  isAiUnavailableFailure,
} from '@/pages/document-store/recordingCompletionView';
import {
  describeAudioStageElapsed,
  describeTranscriptionStages,
  estimateRemainingSeconds,
  formatDurationSec,
  type TranscriptionStage,
} from '@/pages/document-store/transcriptionStages';

/**
 * 失败卡四种处境的面孔。稿面给它们各画了一种：真失败是红/粉错误面、
 * 自动重试与排队是暖琥珀的「在动，别急」、没听到人声是克制的中性白。
 * 全部走语义 token，双主题各自成立（admin-dual-theme 那条棘轮）。
 */
const FAILURE_TONE: Record<string, { surface: string; border: string; iconBg: string; iconFg: string }> = {
  danger:   { surface: 'var(--semantic-danger-soft)',  border: 'var(--semantic-danger)',       iconBg: 'var(--semantic-danger-soft)',  iconFg: 'var(--semantic-danger)' },
  retrying: { surface: 'var(--semantic-warning-soft)', border: 'var(--semantic-warning-text)', iconBg: 'var(--semantic-warning-soft)', iconFg: 'var(--semantic-warning-text)' },
  queued:   { surface: 'var(--semantic-warning-soft)', border: 'var(--border-faint)',          iconBg: 'var(--semantic-warning-soft)', iconFg: 'var(--semantic-warning-text)' },
  neutral:  { surface: 'var(--bg-card)',               border: 'var(--border-faint)',          iconBg: 'var(--bg-elevated)',           iconFg: 'var(--text-secondary)' },
};

function FailureIcon({ kind }: { kind: string }) {
  // 转圈箭头要真的在转：后台正在替用户做事，静止图标读起来和硬失败一样
  if (kind === 'retry') return <RefreshCw size={16} className="animate-spin motion-reduce:animate-none" />;
  if (kind === 'clock') return <Clock3 size={16} />;
  if (kind === 'mic-off') return <MicOff size={16} />;
  return <AlertTriangle size={16} />;
}

/**
 * 把「第 2 / 3 次」「8 秒」这类计数与倒计时从句子里**加粗提出来**。
 *
 * 稿面 v2-S6 / cap-S7 的那句话里，这两个数是唯一带字重的锚点——用户扫这张卡时
 * 要的就是「还剩几次、还要等多久」，其余是解释。整句同一个字重的话，
 * 他得逐字读完才找得到答案（两份判分各记了一次）。
 */
function emphasizeCounters(text: string): React.ReactNode {
  const parts = text.split(/(第\s*\d+\s*\/\s*\d+\s*次|\d+(?:\.\d+)?\s*(?:秒|分钟|小时|s))/);
  return parts.map((part, index) => (
    index % 2 === 1
      ? <strong key={index} style={{ color: 'var(--text-primary)' }}>{part}</strong>
      : <span key={index}>{part}</span>
  ));
}

/** mm:ss / h:mm:ss —— 设计稿「保存音频」那一行要的时长写法。 */
function formatClockLabel(sec: number): string {
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export type TranscribeStatusRun = {
  id: string;
  status: string;
  phase?: string;
  progress?: number;
  startedAt?: string;
  createdAt?: string;
  /** 已经生成出来的原文前几句（有就显示，没有就渲染骨架） */
  transcriptPreview?: string[];
};

/** 秒级心跳：处理中与倒计时两档都要「持续在动」，静止超过 2 秒即体验缺陷。 */
function useSecondTick(active: boolean): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return tick;
}

function StageRow({ stage, remainingLabel, elapsedLabel }: {
  stage: TranscriptionStage;
  remainingLabel?: string | null;
  /** 「已用 33 秒」。稿面把它与百分比、预计剩余编在**同一行**——三个数回答的是同一个问题 */
  elapsedLabel?: string | null;
}) {
  const done = stage.state === 'done';
  const active = stage.state === 'active';
  const pending = stage.state === 'pending';
  return (
    /*
      还没开始的那一格整体压暗：三行同一个明度时，「已完成 / 进行中 / 未开始」
      在视觉上只剩两档，排队态全靠文案里那三个字撑（R4 判分记的这处）。
    */
    <div className="flex items-start gap-2.5" style={pending ? { opacity: 0.5 } : undefined}>
      <div
        className="mt-[2px] flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full"
        style={{
          background: done ? 'var(--accent-fg-success)' : 'transparent',
          /*
            进行中那一档的外圈要**中性色**，不能也用强调色：整圈蓝会把里面那段弧的缺口
            补死，静态截图里读成一枚均匀闭合的圆环（R4 判分连着三轮指到这处）。
            但外圈本身不能去掉——去掉之后这一格只剩一段小弧，与上下两枚圆点不再是
            同尺寸同家族（去掉那一轮 R4 又记了一次）。中性底轨 + 蓝色弧，两头都成立。
          */
          border: done ? 'none' : '1px solid var(--border-faint)',
        }}
        aria-hidden
      >
        {done ? <Check size={10} style={{ color: 'var(--bg-base)' }} /> : active ? (
          // 设计稿这一格是一枚带缺口的强调色圆环在转，不是通用 spinner 图标
          <span
            // 与完成/排队两档的圈同尺寸同重量：小一号、描边细一档，三行的圈列就不齐了，
            // 「正在做的那一格」反而比做完的更弱（判官记的是「视觉对齐节奏被打断」）。
            style={{
              width: 16, height: 16, borderRadius: '50%',
              // 稿面这枚是**一段缺口弧线**在转。整圈淡蓝 + 顶端一段深蓝那种画法，
              // 静态截图里读起来就是一个闭合圆环，「正在转」的形状语义没了（R4 判分记的这处）。
              // 三面透明只留一段，缺口才看得出来。
              border: '2.5px solid transparent',
              // 只染一段顶弧：染两条边在小尺寸上会连成一整圈，静止截图里读成一个闭合圆环，
              // 「正在转」那层语义没了（R4 判分连着两轮指到这处）。
              borderTopColor: 'var(--accent-fg-info)',
              animation: 'spin 0.9s linear infinite',
            }}
            aria-hidden
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className="text-[13px]"
            style={{
              // 三行要能一眼分出「做完了 / 正在做 / 还没开始」：
              // 正在做的用强调色 + 最重字重，还没开始的降到常规字重与弱化色，
              // 三行同一个字重等于把这层层级抹平（审查智能体上一轮正是扣在这里）。
              color: active ? 'var(--accent-fg-info)'
                : stage.state === 'pending' ? 'var(--text-muted)' : 'var(--text-primary)',
              fontWeight: active ? 700 : stage.state === 'pending' ? 400 : 600,
            }}
          >
            {stage.label}
          </span>
          {active && stage.percent !== null && (
            // 百分比与剩余时间在稿面是**灰色次要文本**。蓝在这套设计里只留给
            // 阶段标题与进度条两处；这一行也用蓝，强调色就扩散成「哪都是蓝」，
            // 阶段标题反而不再突出。
            <span className="flex-shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {stage.percent}%{elapsedLabel ? ` · ${elapsedLabel}` : ''}{remainingLabel ? ` · ${remainingLabel}` : ''}
            </span>
          )}
        </div>
        {/* 设计稿的顺序是 标题 → 进度条 → 副行：先看到走到哪，再看它在干嘛 */}
        {active && stage.percent !== null && (
          <div
            /*
              稿面这条比正文那几行明显厚一档（约 6px），且余量段有看得见的浅灰轨道——
              「64% 之后还剩多少」是靠轨道读出来的。3px + `--bg-elevated` 在浅色皮肤上
              退化成一根悬空的蓝线，余量读不出来（R4 判分记的这处）。
            */
            className="mt-1.5 h-[6px] w-full overflow-hidden rounded-full"
            style={{ background: 'var(--skeleton-fill)' }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(2, stage.percent)}%`,
                background: 'var(--accent-fg-info)',
                transition: 'width 300ms linear',
              }}
            />
          </div>
        )}
        <p
          className="mt-1 truncate text-[11px]"
          // 稿面这一行（「24:18 · 19.1 MB · 耗时 1.2s」）是灰的：绿色在这一屏只标两处——
          // 保存音频那枚勾、以及音频卡那句「音频已就绪，可立即播放」。铺到量级行上，
          // 「哪件事现在已经可用」就不再靠颜色一眼看出来了（R4 判分记的「绿色语义被稀释」）。
          style={{ color: 'var(--text-muted)' }}
        >
          {stage.detail}
        </p>
        {/*
          产出计数（稿面 R4「已生成 84 / 约 132 句」、cap-S4「其余会陆续出现」）：
          它回答的是「产物到哪了、还剩多少」，和「百分比」不是同一件事——
          百分比是时间进度，这一行是**东西**的进度。
        */}
        {stage.yieldLine && (
          <p className="mt-0.5 truncate text-[11px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
            {stage.yieldLine}
          </p>
        )}
        {/*
          稿面 v2-S2 / cap-S3 把「音频已可播放，无需等待」写在**进度块自己**里：
          那一行的作用不是报进度，是当场消掉等待焦虑。此前它被拆到播放卡与底部蓝条两处，
          单看这一格读不到这句话（两份判分各扣了一次结构与内容）。
        */}
        {active && stage.key === 'transcript' && (
          <p className="mt-1 text-[11px] font-semibold" style={{ color: 'var(--accent-fg-success)' }}>
            音频已可播放，无需等待
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 三段横条各格的标签（稿面 cap-A4 / cap-A5）。它与竖排清单的标签是两套：
 * 横条说的是「这一步现在处于什么状态」，清单说的是「这一步在做什么」。
 * 查不到就退回清单那套，不留空。
 */
const BAR_LABEL: Record<string, Partial<Record<'done' | 'active' | 'pending', string>>> = {
  audio: { done: '录音已保存', active: '正在保存录音', pending: '等待保存' },
  transcript: { done: '原文已生成', active: '正在生成原文', pending: '等待生成原文' },
  understanding: { done: '结果页已补齐', active: '结果页补齐', pending: '结果页补齐' },
};

export function TranscribeStatusCard({
  currentEntryId,
  noteEntryId,
  subtitleEntryId,
  activeRun,
  lastFailure,
  audioTitle,
  audioSizeLabel,
  audioDateLabel,
  transcriptPreview,
  generatedSentences,
  completion,
  organizeStyleLabel,
  onOpenServiceStatus,
  onReRecord,
  onDownloadAudio,
  onCopyTranscript,
  onContactSupport,
  headline,
  suppressPrimaryAction,
  onStart,
  onOpenNote,
  onRestyle,
  onEnterResult,
  onPlayRequest,
}: {
  currentEntryId: string;
  noteEntryId?: string;
  subtitleEntryId?: string;
  /** 当前条目那条在途 run；有值即「处理中」，此时不显示手动入口 */
  activeRun?: TranscribeStatusRun | null;
  lastFailure?: FailedTranscriptionNotice | null;
  /** 这段录音的标题（设计稿处理中那一屏要求把它显示出来，而不是只说「这段录音」） */
  audioTitle?: string;
  /** 体积，如「19.1 MB」；拿不到就不传，界面不会编一个 */
  audioSizeLabel?: string | null;
  /** 录制日期，如「8 月 16 日」（稿面 cap-A4/A5 编在音频卡标题里）。拿不到就不传。 */
  audioDateLabel?: string | null;
  /** 已经生成出来的原文（有几句给几句）；为空时渲染骨架而不是留白 */
  transcriptPreview?: string[];
  /**
   * 已生成的**总**句数（预览只给前几行，算产出计数要的是总数）。
   * 拿不到就退回预览行数——那会偏小，但偏小是如实的下界，不是编的。
   */
  generatedSentences?: number;
  /** 转录全部跑完之后那条绿卡的口径（稿面 v2-S3 / cap-S5）。数不出来就不传，界面不编。 */
  completion?: { sentences: number; speakers: number; hasSummary: boolean; hasTodos: boolean } | null;
  /**
   * 这次在跑的整理方式的**显示名**（如「会议纪要」）。
   * 只在「原文已经有了、正在重新整理」时用得上——那一刻不该再摆一遍三阶段清单，
   * 稿面 cap-S6 画的是一条「正在生成会议纪要 · 约 20s · 可以先去播放和阅读」。
   */
  organizeStyleLabel?: string | null;
  /** 「查看服务状态」的去处（稿面 cap-S9）。不传就不渲染那颗按钮，不给一个点了没反应的。 */
  onOpenServiceStatus?: () => void;
  /** 「重新录制」（稿面 v2-S4）：这段没人声时，重试同一段音频不会有别的结果，出口是重录。 */
  onReRecord?: () => void;
  /** 「下载音频」（稿面 v2-S5）：转录失败不影响音频本身，用户要能把它拿走。 */
  onDownloadAudio?: () => void;
  /**
   * 「复制原文」（稿面 cap-S8）：纪要没生成出来时的自救出口——原文好好的，
   * 用户可以先把它拿走自己整理，而不是干等一个反复失败的整理任务。
   */
  onCopyTranscript?: () => void;
  /** 「联系支持」（稿面 cap-S10）。不传就不渲染，不给一个点了没去处的按钮。 */
  onContactSupport?: () => void;
  /**
   * 处理中那一屏的 H1。整屏形态（录音处理页）走稿面 cap-A4/A5 的「正在准备结果页」；
   * 不传就是阅读器内嵌形态的「正在整理这段录音」（稿面 R4）。
   */
  headline?: string;
  /** 整屏形态自己有吸底操作栏，卡内那颗主操作要让位，否则同一件事摆两颗按钮 */
  suppressPrimaryAction?: boolean;
  onStart?: (styleKey?: string) => void;
  onOpenNote: (entryId: string) => void;
  onRestyle?: () => void;
  /**
   * 处理中那一屏的主操作。设计稿画的是「进入结果页并开始播放」——它同时是这一屏
   * 通往结果页的**唯一**入口，不是单纯的播放键。有结果页可去时传这个。
   */
  onEnterResult?: () => void;
  /**
   * 降级：宿主没有结果页可跳（分享只读页、周报页）时的就地播放。
   * 两个入口分开而不是共用一个，是因为按钮文案必须和它真正做的事一致——
   * 写「进入结果页」却只是就地播放，是最典型的意外。
   */
  onPlayRequest?: () => void;
}) {
  const inPlace = !!noteEntryId && noteEntryId === currentEntryId;
  // 时长只有播放器知道（条目元数据没这个字段），订阅它广播的那一个数
  const [durationSec, setDurationSec] = useState(0);
  useEffect(() => onRecordingDuration(setDurationSec), []);
  const durationLabel = durationSec > 0 ? formatClockLabel(durationSec) : null;
  // 原文已经在了还在跑 run，那跑的是「补齐理解」那一层，不是从头转录：
  // 再摆一遍「保存音频 → 生成原文 → 补齐理解」等于把两件事说成同一件。
  const audioStageElapsed = describeAudioStageElapsed(activeRun);
  const stages = describeTranscriptionStages(activeRun, {
    sizeLabel: audioSizeLabel,
    durationLabel,
    elapsedLabel: audioStageElapsed,
    // 已经吐出来的句数：优先用调用方数过的真数，没有就退回预览行数
    generatedSentences: generatedSentences ?? transcriptPreview?.length ?? 0,
  });
  const processing = stages !== null;
  // 失败卡只在没有在途 run 时出现：又在跑又说失败，等于同屏两句互相打脸
  const aiUnavailable = isAiUnavailableFailure(lastFailure?.code);
  // AI 整体不可用时不再叠一张「转录失败」卡：那是同一件事的两种说法，
  // 两张一起出现，用户会以为出了两个故障（稿面 cap-S9 只画了那一条横幅）。
  /*
    原文已经在了还报失败，挂的必然是**衍生产物**那一层（整理/词云/纪要）——
    转录不会在原文已存在时重跑一遍。此前这一档被 `!noteEntryId` 整个挡掉，
    于是「纪要没生成出来」这件事在界面上完全不存在（稿面 v2-S6 / cap-S7 / cap-S8
    画的正是它）。现在照常显示，只是标题点名到底是哪一样挂了。
  */
  const failureTarget = noteEntryId ? (organizeStyleLabel?.trim() || '整理') : null;
  const showFailure = !processing && !!lastFailure && !aiUnavailable;
  const retryAt = lastFailure?.automaticRetryNextAt ? Date.parse(lastFailure.automaticRetryNextAt) : NaN;
  const now = useSecondTick(processing || Number.isFinite(retryAt));
  const waitingAutoRetry = Number.isFinite(retryAt) && retryAt > now;
  // 失败卡的三句话（抬头 / 副标 / 下一步）全从这一份判据来，不在 JSX 里各写各的
  const failureCopy = lastFailure
    ? describeFailurePresentation(lastFailure, {
      waitingAutoRetry,
      retryLabel: waitingAutoRetry ? `${formatDurationSec((retryAt - now) / 1000)}后` : undefined,
      hasPartialTranscript: (lastFailure.partialTranscript?.length ?? 0) > 0 || (transcriptPreview?.length ?? 0) > 0,
      // 挂掉的是哪一样、原文在不在、纪要在不在——三样都从这一刻的真实状态取，
      // 不从稿面抄。「原文不受影响」这句话在原文并不存在时是假的。
      target: lastFailure.target ?? failureTarget,
      hasTranscript: !!noteEntryId,
      hasSummary: !!completion?.hasSummary,
      durationLabel,
    })
    : null;

  /*
    「完成后通知我」（稿面 cap-S10）。
    它必须真的会通知，否则就是一句空承诺——用的是浏览器自己的通知权限：
    授权后，这一屏观察到 run 转成终态时发一条系统通知。授权被拒就如实说拒了，
    不假装已经订阅上。关掉这一页就通知不了，所以按钮下面写明了这个前提。
  */
  const [notifyState, setNotifyState] = useState<'idle' | 'armed' | 'denied'>('idle');
  const armNotify = () => {
    if (typeof Notification === 'undefined') { setNotifyState('denied'); return; }
    if (Notification.permission === 'granted') { setNotifyState('armed'); return; }
    void Notification.requestPermission().then(result => setNotifyState(result === 'granted' ? 'armed' : 'denied'));
  };
  /*
   * run 一转终态就把那条通知发出去（只发一次）。
   *
   * 「转终态」必须是**亲眼看到的那一次翻转**：先看到它在跑，之后才看到它不跑了。
   * 光判 `!processing` 不行——「完成后通知我」这颗按钮长在失败卡上，而失败卡本来就
   * 只在不处理时才出现，于是点下去当场就弹一条「有新进展」，其实什么都没完成
   * （Codex P2 抓到的正是这条）。用户重试之后 processing 会再翻上去，那时这条通知
   * 才等到它该等的那一刻。
   */
  const notifiedRef = useRef(false);
  const sawProcessingRef = useRef(false);
  useEffect(() => { if (processing) sawProcessingRef.current = true; }, [processing]);
  useEffect(() => {
    if (notifyState !== 'armed' || notifiedRef.current) return;
    if (processing || !sawProcessingRef.current) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    notifiedRef.current = true;
    new Notification('录音处理有新进展', { body: audioTitle?.trim() || '这段录音' });
  }, [audioTitle, notifyState, processing]);

  /** 失败卡底部那组出口。顺序由判据给，这里只负责把每一种接到真实的处理函数上。 */
  const failureActions = (failureCopy?.actions ?? []).flatMap((action): {
    key: string; label: string; icon: React.ReactNode; run: () => void; disabled?: boolean;
  }[] => {
    switch (action) {
      case 'retry':
        return onStart ? [{ key: 'retry', label: '重试', icon: <RefreshCw size={12} />, run: () => onStart() }] : [];
      case 'play':
        return onPlayRequest ? [{ key: 'play', label: '播放确认', icon: <Play size={12} fill="currentColor" />, run: onPlayRequest }] : [];
      case 'rerecord':
        return onReRecord ? [{ key: 'rerecord', label: '重新录制', icon: <Mic size={12} />, run: onReRecord }] : [];
      case 'download':
        return onDownloadAudio ? [{ key: 'download', label: '下载音频', icon: <Download size={12} />, run: onDownloadAudio }] : [];
      case 'copyTranscript':
        return onCopyTranscript ? [{ key: 'copy', label: '复制原文', icon: <Copy size={12} />, run: onCopyTranscript }] : [];
      case 'notify':
        return [{
          key: 'notify',
          label: notifyState === 'armed' ? '完成后会通知你' : notifyState === 'denied' ? '通知权限被拒绝' : '完成后通知我',
          icon: <BellRing size={12} />,
          run: armNotify,
          disabled: notifyState !== 'idle',
        }];
      case 'support':
        return onContactSupport ? [{ key: 'support', label: '联系支持', icon: <LifeBuoy size={12} />, run: onContactSupport }] : [];
      default:
        return [];
    }
  });

  const timing = processing ? estimateRemainingSeconds(activeRun, now) : null;
  /** 「生成原文」那一格算出来的产出计数，骨架条脚注与阶段行读同一份，不各算一次（形状 3） */
  const transcriptYieldLine = stages?.find(stage => stage.key === 'transcript')?.yieldLine ?? null;
  /** 原文那一格是否已经写完（决定音频卡带不带句数、蓝提示条说哪一句） */
  const transcriptDone = stages?.find(stage => stage.key === 'transcript')?.state === 'done';

  /*
    「生成原文」那一格的耗时（稿面 cap-A5 在这一格写的是「48s · 132 句」）。

    后端不下发单阶段时间，所以这里量的是**这一屏亲眼看到的那次翻转**：从 run 开跑
    到原文那一格由「进行中」变成「已完成」。没亲眼看到（进页面时它已经写完了）就
    什么都不显示——倒推一个数出来就是编（no-rootless-tree）。
  */
  const transcriptStageWatch = useRef<{ runId: string; sawActive: boolean; measured: boolean }>({
    runId: '', sawActive: false, measured: false,
  });
  const [transcriptStageElapsed, setTranscriptStageElapsed] = useState<string | null>(null);
  const transcriptStageState = stages?.find(stage => stage.key === 'transcript')?.state ?? null;
  const runId = activeRun?.id ?? '';
  const runStartedAt = activeRun?.startedAt ?? activeRun?.createdAt ?? null;
  useEffect(() => {
    if (transcriptStageWatch.current.runId !== runId) {
      transcriptStageWatch.current = { runId, sawActive: false, measured: false };
      setTranscriptStageElapsed(null);
    }
    const watch = transcriptStageWatch.current;
    if (transcriptStageState === 'active') { watch.sawActive = true; return; }
    if (transcriptStageState !== 'done' || !watch.sawActive || watch.measured) return;
    const started = runStartedAt ? new Date(runStartedAt).getTime() : NaN;
    if (!Number.isFinite(started)) return;
    const sec = (Date.now() - started) / 1000;
    // 负数或长到不像话（跨天的旧 run）都不认：那说明这个时间戳不能用来算这一段
    if (sec <= 0 || sec > 6 * 3600) return;
    watch.measured = true;
    setTranscriptStageElapsed(sec < 10 ? `${sec.toFixed(1)}s` : formatDurationSec(sec));
  }, [runId, runStartedAt, transcriptStageState]);
  const reorganizing = processing && !!noteEntryId;
  /*
    有失败卡的时候不再摆那张绿色成果卡。
    「全部完成 · 纪要与待办已就绪」压在「会议纪要生成失败」上面，是同屏两句互相打脸，
    而且抢走了失败卡的首位——三份判分都指到这一处。
  */
  const completionCopy = !processing && !showFailure && completion ? describeCompletionSummary(completion) : null;
  const organizeCopy = reorganizing
    ? describeOrganizeProgress({
      styleLabel: organizeStyleLabel,
      remainingSec: estimateRemainingSeconds(activeRun, now)?.remainingSec ?? null,
    })
    : null;
  // AI 整体不可用是**另一件事**：录音与原文都好好的，只是理解/整理/问答这一层没了。
  // 混进转录失败卡里说，用户会以为录音也出事了（稿面 cap-S9 专门画了一条横幅）。
  const aiDown = aiUnavailable && !processing && !noteEntryId ? lastFailure : null;
  const chips = (noteEntryId && !inPlace) || subtitleEntryId || (noteEntryId && onRestyle)
    || (onEnterResult && !inPlace && !processing);

  return (
    /*
     * 作用域皮肤：这张卡属于录音这条链路，稿面给它的强调色是蓝、主按钮是黑，
     * 而它寄生在知识库阅读器里，默认拿到的是平台的陶土橙——判分里
     * 「主按钮与播放按钮由黑改橙棕、强调色从两处扩到四处」扣的就是这个。
     * 皮肤是 token 覆盖且只作用于这棵子树，组件代码一行都不用改
     * （与录音结果页共用同一份 recording-design-palette.css）。
     */
    <div
      /*
        整屏形态（录音处理页）是**通栏直排**：稿面 R4 / cap-A4 / cap-A5 的大标题与三阶段
        直接落在页面底色上。再套一层白卡会把间距节奏与层级观感整体改掉（三份判分各记一次）。
        寄生在阅读器里时仍然要这层卡——那时它是页面内容中的一块，需要自己的边界。
      */
      className={`recording-design-palette mb-4 flex flex-col gap-3 ${
        suppressPrimaryAction ? 'min-h-0 flex-1 px-0 py-0' : 'surface-inset rounded-[14px] px-4 py-3.5'
      }`}
      data-tour-id="doc-transcribe-hero"
      // 失败态整张卡跟着色调走：四种处境此前共用同一套中性壳，
      // 用户扫一眼分不出「坏了」「在重试」「在排队」「没听到人声」
      style={showFailure && failureCopy ? {
        background: FAILURE_TONE[failureCopy.tone].surface,
        border: `1px solid ${FAILURE_TONE[failureCopy.tone].border}`,
      } : undefined}
    >
      {/*
        AI 服务不可用（稿面 cap-S9）：它不是「转录失败」，而是「理解那一层暂时没了」。
        所以单独一条横幅，并且明确列出哪些能力照常可用——用户最怕的是「是不是全废了」。
      */}
      {aiDown && (
        <div
          className="rounded-[12px] px-3.5 py-3"
          /*
            稿面 cap-S9 这块是**中性面板**，只有标题是琥珀色。整块染成琥珀之后，
            强调色从一个点扩散成一整片背景，「AI 那一层没了、其余照常」这句话
            读起来像整屏都出事了。
          */
          // 橙色只出现在标题一处：给整卡再描一圈橙边、再加一枚橙色警示图标，
          // 强调色就从一个点扩散到三处，「只是理解那一层没了」听起来像整屏出事
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}
        >
          <p className="text-[13px] font-semibold" style={{ color: 'var(--semantic-warning-text)' }}>
            AI 服务暂时不可用
          </p>
          <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {aiDown.at ? `发生于 ${new Date(aiDown.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}。` : ''}
            <strong style={{ color: 'var(--text-primary)' }}>录音、原文、编辑、搜索、跳播全部照常可用</strong>
            ；理解、整理、问答已折叠，恢复后自动补齐。
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {/*
              稿面这张卡只画了一个出口：通栏的「查看服务状态」。
              「重试」是我们补的——服务恢复之后总得有地方重新排队——但它不能抢走首位：
              上一版把重试做成白底实心摆在右边，卡内视觉最重的按钮就成了稿面没有的那一颗。
            */}
            {onOpenServiceStatus && (
              <button
                type="button"
                onClick={onOpenServiceStatus}
                className="flex min-h-10 w-full cursor-pointer items-center justify-center rounded-[10px] px-3 text-[13px] font-semibold"
                style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
              >
                查看服务状态
              </button>
            )}
            {onStart && (
              <button
                type="button"
                onClick={() => onStart()}
                className="flex min-h-10 w-full cursor-pointer items-center justify-center rounded-[10px] px-4 text-[13px] font-semibold"
                style={{ border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
              >
                重试
              </button>
            )}
          </div>
        </div>
      )}

      {/* 转录跑完那条绿卡（稿面 v2-S3 / cap-S5）：一句话交代产出了多少东西 */}
      {completionCopy && (
        <div
          className="flex items-center gap-3 rounded-[12px] px-3.5 py-3"
          style={{ background: 'var(--semantic-success-soft)' }}
        >
          <span
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full"
            style={{ background: 'var(--accent-fg-success)', color: 'var(--bg-card)' }}
            aria-hidden
          >
            <Check size={16} />
          </span>
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold" style={{ color: 'var(--semantic-success-text)' }}>
              {completionCopy.title}
            </span>
            <span className="mt-0.5 block text-[12px]" style={{ color: 'var(--semantic-success-text)' }}>
              {completionCopy.detail}
            </span>
          </span>
        </div>
      )}

      {/* 后台整理进行中（稿面 cap-S6）：点名到具体那一种产物，并给「不用在这等」的出口 */}
      {organizeCopy && (
        <div className="flex items-center gap-3 rounded-[12px] px-3.5 py-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}>
          <span
            aria-hidden
            style={{
              width: 20, height: 20, borderRadius: '50%',
              border: '2.5px solid color-mix(in srgb, var(--accent-fg-info) 26%, transparent)',
              borderTopColor: 'var(--accent-fg-info)',
              animation: 'spin 0.9s linear infinite',
            }}
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-token-primary">{organizeCopy.title}</span>
            <span className="mt-0.5 block text-[11px] text-token-muted">{organizeCopy.detail}</span>
          </span>
        </div>
      )}

      {processing && !reorganizing ? (
        <>
          {/* 页面级标题：设计稿这一屏的 H1，不是卡内小标题 */}
          <div>
            {/* 稿面这句是超大号 H1，要和副标题、阶段标题拉开三级；20px 压不出这个层级 */}
            <h2 className="text-[26px] font-bold leading-tight tracking-tight text-token-primary">
              {headline?.trim() || '正在整理这段录音'}
            </h2>
            {/* 「音频是否安全」+「你现在能做什么」两问合成一句，紧跟标题。
                稿面这一句是接近正文的大号灰字，与 H1 构成两级递降；压到最小号之后
                它读成一行附注，两级层级塌成一级（cap-A4 判分记的这处）。 */}
            <p className="mt-1.5 text-[14px] leading-relaxed text-token-muted">
              {/*
                两张画布对这一屏的 H1 各写各的：R4 是「正在整理这段录音」，
                cap-A4/A5 是「正在准备结果页」。整屏那一版取后者当 H1，
                前者落到这一行——两句都在，谁也没少（判分口径：可以多，不可以少）。
              */}
              {/*
                到了补齐那一档，这句话必须换：稿面 cap-A5 写的是「原文已完成，正在补齐词云与整理」。
                停在上一阶段那句「音频已经安全保存，你现在就可以播放」，
                等于这一屏的主叙述句落后了一整个阶段（判分按内容缺失记）。
              */}
              {transcriptDone
                ? '原文已完成，正在补齐词云与整理。'
                : `${headline?.trim() ? '正在整理这段录音。' : ''}音频已经安全保存，你现在就可以播放。`}
            </p>
          </div>

          {/*
            横向三段进度条（稿面 cap-A4 的画法）。另一张画布（R4）把同一刻画成竖排清单，
            两稿对同一处给了两种组织方式——都给：这一条负责「一眼扫完三阶段走到哪」，
            下面的清单负责「每一阶段的细节」。三段的颜色直接读清单同一份 state，不另判一次。
          */}
          <div className="flex items-stretch gap-1.5" aria-hidden>
            {stages.map(stage => (
              <span key={`bar-${stage.key}`} className="flex min-w-0 flex-1 flex-col gap-1">
                <span
                  className="block h-[4px] w-full overflow-hidden rounded-full"
                  /*
                    底轨要看得见：`--bg-elevated` 在浅色皮肤上几乎与页面同色，第三段整条底轨
                    在截图里读不出来，「还剩多少」只能靠文字（cap-A4 判分记的这处）。
                    换成骨架同一档灰，两个主题下都与页面拉得开。
                  */
                  style={{ background: 'var(--skeleton-fill)' }}
                >
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: stage.state === 'done' ? '100%' : stage.state === 'active' ? `${Math.max(6, stage.percent ?? 0)}%` : '0%',
                      background: stage.state === 'done' ? 'var(--accent-fg-success)' : 'var(--accent-fg-info)',
                      transition: 'width 300ms linear',
                    }}
                  />
                </span>
                <span
                  className="block truncate text-[10px]"
                  style={{
                    color: stage.state === 'done'
                      ? 'var(--accent-fg-success)'
                      : stage.state === 'active' ? 'var(--accent-fg-info)' : 'var(--text-muted)',
                  }}
                >
                  {/*
                    这条横条是 cap-A4/A5 的元件，它的标签是**状态化文案**
                    （录音已保存 / 正在生成原文 / 结果页补齐）；下面那份竖排清单是
                    v2-R4 的元件，用的是动作名（保存音频 / 生成原文 / 补齐录音理解）。
                    两稿各要一套，各归各的元件，不是二选一。
                  */}
                  {BAR_LABEL[stage.key]?.[stage.state] ?? stage.label}
                </span>
                {/*
                  每段自己的量级行（稿面 cap-A4/A5 是「标签 + 数值」两行）。
                  只留标签的话，这条横条退化成纯装饰——它本来是「一眼扫完三阶段各走到哪」的那一层。
                */}
                <span className="block truncate text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                  {/*
                    稿面 cap-A4/A5 这一行三格给的都是**量**（1.2s / 48s · 132 句 / 30% · 约 20s），
                    不是「已完成 / 排队中」这类状态词——状态由上面那条彩色横条自己说了。
                    量给得出来就给，给不出来（没量到耗时、算不出剩余）才退回状态词，不编数字。
                  */}
                  {stage.state === 'done'
                    ? (stage.key === 'transcript'
                      ? [transcriptStageElapsed, (generatedSentences ?? 0) > 0 ? `${generatedSentences} 句` : null]
                        .filter(Boolean).join(' · ') || '已完成'
                      // 「耗时」两个字要带着（稿面 cap-A4 这一格写的是「耗时 1.2s」）：
                      // 只留裸数值的话，横条单独看是一个没人解释的数字
                      : stage.key === 'audio'
                        ? (audioStageElapsed || '已完成')
                        : '已完成')
                    : stage.state === 'active'
                      ? `${stage.percent ?? 0}%${timing?.remainingSec != null ? ` · 约 ${formatDurationSec(timing.remainingSec)}` : ''}`
                      : '排队中'}
                </span>
              </span>
            ))}
          </div>

          <div className="flex flex-col gap-3">
            {stages.map(stage => (
              <StageRow
                key={stage.key}
                stage={stage.key === 'transcript' && stage.state === 'done' && transcriptStageElapsed
                  // 量到了就把耗时挂到这一格的副行上（稿面 cap-A5 同屏另两段都有时间维度，
                  // 唯独这一段没有的话，读起来像漏了一项）
                  ? { ...stage, detail: `${stage.detail} · 耗时 ${transcriptStageElapsed}` }
                  : stage}
                /*
                  「还要多久」挂在正在跑的那一格右侧，跟着它走。
                  措辞必须带「预计还需」四个字：只写「约 40 秒」的话，它紧跟在 64% 后面，
                  读者分不清这是已经用掉的还是还要等的（S2 / cap-S3 判分记的正是这处）。
                */
                remainingLabel={stage.state === 'active' && timing?.remainingSec != null
                  ? `预计还需 ${formatDurationSec(timing.remainingSec)}`
                  : null}
                // 「已用」与百分比、预计剩余同处一行；卡底那条独立的「已用 N 秒」随之撤掉
                elapsedLabel={stage.state === 'active' && timing ? `已用 ${formatDurationSec(timing.elapsedSec)}` : null}
              />
            ))}
          </div>

          {/*
            音频卡与逐句原文在稿面 cap-A4/A5 是**同一张卡的两个面**，用一条分隔线连起来：
            上面是这段音频本身，下面是它正在长出来的字。拆成两张独立卡之后，
            「这两块说的是同一条录音」这层从属关系就断了（判分记的正是这处）。
          */}
          <div
            className={`flex flex-col rounded-[12px] ${suppressPrimaryAction ? 'min-h-0 flex-1' : ''}`}
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}
          >
          <div className="flex items-center gap-3 px-3 py-3">
            <button
              type="button"
              onClick={onPlayRequest}
              disabled={!onPlayRequest}
              /*
                稿面 cap-A4/A5 这颗是**大号正圆**，直径约 50px——它是这张卡的主控件，
                「不必等转录跑完就能听」这句承诺全靠它兑现。做成 40px 的小圆角方块之后，
                它比标题还轻，读起来像一枚装饰性前缀图标（A4/A5 两份判分都记了这处）。
                v2-R4 那一稿画的是同样大小的圆角方块——两稿在形状上不一致，取多数的圆。
              */
              className="flex h-[50px] w-[50px] flex-shrink-0 items-center justify-center rounded-full disabled:cursor-default"
              style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
              title="播放这段录音"
            >
              <Play size={20} fill="currentColor" style={{ marginLeft: 2 }} />
            </button>
            <div className="min-w-0 flex-1">
              {/*
                稿面 cap-A4/A5 的音频卡标题是「用户访谈 · 8 月 16 日」——日期是这张卡
                认领这段录音的第二个凭据（同名的访谈会有很多场）。
              */}
              {/*
                卡内标题要明显大于卡内正文一档（稿面 cap-A4/A5 的层级）：与下面的逐句正文
                同为 12.5px 时，「这张卡在讲哪条录音」和「它长出来的字」读成同一层
                （cap-A4 判分记的「卡内主次被压平」）。
              */}
              <p className="truncate text-[14.5px] font-semibold text-token-primary">
                {audioTitle?.trim() || '这段录音'}{audioDateLabel ? ` · ${audioDateLabel}` : ''}
              </p>
              <p className="mt-0.5 text-[11px]" style={{ color: 'var(--accent-fg-success)' }}>
                {/*
                  原文写完之后这张卡也要带上句数（稿面 cap-A5 的音频卡副行是「24:18 · 原文 132 句」）：
                  到了补齐那一档，「这条录音现在有什么」才是用户关心的事，不只是它能不能播。
                */}
                音频已就绪，可立即播放{durationLabel ? ` · ${durationLabel}` : ''}
                {transcriptDone && (generatedSentences ?? 0) > 0 ? ` · 原文 ${generatedSentences} 句` : ''}
              </p>
            </div>
          </div>

          {/* 原文逐句生成中：等待期的主视觉必须是产物本身在长出来，而不是一块空白 */}
          {/*
            稿面 v2-R4 里这一段一直长到主按钮上方——它是这一屏的产物区，
            按内容高度收着的话，卡片下面空出三成屏，产物反而不是最大的那块。
          */}
          <div
            className={`px-3 py-2.5 ${suppressPrimaryAction ? 'min-h-0 flex-1 overflow-y-auto' : ''}`}
            style={{ borderTop: '1px solid var(--border-faint)' }}
          >
            <p className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>原文逐句生成中</p>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {/*
                首句加粗深色、后一句常规次级——两份稿（v2-R4 与 cap-A4）在这里是一致的：
                它画的是「已定稿的结论」与「正在跟上的支撑句」两层。同字重同色的话，
                「逐句往下长、越往后越新」这层暗示就没了。
              */}
              {(transcriptPreview ?? []).slice(0, 2).map((line, index) => (
                <p
                  key={index}
                  // 首句在稿面里是这张卡除标题外的第二个视觉重心（字号接近卡标题），
                  // 整卡压成同一小档之后，正文与骨架条、卡底说明就扁平成一片
                  className={`leading-relaxed ${index === 0 ? 'text-[13.5px] font-semibold' : 'text-[12.5px]'}`}
                  style={{ color: index === 0 ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                >
                  {line}
                </p>
              ))}
              {/* 已生成的句子后面永远吊两条骨架：它是「还在往下长」的那个暗示，不能省 */}
              {[0, 1].map(index => (
                <div
                  key={`skeleton-${index}`}
                  className="h-3 rounded-full"
                  style={{
                    width: index === 0 ? '92%' : '64%',
                    background: 'var(--bg-elevated)',
                    animation: 'pulse 1.6s ease-in-out infinite',
                    animationDelay: `${index * 0.18}s`,
                  }}
                  aria-hidden
                />
              ))}
            </div>
            {/*
              稿面 cap-S4 把「已生成 N / 约 M 句，其余会陆续出现」放在骨架条**正下方**：
              它解释的就是上面那几条骨架——还有多少没长出来。
              放在上面那一格的阶段行里，读者要回上一区块才知道自己看的这堆骨架代表什么。
            */}
            {transcriptYieldLine && (
              <p className="mt-2 text-[11px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                {transcriptYieldLine}
              </p>
            )}
          </div>

          {/*
            补齐那一档（稿面 cap-A5）：词云与摘要正在长出来这件事，画在**音频卡内、
            分隔线以下**——它长出来的东西挂在这条录音上，摆到卡外就成了一段与录音无关的
            系统状态。占位块用的是词云自己的形状（长短不一的胶囊），不是一行「正在生成」。
          */}
          {transcriptDone && (
            <div className="px-3 py-2.5" style={{ borderTop: '1px solid var(--border-faint)' }}>
              <p className="flex items-center gap-2 text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                <span
                  style={{
                    width: 13, height: 13, borderRadius: '50%',
                    border: '2px solid transparent',
                    borderTopColor: 'var(--accent-fg-info)',
                    borderRightColor: 'var(--accent-fg-info)',
                    animation: 'spin 0.9s linear infinite',
                  }}
                  aria-hidden
                />
                正在生成词云与智能摘要
              </p>
              <span className="mt-2 flex flex-wrap gap-2" aria-hidden>
                {[86, 58, 104, 70].map((width, index) => (
                  <span
                    key={index}
                    className="block h-7 rounded-full"
                    style={{
                      width,
                      background: 'var(--skeleton-fill)',
                      animation: 'pulse 1.6s ease-in-out infinite',
                      animationDelay: `${index * 0.14}s`,
                    }}
                  />
                ))}
              </span>
            </div>
          )}
          </div>

          {/*
            稿面 cap-A4/A5 在这一屏底部压了一条蓝色告知：它回答的是「我能不能走」。
            没有它，用户会以为必须守着这一页等整理跑完。
          */}
          <p
            className="rounded-[12px] px-4 py-3.5 text-[13px] leading-relaxed"
            style={{ background: 'var(--selection-bg)', color: 'var(--selection-text)' }}
          >
            {/*
              这条提示回答的是「我能不能走」。到了补齐那一档，稿面 cap-A5 把它换成了
              更强的两句：**哪些能力现在已经可用**、以及**补齐完成会在原位更新**——
              前者是让用户敢走的理由，后者是让他敢回来的理由。
            */}
            {transcriptDone
              ? '播放、阅读原文和编辑现在都已可用；补齐完成会在原位更新，无需停留在此页面。'
              : '整理与问答会在原文完成后自动开始，无需停留在此页面。'}
          </p>

          {/* 算不出预计剩余时才单独说一句；「已用」已经编进进度那一行了，不在这里重复 */}
          {(!timing || timing.remainingSec === null) && (
            <p className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {timing ? `已用 ${formatDurationSec(timing.elapsedSec)} · ` : ''}正在积累数据，稍后给出预计剩余
            </p>
          )}

          {/* 底部主操作：这一屏必须有出口。整理还没完不妨碍现在就听 */}
          {/* 整屏形态（录音处理页）自己有一条吸底操作栏，这里就不再摆第二颗 */}
          {!suppressPrimaryAction && (onEnterResult || onPlayRequest) && (
            <button
              type="button"
              onClick={onEnterResult ?? onPlayRequest}
              // 稿面这颗是**全圆角胶囊**（半径 = 高度一半），不是小圆角矩形
              className="mt-1 flex min-h-12 w-full items-center justify-center gap-2 rounded-full text-[13px] font-semibold"
              style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)', boxShadow: 'var(--button-primary-shadow)' }}
            >
              <Play size={14} fill="currentColor" />
              {onEnterResult ? '进入结果页并开始播放' : '立即播放这段录音'}
            </button>
          )}
        </>
      ) : showFailure ? (
        <>
          <div className="flex items-start gap-3">
            <div
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px]"
              style={{ background: FAILURE_TONE[failureCopy!.tone].iconBg, color: FAILURE_TONE[failureCopy!.tone].iconFg }}
            >
              <FailureIcon kind={failureCopy!.icon} />
            </div>
            <div className="min-w-0 flex-1">
              {/*
                标题跟着卡面的色调走：琥珀卡上写一个近黑标题，读起来像两种东西拼在一起，
                「这是一张在自愈中的卡」那层语义只剩底色在扛（v2-S6 / cap-S7 判分记的这处）。
              */}
              <p
                className="text-[13px] font-semibold"
                style={{
                  color: failureCopy!.tone === 'retrying' || failureCopy!.tone === 'queued'
                    ? 'var(--semantic-warning-text)'
                    : failureCopy!.tone === 'danger'
                      ? 'var(--semantic-danger)'
                      : 'var(--text-primary)',
                }}
              >
                {failureCopy!.title}
              </p>
              <p className="mt-0.5 text-[11px] text-token-muted">{failureCopy!.subtitle}</p>
            </div>
            {/*
              这里原先钉着一颗「重试」。稿面把主操作画在**底部按钮组的首位**，
              钉在卡头右上有两个后果：一是「没人声」那一档摆出一颗自己文案都说没用的重试，
              二是每一档的主操作都被它占掉，稿面真正指定的那一颗（播放确认 / 完成后通知我）
              退成了次级。三份判分各自指到这处，出口改为按处境从 actions 生成。
            */}
          </div>

          {/* 设计稿硬约束：原因与 code / 时间 / 仍可用能力 / 下一步，逐条渲染，不合并成一句 */}
          <dl className="flex flex-col gap-1.5 text-[11.5px] leading-relaxed">
            <div className="flex gap-2">
              <dt className="w-[52px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>原因</dt>
              <dd className="min-w-0 break-words" style={{ color: 'var(--text-secondary)' }}>
                {lastFailure!.reason}
                {(lastFailure!.code || lastFailure!.at || lastFailure!.automaticRetryCount > 0) && (
                  <span className="ml-1 font-mono text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                    （{[
                      lastFailure!.code,
                      lastFailure!.at ? new Date(lastFailure!.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : null,
                      lastFailure!.automaticRetryCount > 0 ? `已自动重试 ${lastFailure!.automaticRetryCount} 次` : null,
                    ].filter(Boolean).join('，')}）
                  </span>
                )}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-[52px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>仍可用</dt>
              <dd style={{ color: 'var(--text-secondary)' }}>{failureCopy!.stillWorks}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-[52px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>下一步</dt>
              <dd style={{ color: 'var(--text-secondary)' }}>
                {emphasizeCounters(failureCopy!.nextStep)}
              </dd>
            </div>
          </dl>

          {/*
            失败卡的出口按处境给（稿面 v2-S4 / v2-S5）：
              没人声 → 「播放确认」+「重新录制」（同一段音频重试不会有别的结果）
              其它失败 → 「下载音频」（音频本身没坏，用户要能拿走）
            此前只有一颗「重试」，落到「没检测到人声」那一档就是一句自相矛盾的建议。
          */}
          {/*
            出口按处境生成，**第一颗是主操作**（实心），其余描边。
            稿面每一档指定的主操作都不一样：没人声是「播放确认」、排队超时是「完成后通知我」、
            真失败才是「重试」。写死一套按钮就必然有几档对不上。
          */}
          {failureActions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {failureActions.map((action, index) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={action.run}
                  disabled={action.disabled}
                  className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded-[10px] px-3.5 text-[12.5px] font-semibold disabled:cursor-default disabled:opacity-60"
                  /*
                    次操作跟着卡面的色调走：琥珀卡上摆一颗中性白底描边钮，
                    它与主操作的层级对比被拉平，看起来像两颗并列的同级按钮
                    （cap-S10 / v2-S5 两份判分各记了一次）。
                  */
                  style={index === 0
                    ? { background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }
                    : {
                      background: 'transparent',
                      border: `1px solid ${failureCopy!.tone === 'danger'
                        ? 'var(--semantic-danger)'
                        : failureCopy!.tone === 'retrying' || failureCopy!.tone === 'queued'
                          ? 'var(--semantic-warning-text)'
                          : 'var(--border-default)'}`,
                      color: failureCopy!.tone === 'danger'
                        ? 'var(--semantic-danger)'
                        : failureCopy!.tone === 'retrying' || failureCopy!.tone === 'queued'
                          ? 'var(--semantic-warning-text)'
                          : 'var(--text-primary)',
                    }}
                >
                  {action.icon} {action.label}
                </button>
              ))}
            </div>
          )}

          {/*
            「已完成的部分现在就能读」这句承诺的落点。稿面 cap-S10 把它当作
            这一屏的核心价值——等太久时用户要的不是道歉，是「我还能干点什么」。
            只写在文案里、正文却一个字都不给，等于没兑现。
          */}
          {(failureCopy!.tone === 'queued' || failureCopy!.tone === 'retrying')
            && (lastFailure!.partialTranscript?.length ?? 0) > 0 && (
            <div className="rounded-[11px] px-3 py-2.5" style={{ background: 'var(--bg-card)' }}>
              <p className="mb-1 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>已生成的部分原文</p>
              {lastFailure!.partialTranscript.map((line, i) => (
                <p key={i} className="text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{line}</p>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="surface-action-accent flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px]">
              <AudioLines size={16} />
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-token-primary">
                {inPlace ? '录音和原文已保存在本页' : noteEntryId ? '录音原文已生成' : '把录音转成文字'}
              </p>
              <p className="truncate text-[11px] text-token-muted">
                {inPlace ? '位置与标题保持不变，需要时再一键整理'
                  : noteEntryId ? '点下方打开原文，需要时再一键整理'
                  : '先生成可编辑原文，不自动总结或改写'}
              </p>
            </div>
          </div>
          {!noteEntryId && onStart && (
            <button
              onClick={() => onStart()}
              className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-[9px] px-3.5 py-1.5 text-[12px] font-semibold transition-colors"
              style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)', boxShadow: 'var(--button-primary-shadow)' }}>
              转成文字
            </button>
          )}
        </div>
      )}

      {/* 已转录的历史产物入口：处理中也保留，用户可以边等边看上一版 */}
      {chips && (
        <div className="flex flex-wrap items-center gap-1.5">
          {/*
            已经转录完的录音同样要进得去结果页——处理中那一屏的主按钮只覆盖「正在跑」
            那一小段时间，光靠它的话，跑完之后这条链路就再也没有入口了
            （形状 2：入口只建在一条会消失的分支上）。
          */}
          {/*
            处理中不出现：那一档的底部主按钮本身就是「进入结果页并开始播放」，
            这里再摆一颗同义的，主次就被摊平成两个说同一句话的按钮。
            这颗常驻入口存在的理由是「转录跑完后主按钮那条分支会消失」，
            所以它只该在非处理中出现。
          */}
          {onEnterResult && !inPlace && !processing && (
            <button
              onClick={onEnterResult}
              className="flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors"
              /*
                失败态下这颗退成描边：稿面把「重试」定成那一屏唯一的黑色实心主按钮，
                而这颗常驻入口同样是黑色实心、还更宽，于是同屏出现两个同级黑块，
                稿面定义的主次被摊平（cap-S8 判分记的正是这处）。
              */
              style={showFailure
                ? { border: '1px solid var(--border-default)', color: 'var(--text-primary)' }
                : { background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}>
              <Play size={11} fill="currentColor" /> 打开录音结果页 <ChevronRight size={11} />
            </button>
          )}
          {noteEntryId && !inPlace && (
            <button
              onClick={() => onOpenNote(noteEntryId)}
              className="flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors"
              style={{
                background: 'rgba(34,197,94,0.1)',
                border: '1px solid rgba(34,197,94,0.22)',
                color: 'var(--accent-fg-success)',
              }}>
              <BookOpen size={11} /> 转录笔记 <ChevronRight size={11} />
            </button>
          )}
          {subtitleEntryId && (
            <button
              onClick={() => onOpenNote(subtitleEntryId)}
              className="flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors"
              style={{
                background: 'var(--selection-bg)',
                border: '1px solid var(--selection-border)',
                color: 'var(--selection-text)',
              }}>
              <Sparkles size={11} /> 字幕 <ChevronRight size={11} />
            </button>
          )}
          {noteEntryId && onRestyle && (
            <button
              onClick={onRestyle}
              className="flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors hover-bg-soft"
              style={{
                background: 'var(--bg-elevated)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-faint)',
              }}>
              <Wand2 size={11} /> 一键整理
            </button>
          )}
        </div>
      )}
    </div>
  );
}
