/**
 * 预览等待页的"已等待 / 预计还需"时间计算（纯函数 SSOT）。
 *
 * 病根（2026-06-20）：访客访问还在构建的分支预览域名时，等待页进度条停在
 * 93-94% 很久却没有任何具体时间，用户答应别人"3 分钟"却无法在页面上给出
 * 准确预计。Task 4 已建了部署耗时中位台账（deployDurationSamples），这里把它
 * 接到等待页：算出 elapsed + remaining，让 serveWaitingStatus 把结果随
 * /_cds/waiting-status 一起下发，等待页渲染"已等待 MM:SS · 预计还需约 MM:SS"。
 *
 * compute-then-send：本文件只做"算"（纯函数、可单测），不发任何 HTTP、不读 DB。
 * no-rootless-tree：无历史样本时 estimateMedianMs / remainingMs 一律 null，
 * 调用方据此显示"正在积累历史耗时数据，暂无预计"，绝不编造预计值。
 */

export interface WaitTimingInput {
  /** 当前分支/服务状态（building / starting / restarting ...）。 */
  status: string;
  /** 本次 deploy/build 真实开始的毫秒时间戳；取不到时为 null。 */
  deployStartedAtMs: number | null;
  /** 当前时间（毫秒）。注入便于单测。 */
  nowMs: number;
  /** 选中模式（release/source）的历史中位耗时 + 样本数。 */
  estimate: { medianMs: number | null; samples: number };
}

export interface WaitTiming {
  /** 已等待毫秒数（clamp >= 0）。无 deployStartedAt 时为 0。 */
  elapsedMs: number;
  /** 历史中位耗时（毫秒）；无样本时 null。 */
  estimateMedianMs: number | null;
  /** 参与中位计算的样本数。 */
  estimateSamples: number;
  /** 预计还需毫秒数 = max(0, median - elapsed)；无样本时 null。 */
  remainingMs: number | null;
  /** 本次已超过历史中位（构建比平时慢）。无样本时 false。 */
  overdue: boolean;
}

/**
 * 纯计算：给定状态 + deploy 起始时间 + 历史中位，算出已等待 / 预计还需 / 是否超时。
 *
 * 规则：
 *  - samples === 0 → estimateMedianMs / remainingMs = null（不编造）
 *  - elapsedMs = max(0, now - deployStartedAt)，deployStartedAt 为 null 时取 0
 *  - remainingMs = max(0, median - elapsed)（clamp 下限 0）
 *  - overdue = median != null && elapsed > median
 */
export function computeWaitTiming(input: WaitTimingInput): WaitTiming {
  const { deployStartedAtMs, nowMs, estimate } = input;

  const elapsedMs =
    deployStartedAtMs != null && Number.isFinite(deployStartedAtMs)
      ? Math.max(0, nowMs - deployStartedAtMs)
      : 0;

  const hasSamples = estimate.samples > 0 && estimate.medianMs != null;
  const estimateMedianMs = hasSamples ? estimate.medianMs : null;
  const remainingMs =
    estimateMedianMs != null ? Math.max(0, estimateMedianMs - elapsedMs) : null;
  const overdue = estimateMedianMs != null && elapsedMs > estimateMedianMs;

  return {
    elapsedMs,
    estimateMedianMs,
    estimateSamples: estimate.samples,
    remainingMs,
    overdue,
  };
}

/** 毫秒 → MM:SS（或 H:MM:SS 当 >= 1 小时），用于等待页文案。 */
export function formatWaitClock(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
