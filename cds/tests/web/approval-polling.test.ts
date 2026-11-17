import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../web/src/lib/api.js';
import { canReadApproval, createApprovalPollingGate, nextUnseenApproval } from '../../web/src/hooks/approvalPolling.js';

describe('human approval polling', () => {
  it('verifies an unknown write outcome with a new GET after the pre-write snapshot has settled', async () => {
    let finishOld!: (value: string) => void;
    const oldRead = vi.fn(() => new Promise<string>(resolve => { finishOld = resolve; }));
    const freshRead = vi.fn(async () => 'completed-after-write');
    const gate = createApprovalPollingGate<string>();
    const old = gate.run(oldRead);
    await Promise.resolve();
    const verify = gate.runFresh(freshRead);
    expect(freshRead).not.toHaveBeenCalled();
    finishOld('pending-before-write');
    expect(await old).toEqual({ kind: 'ok', data: 'pending-before-write' });
    expect(await verify).toEqual({ kind: 'ok', data: 'completed-after-write' });
    expect(freshRead).toHaveBeenCalledTimes(1);
  });
  it('does not reopen a deferred request on heartbeat or late refresh, but keeps new requests discoverable', () => {
    const old = { id: 'old' }, fresh = { id: 'new' };
    const deferred = new Set(['old']);
    expect(nextUnseenApproval([old], deferred)).toBeUndefined();
    expect(nextUnseenApproval([old], deferred)).toBeUndefined();
    expect(nextUnseenApproval([old, fresh], deferred)).toEqual(fresh);
    expect(nextUnseenApproval([old, fresh], deferred, 'old')).toEqual(old);
    expect(nextUnseenApproval([fresh], deferred, 'old')).toEqual(fresh);
    expect(nextUnseenApproval([], deferred, 'old')).toBeUndefined();
  });
  it('requires an explicit server capability, including before authentication resolves', () => {
    expect(canReadApproval(undefined, 'operator')).toBe(false);
    expect(canReadApproval(undefined, 'accessRequests')).toBe(false);
    expect(canReadApproval({ operator: false, accessRequests: false }, 'operator')).toBe(false);
    expect(canReadApproval({ operator: false, accessRequests: true }, 'operator')).toBe(false);
    expect(canReadApproval({ operator: false, accessRequests: true }, 'accessRequests')).toBe(true);
    expect(canReadApproval({ operator: true, accessRequests: true }, 'operator')).toBe(true);
  });
  it('stops initial, heartbeat and reconnect refreshes after one forbidden response', async () => {
    const read = vi.fn().mockRejectedValue(new ApiError(403, { error: 'human_owner_required' }, 'Forbidden'));
    const gate = createApprovalPollingGate<unknown>();
    expect(await gate.run(read)).toEqual({ kind: 'forbidden' });
    for (let i = 0; i < 8; i++) expect(await gate.run(read)).toEqual({ kind: 'forbidden' });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('does not swallow authentication, server or network errors and permits a subsequent retry', async () => {
    for (const error of [new ApiError(401, {}, 'Login required'), new ApiError(500, {}, 'Database unavailable'), new TypeError('Network unavailable')]) {
      const gate = createApprovalPollingGate<{ pending: unknown[] }>();
      const read = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ pending: [] });
      await expect(gate.run(read)).rejects.toBe(error);
      expect(await gate.run(read)).toEqual({ kind: 'ok', data: { pending: [] } });
      expect(read).toHaveBeenCalledTimes(2);
    }
  });
  it('coalesces overlapping snapshots and continues to refresh successful owner requests', async () => {
    let resolve!: (value: number) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<number>(done => { resolve = done; })).mockResolvedValue(2);
    const gate = createApprovalPollingGate<number>();
    const first = gate.run(read); const concurrent = gate.run(read);
    await Promise.resolve(); resolve(1);
    expect(await first).toEqual({ kind: 'ok', data: 1 });
    expect(await concurrent).toEqual({ kind: 'ok', data: 1 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(await gate.run(read)).toEqual({ kind: 'ok', data: 2 });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
