import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireBuildSlot, buildGateStatus, __resetBuildGateForTest,
  setBuildGateHostLoadProvider } from '../../src/services/build-gate.js';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => {
  __resetBuildGateForTest();
  vi.stubEnv('CDS_MAX_CONCURRENT_BUILDS', '1');
  setBuildGateHostLoadProvider(() => ({ load1: 0, cores: 8 }));
});
afterEach(() => { __resetBuildGateForTest(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('source exceptions bounded project queue', () => {
  it('rotates projects while preserving order inside each project instead of consuming a flood first', async () => {
    const slots: any[] = [await acquireBuildSlot({ holder: { projectId: 'a' } } as any)];
    const abort = new AbortController(); const order: string[] = [];
    const queued = (label: string, projectId: string) => acquireBuildSlot({ holder: { projectId }, signal: abort.signal } as any)
      .then(slot => { slots.push(slot); order.push(label); return slot; });
    const jobs = [queued('a1', 'a'), queued('a2', 'a'), queued('b1', 'b'), queued('b2', 'b')];
    const settled = Promise.allSettled(jobs);
    try {
      slots[0].release(); await tick(); expect(order).toEqual(['b1']);
      slots[1].release(); await tick(); expect(order).toEqual(['b1', 'a1']);
      slots[2].release(); await tick(); expect(order).toEqual(['b1', 'a1', 'b2']);
      slots[3].release(); await tick(); expect(order).toEqual(['b1', 'a1', 'b2', 'a2']);
    } finally { abort.abort(); await settled; for (const slot of slots) slot.release(); }
    expect(buildGateStatus().active).toBe(0);
  });

  it('rejects overflow without allocating another waiter or disturbing the running holder', async () => {
    vi.stubEnv('CDS_MAX_QUEUED_BUILDS', '2');
    const slot = await acquireBuildSlot(); const abort = new AbortController();
    const queued = Promise.allSettled([acquireBuildSlot({ signal: abort.signal }), acquireBuildSlot({ signal: abort.signal })]);
    try {
      const result = await Promise.race([acquireBuildSlot({ signal: abort.signal }).then(() => 'accepted', e => e.name),
        new Promise(resolve => setTimeout(() => resolve('unbounded'), 30))]);
      expect(result).toBe('BuildSlotQueueCapacityError');
      expect(buildGateStatus()).toMatchObject({ active: 1, queued: 2, maxQueued: 2 });
    } finally { abort.abort(); await queued; slot.release(); }
  });

  it('expires a waiter as a timeout, releases its listener and never transfers a real slot to it', async () => {
    vi.useFakeTimers(); vi.stubEnv('CDS_BUILD_QUEUE_TIMEOUT_MS', '20');
    const slot = await acquireBuildSlot(); const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const pending = acquireBuildSlot({ signal: abort.signal }).then(() => 'started', e => e.name);
    await vi.advanceTimersByTimeAsync(21);
    expect(buildGateStatus().queued).toBe(0);
    expect(await pending).toBe('BuildSlotWaitTimeoutError');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    slot.release(); expect(buildGateStatus().active).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('freezes original ownership and exposes actual wait budget instead of trusting mutable input', async () => {
    const slot = await acquireBuildSlot(); const abort = new AbortController();
    const holder: any = { projectId: 'original', profileId: 'api' };
    const pending = acquireBuildSlot({ holder, signal: abort.signal }).then(s => { s.release(); }, () => {});
    holder.projectId = 'replacement';
    try {
      const snapshot: any = buildGateStatus();
      expect(snapshot.waiters[0]).toMatchObject({ projectId: 'original', waitingReason: 'build_capacity' });
      expect(snapshot.waiters[0].deadlineAt).toEqual(expect.any(String));
      expect(snapshot.waiters[0].waitedMs).toBeGreaterThanOrEqual(0);
      expect(snapshot.maxWaitMs).toBe(30 * 60_000);
    } finally { abort.abort(); await pending; slot.release(); }
  });

  it('does not leak a transferred slot if a start observer throws', async () => {
    const slot = await acquireBuildSlot();
    const pending = acquireBuildSlot({ onStart: () => { throw new Error('observer failed'); } }).catch(e => e.message);
    slot.release(); expect(await pending).toBe('observer failed');
    expect(buildGateStatus().active).toBe(0); expect(buildGateStatus().holders).toEqual([]);
  });
});
