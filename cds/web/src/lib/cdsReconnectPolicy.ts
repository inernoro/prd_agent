export const QUICK_RECONNECT_DELAYS_MS = [5_000, 10_000, 20_000] as const;
export const STEADY_RECONNECT_DELAY_MS = 60_000;
const RECONNECT_JITTER_RATIO = 0.15;

/**
 * CDS 断线后的持续恢复策略。
 *
 * 前三次快速重试用于覆盖短暂重启；之后每分钟继续探测，不能因为三次失败就永久
 * 停止。轻微抖动避免多个浏览器标签同时冲击刚恢复的服务。
 */
export function reconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const base = QUICK_RECONNECT_DELAYS_MS[normalizedAttempt - 1]
    ?? STEADY_RECONNECT_DELAY_MS;
  const randomValue = Math.max(0, Math.min(1, random()));
  const jitter = 1 + (randomValue * 2 - 1) * RECONNECT_JITTER_RATIO;
  return Math.max(1_000, Math.round(base * jitter));
}

export function reconnectRemainingSeconds(
  nextReconnectAt: string | null | undefined,
  nowMs = Date.now(),
): number | null {
  if (!nextReconnectAt) return null;
  const nextMs = Date.parse(nextReconnectAt);
  if (!Number.isFinite(nextMs)) return null;
  return Math.max(0, Math.ceil((nextMs - nowMs) / 1_000));
}
