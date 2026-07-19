export const ACTIVE_UPDATE_STALE_AFTER_MS = 180_000;

export function activeUpdateStaleSeconds(
  lastTickMs: number | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (!Number.isFinite(lastTickMs)) return undefined;
  return Math.max(0, Math.floor((nowMs - (lastTickMs as number)) / 1000));
}

export function isActiveUpdateStalled(
  lastTickMs: number | undefined,
  nowMs = Date.now(),
): boolean {
  if (!Number.isFinite(lastTickMs)) return false;
  return nowMs - (lastTickMs as number) >= ACTIVE_UPDATE_STALE_AFTER_MS;
}
