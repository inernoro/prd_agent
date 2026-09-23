/** 业务监控（含 CDS 自监控）的通知节奏；状态随目标台账持久化，重启不重置冷却期。 */
export interface SelfMonitorAlarmState {
  lastDownAttemptAt?: number;
  healthySince?: number;
  lastObservedAt?: number;
  acceptedChannels?: string[];
  open?: boolean;
}
export const SELF_ALARM_COOLDOWN_MS = 30 * 60_000;
export const SELF_ALARM_RECOVERY_MS = 10 * 60_000;
export function decideSelfMonitorAlarm(
  state: SelfMonitorAlarmState,
  input: { at: number; up: boolean; noData?: boolean; down: boolean; intervalMs: number },
): { emit?: 'down' | 'recovered'; reason?: string } {
  const previousAt = state.lastObservedAt;
  state.lastObservedAt = input.at;
  if (input.noData || !input.up) state.healthySince = undefined;
  if (input.noData) return { reason: 'no-data' };
  if (input.down && !input.up) {
    if (state.open) return { reason: 'same-incident' };
    if (state.lastDownAttemptAt !== undefined && input.at - state.lastDownAttemptAt < SELF_ALARM_COOLDOWN_MS) return { reason: 'cooldown-30m' };
    state.open = true;
    state.lastDownAttemptAt = input.at;
    state.acceptedChannels = [];
    return { emit: 'down' };
  }
  if (!input.up || !state.open) return previousAt === undefined && input.up ? { reason: 'initial-healthy' } : {};
  // 停机/采样中断不能充当持续健康的证据。
  if (previousAt === undefined || input.at - previousAt > Math.max(input.intervalMs * 1.5, 60_000)) state.healthySince = undefined;
  state.healthySince ??= input.at;
  if (input.at - state.healthySince < SELF_ALARM_RECOVERY_MS) return { reason: 'recovery-stabilizing-10m' };
  state.open = false;
  state.healthySince = undefined;
  if (!state.acceptedChannels?.length) return { reason: 'no-delivered-down' };
  return { emit: 'recovered' };
}
