import { describe, expect, it } from 'vitest';
import {
  directionLabel,
  shouldConfirmAutoDirection,
  statusText,
  syncRouteText,
} from '../SyncCenterDialog';

describe('SyncCenterDialog mental model', () => {
  it('treats received as an audit record, not a user sync direction', () => {
    expect(directionLabel('received')).toBe('接收审计');
    expect(shouldConfirmAutoDirection('received')).toBe(true);
    expect(syncRouteText('received', '正式环境')).toBe('最近只是接收过对端推送，尚未确认自动同步方向');
  });

  it('keeps user-confirmed directions explicit', () => {
    expect(shouldConfirmAutoDirection('push')).toBe(false);
    expect(shouldConfirmAutoDirection('pull')).toBe(false);
    expect(shouldConfirmAutoDirection('both')).toBe(false);
    expect(syncRouteText('push', '正式环境')).toBe('自动把本库发送到「正式环境」');
    expect(syncRouteText('pull', '正式环境')).toBe('自动从「正式环境」拉回本库');
    expect(syncRouteText('both', '正式环境')).toBe('自动与「正式环境」双向保持一致');
  });

  it('uses user language for skipped and incoming records', () => {
    expect(statusText({ status: 'skipped', origin: 'outgoing', startedAt: new Date().toISOString() })).toBe('两边已一致');
    expect(statusText({ status: 'synced', origin: 'incoming', startedAt: new Date().toISOString() })).toBe('已接收对端推送');
  });
});
