import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../web/src/lib/api.js';
import { canReadApproval, createApprovalPollingGate } from '../../web/src/hooks/approvalPolling.js';

describe('human approval polling', () => {
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
