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
};

/**
 * 后端真实写入的进度刻度（`SubtitleGenerationProcessor.UpdateProgressAsync` 的调用点）：
 *   20 读取安全录音 / 下载素材 · 35 解析音频 / 提取音轨 · 40-70 转写 · 70 生成摘要 · 85-90 写入中 · 100 完成
 * 「生成原文」到 70 为止，之后是摘要与写入，归到「补齐录音理解」。
 */
const UNDERSTANDING_FROM = 70;

/** 音频在 run 开始之前就已经落库了——这一阶段永远是「已完成」，不是猜的。 */
function audioStage(): TranscriptionStage {
  return { key: 'audio', label: '保存音频', detail: '已安全保存，现在就可以播放', state: 'done', percent: null };
}

export function describeTranscriptionStages(
  run: { status?: string | null; phase?: string | null; progress?: number | null } | null | undefined,
): TranscriptionStage[] | null {
  const status = run?.status?.trim().toLowerCase();
  if (status !== 'queued' && status !== 'running' && status !== 'publishing') return null;

  const progress = Math.min(100, Math.max(0, run?.progress ?? 0));
  const phase = run?.phase?.trim() || '';
  const inUnderstanding = progress >= UNDERSTANDING_FROM;

  return [
    audioStage(),
    {
      key: 'transcript',
      label: '生成原文',
      // 阶段内百分比按该阶段自己的区间归一，否则「生成原文」会在整体 70% 时显示 70%，
      // 而它其实已经做完了——用户看到的进度必须是这一格的进度。
      detail: inUnderstanding ? '原文已生成' : (phase || '正在转写'),
      state: inUnderstanding ? 'done' : 'active',
      percent: inUnderstanding ? null : Math.round((progress / UNDERSTANDING_FROM) * 100),
    },
    {
      key: 'understanding',
      label: '补齐录音理解',
      detail: inUnderstanding ? (phase || '正在整理') : '词云、说话人、纪要 · 排队中',
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
