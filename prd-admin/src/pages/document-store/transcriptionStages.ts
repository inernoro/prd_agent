/**
 * 录音处理中的三阶段视图（纯函数，单测覆盖）。
 *
 * 对齐设计稿 R4「结束处理三阶段」与它的硬约束：状态永远回答四句——
 * 音频是否安全 / 现在在做什么 / 还要多久 / 你现在能做什么。
 *
 * 判据只吃 `progress` 这个**数值**，不吃 `phase` 文案。
 * 后端的 phase 是给人看的自由文本（「读取安全录音」「解析音频」「生成摘要」「写入中」…），
 * 改一次文案就会让字符串判据静默失灵；progress 是同一处 UpdateProgressAsync 一起写的数值，
 * 稳定得多。phase 只用来当「现在在做什么」那一行的原话，不参与任何分支。
 */

export type TranscriptionStageKey = 'audio' | 'transcript' | 'understanding';
export type TranscriptionStageState = 'done' | 'active' | 'pending';

export type TranscriptionStage = {
  key: TranscriptionStageKey;
  label: string;
  detail: string;
  state: TranscriptionStageState;
  /** 仅 active 阶段有值：该阶段自身的完成度（0-100） */
  percent: number | null;
  /** 副行下面还有一行产出计数（「已生成 84 / 约 132 句」）；没有就是 null */
  yieldLine?: string | null;
};

/**
 * 后端真实写入的进度刻度（`SubtitleGenerationProcessor.UpdateProgressAsync` 的调用点）：
 *   20 读取安全录音 / 下载素材 · 35 解析音频 / 提取音轨 · 40-70 转写 · 70 生成摘要 · 85-90 写入中 · 100 完成
 * 「生成原文」到 70 为止，之后是摘要与写入，归到「补齐录音理解」。
 */
const UNDERSTANDING_FROM = 70;

/**
 * 音频在 run 开始之前就已经落库了——这一阶段永远是「已完成」，不是猜的。
 * 设计稿在这一行还要求带上「时长 · 体积 · 耗时」。时长与体积拿得到就带上，
 * 拿不到就只说结论——**不许为了凑齐稿面那一行去编一个体积出来**。
 * 单阶段耗时后端目前不下发，已列入给设计方的待补清单。
 */
function audioStage(meta?: {
  durationLabel?: string | null;
  sizeLabel?: string | null;
  elapsedLabel?: string | null;
}): TranscriptionStage {
  const facts = [meta?.durationLabel, meta?.sizeLabel, meta?.elapsedLabel].filter(Boolean);
  return {
    key: 'audio',
    label: '保存音频',
    detail: facts.length > 0 ? `${facts.join(' · ')} · 已安全保存` : '已安全保存，现在就可以播放',
    state: 'done',
    percent: null,
  };
}

export function describeTranscriptionStages(
  run: { status?: string | null; phase?: string | null; progress?: number | null } | null | undefined,
  audioMeta?: {
    durationLabel?: string | null;
    sizeLabel?: string | null;
    /** 「保存音频」那一格的耗时（describeAudioStageElapsed 算出来的） */
    elapsedLabel?: string | null;
    /** 已经吐出来的句数——用来给「生成原文」那一格算产出计数 */
    generatedSentences?: number;
  },
): TranscriptionStage[] | null {
  const status = run?.status?.trim().toLowerCase();
  if (status !== 'queued' && status !== 'running' && status !== 'publishing') return null;

  const progress = Math.min(100, Math.max(0, run?.progress ?? 0));
  const phase = run?.phase?.trim() || '';
  const inUnderstanding = progress >= UNDERSTANDING_FROM;

  return [
    audioStage(audioMeta),
    {
      key: 'transcript',
      label: '生成原文',
      // 阶段内百分比按该阶段自己的区间归一，否则「生成原文」会在整体 70% 时显示 70%，
      // 而它其实已经做完了——用户看到的进度必须是这一格的进度。
      /*
        写完之后这一格也要带着**它产出了多少**（稿面 cap-A5 在这一格画的是「48s · 132 句」）。
        只写「原文已生成」的话，三阶段里唯有它没有任何度量，读者不知道这一步到底产出了什么。
        耗时后端不下发，所以只给句数——给得出的给，给不出的不编。
      */
      detail: inUnderstanding
        ? ((audioMeta?.generatedSentences ?? 0) > 0 ? `原文已生成 · ${audioMeta?.generatedSentences} 句` : '原文已生成')
        : (phase || '正在转写'),
      state: inUnderstanding ? 'done' : 'active',
      percent: inUnderstanding ? null : Math.round((progress / UNDERSTANDING_FROM) * 100),
      yieldLine: inUnderstanding
        ? null
        : describeTranscriptYield(
          audioMeta?.generatedSentences ?? 0,
          Math.round((progress / UNDERSTANDING_FROM) * 100),
        ),
    },
    {
      key: 'understanding',
      label: '补齐录音理解',
      detail: inUnderstanding ? (phase || '正在整理') : '词云、纪要、待办 · 排队中',
      state: inUnderstanding ? 'active' : 'pending',
      percent: inUnderstanding
        ? Math.round(((progress - UNDERSTANDING_FROM) / (100 - UNDERSTANDING_FROM)) * 100)
        : null,
    },
  ];
}

