/**
 * 发布中心「已耗时 / 预计还需」的判定与文案 SSOT（纯函数，可单测）。
 *
 * 为什么算在前端：中位耗时是后端下发的静态值，但倒计时必须每秒走动——发布进行中
 * 相邻两次 SSE 状态事件之间可能几分钟没有一条，静止的秒数会让用户以为页面卡死。
 * 后端推不动每秒一帧，所以「median − elapsed」这一步只能在这里做。
 *
 * 为什么单独成文件而不是写在页面里：页面里已经有过一轮「同一判定抄两份、改了一处
 * 忘另一处」的账（见 tests/services/release-step-source-guard.test.ts 的事故值），
 * ETA 判定从第一天就只留一处，由 duration-samples-drift 守卫钉住。
 *
 * 与后端 src/services/wait-timing.ts 语义刻意保持一致（无样本一律 null、remaining
 * 下限 clamp 到 0）。两者物理上无法共用一份代码：web 的 tsconfig 只 include web/src，
 * 全仓没有 web → src 的 import 通道。这是编译边界，不是漏抽。
 */

export interface ReleaseEtaEstimate {
  /** 历史中位发布耗时（毫秒）；无样本时 null。 */
  medianMs: number | null;
  /** 参与中位计算的样本数，UI 文案的「近 N 次」。 */
  sampleCount: number;
}

export interface ReleaseEta {
  /** 已耗时毫秒（clamp >= 0）。startedAt 不可解析时为 null。 */
  elapsedMs: number | null;
  /** 预计还需毫秒 = max(0, median - elapsed)；无样本时 null。 */
  remainingMs: number | null;
  /** 已超出中位的毫秒数；未超出或无样本时 null。 */
  overdueMs: number | null;
  sampleCount: number;
}

/**
 * 纯计算。无样本时 remainingMs 一律 null（不是 0）——
 * 事故值：返回 0 会渲染出「预计还需 00:00」，那是凭空编造且必然落空的承诺。
 */
export function computeReleaseEta(
  startedAt: string | undefined,
  estimate: ReleaseEtaEstimate | undefined,
  nowMs: number,
): ReleaseEta {
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : null;
  const hasSamples = Boolean(estimate && estimate.sampleCount > 0 && estimate.medianMs != null);
  const medianMs = hasSamples ? (estimate!.medianMs as number) : null;
  if (medianMs == null || elapsedMs == null) {
    return { elapsedMs, remainingMs: null, overdueMs: null, sampleCount: estimate?.sampleCount || 0 };
  }
  const diff = medianMs - elapsedMs;
  return {
    elapsedMs,
    remainingMs: Math.max(0, diff),
    overdueMs: diff < 0 ? -diff : null,
    sampleCount: estimate!.sampleCount,
  };
}

/** 毫秒 → MM:SS（超过一小时给 H:MM:SS）。 */
export function formatEtaClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * 发布进行中的一行状态文案。
 *
 * 样本不足时给「正在积累历史耗时数据」而不是省略整行：已耗时的秒数每秒在走，
 * 用户至少知道系统还活着、等了多久——静止的「加载中」才是缺陷。
 */
export function releaseEtaText(
  startedAt: string | undefined,
  estimate: ReleaseEtaEstimate | undefined,
  nowMs: number,
): string {
  const eta = computeReleaseEta(startedAt, estimate, nowMs);
  if (eta.elapsedMs == null) return '';
  const elapsed = `已耗时 ${formatEtaClock(eta.elapsedMs)}`;
  if (eta.remainingMs == null) return `${elapsed} · 正在积累历史耗时数据，暂无预计`;
  const window = `近 ${eta.sampleCount} 次中位`;
  if (eta.overdueMs != null) return `${elapsed} · 已比${window}慢 ${formatEtaClock(eta.overdueMs)}`;
  return `${elapsed} · 预计还需 ${formatEtaClock(eta.remainingMs)}（${window}）`;
}
