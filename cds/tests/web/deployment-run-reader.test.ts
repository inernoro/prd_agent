import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentRunReader } from '../../web/src/lib/deployment-run-reader.js';

function row(id = 'dr_owned', extra = {}) {
  return { id, projectId: 'p', branchId: 'b', status: 'running', trigger: 'manual',
    phase: 'running', updatedAt: '2026-10-11T00:00:00Z', eventCount: 1, ...extra };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());
describe('bounded deployment ledger reader', () => {
  it('joins initial/manual reads and does not accumulate polls during a slow request', async () => {
    vi.useFakeTimers();
    const pending = deferred<unknown>(), request = vi.fn(() => pending.promise), changed = vi.fn();
    const reader = createDeploymentRunReader({ projectId: 'p', branchId: 'b', request, onChange: changed });
    const first = reader.refresh(), manual = reader.refresh();
    reader.setPolling(true);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(request).toHaveBeenCalledTimes(1); expect(first).toBe(manual);
    pending.resolve({ runs: [row()] }); await first;
    await vi.advanceTimersByTimeAsync(1_999); expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(2);
    reader.dispose();
  });
  it('retains the last good rows on errors and malformed or cross-project responses', async () => {
    const request = vi.fn().mockResolvedValueOnce({ runs: [row()] }).mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce({ runs: [row('other', { projectId: 'other' })] })
      .mockResolvedValueOnce({ runs: [row(42 as any)] }).mockResolvedValueOnce({ runs: [] });
    const changed = vi.fn(), reader = createDeploymentRunReader({ projectId: 'p', branchId: 'b', request, onChange: changed });
    await reader.refresh();
    for (let i = 0; i < 3; i++) {
      await reader.refresh(); expect(changed.mock.lastCall?.[0]).toEqual({ runs: [row()], unavailable: true });
    }
    await reader.refresh(); expect(changed.mock.lastCall?.[0]).toEqual({ runs: [], unavailable: false });
    reader.dispose();
  });
  it('ends a hung read at 30 seconds and rejects its later completion after a successor', async () => {
    vi.useFakeTimers();
    const hung = deferred<unknown>(), changed = vi.fn();
    const request = vi.fn().mockImplementationOnce(() => hung.promise).mockResolvedValue({ runs: [row('new')] });
    const reader = createDeploymentRunReader({ projectId: 'p', branchId: 'b', request, onChange: changed });
    const first = reader.refresh(); await vi.advanceTimersByTimeAsync(30_000); await first;
    expect(request.mock.calls[0][0].aborted).toBe(true);
    expect(changed.mock.lastCall?.[0]).toEqual({ runs: [], unavailable: true });
    await reader.refresh(); hung.resolve({ runs: [row('late')] }); await Promise.resolve(); await Promise.resolve();
    expect(changed.mock.lastCall?.[0]).toEqual({ runs: [row('new')], unavailable: false });
    reader.dispose();
  });
  it('aborts a poll when leaving its tab, with no late success/error or further timer', async () => {
    vi.useFakeTimers();
    const pending = deferred<unknown>(), changed = vi.fn(), request = vi.fn(() => pending.promise);
    const reader = createDeploymentRunReader({ projectId: 'p', branchId: 'b', request, onChange: changed });
    reader.setPolling(true); await vi.advanceTimersByTimeAsync(2_000);
    reader.setPolling(false); expect(request.mock.calls[0][0].aborted).toBe(true);
    pending.reject(new Error('late error')); await vi.advanceTimersByTimeAsync(20_000);
    expect(changed).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(1);
    reader.dispose();
  });
  it('disposes a closed session even if transport ignores abort and a new session uses the same IDs', async () => {
    const pending = deferred<unknown>(), oldChanged = vi.fn(), newChanged = vi.fn();
    const old = createDeploymentRunReader({ projectId: 'p', branchId: 'b', request: () => pending.promise, onChange: oldChanged });
    const read = old.refresh(); await Promise.resolve(); old.dispose(); await read;
    const next = createDeploymentRunReader({ projectId: 'p', branchId: 'b', request: async () => ({ runs: [row('new')] }), onChange: newChanged });
    await next.refresh(); pending.resolve({ runs: [row('old')] }); await Promise.resolve(); await Promise.resolve();
    expect(oldChanged).not.toHaveBeenCalled(); expect(newChanged.mock.lastCall?.[0].runs[0].id).toBe('new');
    await old.refresh(); old.setPolling(true); expect(oldChanged).not.toHaveBeenCalled(); next.dispose();
  });
});
