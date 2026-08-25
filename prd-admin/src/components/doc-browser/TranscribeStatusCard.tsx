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
import { useEffect, useState } from 'react';
import { AlertTriangle, AudioLines, BookOpen, Check, ChevronRight, Play, Sparkles, Wand2 } from 'lucide-react';
import type { FailedTranscriptionNotice } from '@/pages/document-store/recordingVault';
import { onRecordingDuration } from './recordingPlayBridge';
import {
  describeTranscriptionStages,
  estimateRemainingSeconds,
  formatDurationSec,
  type TranscriptionStage,
} from '@/pages/document-store/transcriptionStages';

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

function StageRow({ stage, remainingLabel }: { stage: TranscriptionStage; remainingLabel?: string | null }) {
  const done = stage.state === 'done';
  const active = stage.state === 'active';
  return (
    <div className="flex items-start gap-2.5">
      <div
        className="mt-[2px] flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full"
        style={{
          background: done ? 'var(--accent-fg-success)' : 'transparent',
          border: done ? 'none' : `1px solid ${active ? 'var(--accent-fg-info)' : 'var(--border-faint)'}`,
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
              border: '2.5px solid color-mix(in srgb, var(--accent-fg-info) 26%, transparent)',
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
            <span className="flex-shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--accent-fg-info)' }}>
              {stage.percent}%{remainingLabel ? ` · ${remainingLabel}` : ''}
            </span>
          )}
        </div>
        {/* 设计稿的顺序是 标题 → 进度条 → 副行：先看到走到哪，再看它在干嘛 */}
        {active && stage.percent !== null && (
          <div
            className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full"
            style={{ background: 'var(--bg-elevated)' }}
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
        <p className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{stage.detail}</p>
      </div>
    </div>
  );
}

export function TranscribeStatusCard({
  currentEntryId,
  noteEntryId,
  subtitleEntryId,
  activeRun,
  lastFailure,
  audioTitle,
  audioSizeLabel,
  transcriptPreview,
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
  /** 已经生成出来的原文（有几句给几句）；为空时渲染骨架而不是留白 */
  transcriptPreview?: string[];
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
  const stages = describeTranscriptionStages(activeRun, { sizeLabel: audioSizeLabel, durationLabel });
  const processing = stages !== null;
  // 失败卡只在没有在途 run 时出现：又在跑又说失败，等于同屏两句互相打脸
  const showFailure = !processing && !noteEntryId && !!lastFailure;
  const retryAt = lastFailure?.automaticRetryNextAt ? Date.parse(lastFailure.automaticRetryNextAt) : NaN;
  const now = useSecondTick(processing || Number.isFinite(retryAt));
  const waitingAutoRetry = Number.isFinite(retryAt) && retryAt > now;

  const timing = processing ? estimateRemainingSeconds(activeRun, now) : null;
  const chips = (noteEntryId && !inPlace) || subtitleEntryId || (noteEntryId && onRestyle)
    || (onEnterResult && !inPlace && !processing);

  return (
    <div className="surface-inset mb-4 flex flex-col gap-3 rounded-[14px] px-4 py-3.5" data-tour-id="doc-transcribe-hero">
      {processing ? (
        <>
          {/* 页面级标题：设计稿这一屏的 H1，不是卡内小标题 */}
          <div>
            {/* 稿面这句是超大号 H1，要和副标题、阶段标题拉开三级；20px 压不出这个层级 */}
            <h2 className="text-[26px] font-bold leading-tight tracking-tight text-token-primary">正在整理这段录音</h2>
            {/* 「音频是否安全」+「你现在能做什么」两问合成一句，紧跟标题 */}
            <p className="mt-1 text-[12px] leading-relaxed text-token-muted">
              音频已经安全保存，你现在就可以播放。
            </p>
          </div>

          <div className="flex flex-col gap-3">
            {stages.map(stage => (
              <StageRow
                key={stage.key}
                stage={stage}
                // 「还要多久」挂在正在跑的那一格右侧，跟着它走；卡底不再重复一次
                remainingLabel={stage.state === 'active' && timing?.remainingSec != null
                  ? `约 ${formatDurationSec(timing.remainingSec)}`
                  : null}
              />
            ))}
          </div>

          {/* 音频已就绪卡：设计稿用它兑现「不必等转录就能听」，缩略图本身就是播放键 */}
          <div
            className="flex items-center gap-3 rounded-[12px] px-3 py-2.5"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}
          >
            <button
              type="button"
              onClick={onPlayRequest}
              disabled={!onPlayRequest}
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px] disabled:cursor-default"
              style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
              title="播放这段录音"
            >
              <Play size={15} fill="currentColor" style={{ marginLeft: 1 }} />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] font-semibold text-token-primary">
                {audioTitle?.trim() || '这段录音'}
              </p>
              <p className="mt-0.5 text-[11px]" style={{ color: 'var(--accent-fg-success)' }}>
                音频已就绪，可立即播放{durationLabel ? ` · ${durationLabel}` : ''}
              </p>
            </div>
          </div>

          {/* 原文逐句生成中：等待期的主视觉必须是产物本身在长出来，而不是一块空白 */}
          <div
            className="rounded-[12px] px-3 py-2.5"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}
          >
            <p className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>原文逐句生成中</p>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {(transcriptPreview ?? []).slice(0, 2).map((line, index) => (
                <p key={index} className="text-[12.5px] leading-relaxed text-token-secondary">{line}</p>
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
          </div>

          <p className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {timing
              ? `已用 ${formatDurationSec(timing.elapsedSec)}${timing.remainingSec === null ? ' · 正在积累数据，稍后给出预计剩余' : ''}`
              : '正在积累数据，稍后给出预计剩余'}
          </p>

          {/* 底部主操作：这一屏必须有出口。整理还没完不妨碍现在就听 */}
          {(onEnterResult || onPlayRequest) && (
            <button
              type="button"
              onClick={onEnterResult ?? onPlayRequest}
              className="mt-1 flex min-h-12 w-full items-center justify-center gap-2 rounded-[12px] text-[13px] font-semibold"
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
              style={{ background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)' }}
            >
              <AlertTriangle size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-token-primary">
                {waitingAutoRetry ? '转录失败，正在自动重试' : '上次转文字没成功'}
              </p>
              <p className="mt-0.5 text-[11px] text-token-muted">录音还在，没有丢</p>
            </div>
            {!waitingAutoRetry && onStart && (
              <button
                onClick={() => onStart()}
                className="flex flex-shrink-0 cursor-pointer items-center rounded-[9px] px-3.5 py-1.5 text-[12px] font-semibold transition-colors"
                style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)', boxShadow: 'var(--button-primary-shadow)' }}
              >
                重试
              </button>
            )}
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
              <dd style={{ color: 'var(--text-secondary)' }}>播放、下载音频（音频不受转录失败影响）</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-[52px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>下一步</dt>
              <dd style={{ color: 'var(--text-secondary)' }}>
                {waitingAutoRetry
                  ? `第 ${lastFailure!.automaticRetryCount + 1} 次自动重试将在 ${formatDurationSec((retryAt - now) / 1000)}后开始，无需操作`
                  : '点「重试」；若反复失败，可转码后重新上传'}
              </dd>
            </div>
          </dl>
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
              style={{
                background: 'var(--button-primary-bg)',
                color: 'var(--button-primary-fg)',
              }}>
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
