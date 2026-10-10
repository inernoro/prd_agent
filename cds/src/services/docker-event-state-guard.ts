/** A lifecycle observation cannot rewrite an immutable successor instance. */
export function canApplyDockerLifecycleState(
  servingContainerId: string | undefined,
  event: { containerId?: string; stateSyncEligible?: boolean },
): boolean {
  if (event.stateSyncEligible === false) return false;
  // Legacy services without IDs remain compatible, but do not gain an identity proof.
  if (servingContainerId === undefined) return true;
  return /^[a-f0-9]{64}$/.test(servingContainerId) && servingContainerId === event.containerId;
}

/** JSON numbers lose nanoseconds at Docker's current timestamp magnitude. */
export function parseDockerEvent(line: string): { event: any; timeNs?: bigint } {
  const exactNanos = new WeakMap<object, string>();
  const event = JSON.parse(line, function (this: object, key: string, value: unknown, context?: { source?: string }) {
    if (key === 'timeNano' && typeof value === 'number' && context?.source) exactNanos.set(this, context.source);
    return value;
  });
  if (!event || typeof event !== 'object') return { event };
  const rawNano = exactNanos.get(event) ?? (typeof event.timeNano === 'string' ? event.timeNano
    : Number.isSafeInteger(event.timeNano) ? String(event.timeNano) : undefined);
  if (rawNano && /^(?:0|[1-9][0-9]{0,19})$/.test(rawNano)) {
    const timeNs = BigInt(rawNano);
    if (timeNs > 18446744073709551615n) return { event };
    if (event.time !== undefined && (!Number.isSafeInteger(event.time) || BigInt(event.time) !== timeNs / 1000000000n)) return { event };
    return { event, timeNs };
  }
  // Never infer ordering from a rounded or malformed declared nanosecond timestamp.
  if (event.timeNano === undefined && Number.isSafeInteger(event.time) && event.time >= 0) {
    const timeNs = BigInt(event.time) * 1000000000n;
    return timeNs <= 18446744073709551615n ? { event, timeNs } : { event };
  }
  return { event };
}
