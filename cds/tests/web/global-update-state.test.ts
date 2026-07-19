import { describe, expect, it } from 'vitest';
import {
  ACTIVE_UPDATE_STALE_AFTER_MS,
  activeUpdateStaleSeconds,
  isActiveUpdateStalled,
} from '../../web/src/components/global-update-state.js';

describe('global update stale-state circuit breaker', () => {
  it('180 秒以内仍视为活动更新', () => {
    const now = Date.parse('2026-07-20T00:03:00.000Z');
    const lastTick = now - ACTIVE_UPDATE_STALE_AFTER_MS + 1;

    expect(isActiveUpdateStalled(lastTick, now)).toBe(false);
    expect(activeUpdateStaleSeconds(lastTick, now)).toBe(179);
  });

  it('达到 180 秒后进入失联态', () => {
    const now = Date.parse('2026-07-20T00:03:00.000Z');
    const lastTick = now - ACTIVE_UPDATE_STALE_AFTER_MS;

    expect(isActiveUpdateStalled(lastTick, now)).toBe(true);
    expect(activeUpdateStaleSeconds(lastTick, now)).toBe(180);
  });

  it('缺少合法心跳时间时不误判为失联', () => {
    expect(isActiveUpdateStalled(undefined)).toBe(false);
    expect(isActiveUpdateStalled(Number.NaN)).toBe(false);
    expect(activeUpdateStaleSeconds(undefined)).toBeUndefined();
  });
});