/**
 * 「还要多久」。后端不给 ETA，这里按**已经跑过的真实耗时**线性外推：
 * 剩余 ≈ 已用 × (100 - p) / p。这不是拍脑袋的常数，是这一次运行自己的速度。
 *
 * 返回 null 的三种情况都必须由 UI 如实说「正在积累数据」，不许编一个数字出来
 * （no-rootless-tree.md）：还没开跑、进度为 0（除不了）、时钟异常导致已用为负。
 */
export function estimateRemainingSeconds(
  run: { progress?: number | null; startedAt?: string | null; createdAt?: string | null } | null | undefined,
  now: number = Date.now(),
): { elapsedSec: number; remainingSec: number | null } | null {
  const startedRaw = run?.startedAt ?? run?.createdAt ?? null;
  if (!startedRaw) return null;
  const started = new Date(startedRaw).getTime();
  if (Number.isNaN(started)) return null;
  const elapsedSec = Math.floor((now - started) / 1000);
  if (elapsedSec < 0) return null;

  const progress = Math.min(100, Math.max(0, run?.progress ?? 0));
  // 进度 0 时分母为 0；刚起步的几秒外推出来的数字也毫无意义，一律不给。
  if (progress <= 0 || elapsedSec < 3) return { elapsedSec, remainingSec: null };
  if (progress >= 100) return { elapsedSec, remainingSec: 0 };
  return { elapsedSec, remainingSec: Math.round(elapsedSec * (100 - progress) / progress) };
}

/** 把秒读成人话：低于一分钟给秒，否则给「X 分 Y 秒」——不给「0 小时」那种噪音。 */
export function formatDurationSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m} 分钟` : `${m} 分 ${rest} 秒`;
}

/**
 * 「保存音频」那一格的耗时（设计稿 R4 / cap-A4 都写了「耗时 1.2s」）。
 *
 * 取的是 run 被创建到真正开跑之间的那段——音频在 run 开始前就已经落库，
 * 这段时间正是「把音频存好」花掉的。拿不到任一端就不说，不编一个 1.2s 出来。
 */
export function describeAudioStageElapsed(
  run: { createdAt?: string | null; startedAt?: string | null } | null | undefined,
): string | null {
  const created = run?.createdAt ? new Date(run.createdAt).getTime() : NaN;
  const started = run?.startedAt ? new Date(run.startedAt).getTime() : NaN;
  if (!Number.isFinite(created) || !Number.isFinite(started)) return null;
  const sec = (started - created) / 1000;
  if (sec < 0 || sec > 3600) return null;
  return sec < 10 ? `耗时 ${sec.toFixed(1)}s` : `耗时 ${formatDurationSec(sec)}`;
}

/**
 * 「已生成 84 / 约 132 句」（设计稿 R4 / cap-S4）。
 *
 * 后端不下发总句数，所以分母只能外推：这一格跑到 p%，已经吐出 n 句，
 * 那么总数 ≈ n × 100 / p。这是**这一次运行自己的速度**算出来的，不是常数。
 * 进度太小时外推会得到荒唐的数（跑到 1% 出 1 句就推成 100 句），所以低于阈值
 * 只说已生成多少，不给分母——宁可少说一半，也不给一个假的总数。
 */
export const TRANSCRIPT_YIELD_MIN_PERCENT = 12;

export function describeTranscriptYield(
  generatedSentences: number,
  stagePercent: number | null,
): string | null {
  if (generatedSentences <= 0) return null;
  if (stagePercent == null || stagePercent < TRANSCRIPT_YIELD_MIN_PERCENT) {
    return `已生成 ${generatedSentences} 句`;
  }
  const total = Math.round((generatedSentences * 100) / Math.min(100, stagePercent));
  if (total <= generatedSentences) return `已生成 ${generatedSentences} 句`;
  return `已生成 ${generatedSentences} / 约 ${total} 句，其余会陆续出现`;
}
