import type { DeployDurationEstimate } from '../types.js';

/**
 * 耗时样本台账的纯计算 SSOT：怎么追加一条样本、怎么算 p50、窗口取多少。
 *
 * 为什么单独立一个文件：系统里现在有两份互不相干的耗时台账 ——
 * 分支部署耗时（deployDurationSamples，按 projectId+mode 分桶）与生产发布耗时
 * （releaseDurationSamples，按 targetId 分桶）。两份台账的「口径」必须完全一致，
 * 但它们的存储位置、分桶键、采样时机都不一样。第二份台账落地时若照抄一遍
 * state.ts 里的排序取中位算式，下一次调窗口/上限就只会改到一边 —— 本 PR 前七轮
 * review 反复栽在「同一判定改了一边忘了另一边」上，所以判定只留这一处，
 * 由 tests/services/duration-samples-drift.test.ts 守住不再分裂。
 *
 * compute-then-send：本文件不读 state、不落盘、不发任何 IO，只做算。
 */

/** 每个桶最多保留的样本数（ring buffer 上限）。 */
export const DURATION_SAMPLES_MAX = 30;

/** 中位估算只看最近 N 条，UI 文案的「近 N 次」就是这个窗口。 */
export const DURATION_ESTIMATE_WINDOW = 20;

export interface DurationSampleLimits {
  /** ring buffer 上限。 */
  max: number;
  /**
   * 合理耗时上界。超过它的样本一律丢弃。
   *
   * 存在的理由不是洁癖：一条被外部因素挂住直到执行超时才收尾的记录，会把中位
   * 一次性抬到十几分钟，之后每个用户看到的「预计还需」都是错的，而且要靠后面
   * 十几次正常样本才能压回来。宁可少一条样本，也不要一条毒样本。
   */
  maxReasonableMs: number;
}

/**
 * 追加一条样本，返回新桶；样本非法时返回 null（调用方据此跳过落盘）。
 *
 * 返回新数组而不是原地改：调用方拿到 null 就知道「什么都没发生」，不会出现
 * 「以为写进去了其实被静默丢弃」的中间态。
 */
export function appendDurationSample(
  bucket: readonly number[] | undefined,
  ms: number,
  limits: DurationSampleLimits,
): number[] | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const { maxReasonableMs } = limits;
  if (Number.isFinite(maxReasonableMs) && maxReasonableMs > 0 && ms > maxReasonableMs) return null;
  const max = Number.isFinite(limits.max) && limits.max > 0 ? Math.floor(limits.max) : DURATION_SAMPLES_MAX;
  const next = [...(bucket || []), Math.round(ms)];
  while (next.length > max) next.shift();
  return next;
}

/**
 * 近 window 条样本的 p50 + 参与样本数。
 *
 * 无样本时 medianMs = null（不是 0）—— no-rootless-tree：调用方据此显示
 * 「正在积累历史数据」。事故值：返回 0 会让 UI 渲染出「预计还需 00:00」，
 * 那是一个凭空编造且必然落空的承诺。
 */
export function computeDurationEstimate(
  samples: readonly number[] | undefined,
  window: number,
): DeployDurationEstimate {
  const size = Number.isFinite(window) && window > 0 ? Math.floor(window) : DURATION_ESTIMATE_WINDOW;
  const recent = (samples || []).slice(-size);
  if (recent.length === 0) return { medianMs: null, sampleCount: 0 };
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return { medianMs, sampleCount: recent.length };
}
