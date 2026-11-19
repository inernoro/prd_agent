import { afterEach, describe, expect, it, vi } from 'vitest';
import { JanitorService } from '../../src/services/janitor.js';
import { reclaimLock } from '../../src/services/reclaim-lock.js';
import type { StateService } from '../../src/services/state.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const services: JanitorService[] = [];
const holders: Array<() => void> = [];

afterEach(async () => {
  services.splice(0).forEach(service => service.stop());
  holders.splice(0).forEach(release => release());
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
  const state = { getAllBranches: () => [], getProjects: () => [] } as unknown as StateService;
  const prune = vi.fn(async () => ({ ran: true, reclaimed: [], errors: [] }));
  const service = new JanitorService(state, { enabled: false, worktreeTTLDays: 7,
    diskWarnPercent: 80, sweepIntervalSeconds: 3600, imageRetention: false, orphanWorktrees: false },
  '/isolated-lock-fixture', { now: () => Date.now() }, () => ({ totalBytes: 1000, freeBytes: 200 }), prune);
  services.push(service);
  return { service, prune };
}

function occupy() {
  let release!: () => void;
  const work = new Promise<void>(resolve => { release = resolve; });
  const held = reclaimLock.run('owned-resource-retention', () => work);
  holders.push(release);
  return { release, held };
}

describe('Janitor progress after a competing bounded resource-retirement pass', () => {
  it('rechecks within the current hour after the holder releases, without overlapping the holder', async () => {
    const { service, prune } = fixture();
    const holder = occupy();
    service.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(prune).not.toHaveBeenCalled();
    expect(service.getSnapshot().lastSweep?.reclaimDeferred?.heldBy).toBe('owned-resource-retention');
    expect(service.getSnapshot().reclaimLock?.holder).toBe('owned-resource-retention');
    expect(service.getSnapshot().lastSweep?.capacity?.fullRecheckScheduled).toBe(true);
    holder.release(); await holder.held;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().lastSweep?.errors).toBe(0);
    expect(service.getSnapshot().lastSweep?.reclaimDeferred).toBeUndefined();
    expect(service.getSnapshot().lastSweep?.capacity?.fullRecheckScheduled).toBe(false);
  });

  it('makes progress across repeated minute-keeper collisions without concurrent native work', async () => {
    const { service, prune } = fixture();
    let activeKeeper = 0;
    const passes: Array<Promise<unknown>> = [];
    const keeper = () => passes.push(reclaimLock.run('owned-resource-retention', async () => {
      activeKeeper++;
      try {
        await new Promise<void>(resolve => {
          holders.push(resolve);
          setTimeout(resolve, 125_000);
        });
      } finally { activeKeeper--; }
    }));
    keeper();
    const timer = setInterval(keeper, MINUTE);
    prune.mockImplementation(async () => {
      expect(activeKeeper, 'native reclaim must never overlap a keeper').toBe(0);
      return { ran: true, reclaimed: [], errors: [] };
    });
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(3 * HOUR - 1);
      expect(prune, 'hourly phases would otherwise collide on every cycle').toHaveBeenCalledTimes(3);
    } finally {
      clearInterval(timer);
      holders.splice(0).forEach(release => release());
      await Promise.all(passes);
    }
  });

  it('cancels an obsolete deferred recheck when a regular sweep succeeds first', async () => {
    const { service, prune } = fixture();
    const holder = occupy();
    service.start(); await vi.advanceTimersByTimeAsync(30_000);
    holder.release(); await holder.held;
    await service.sweep();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it('does not let a source-only pass satisfy or cancel a pending full recheck', async () => {
    const { service, prune } = fixture();
    const holder = occupy();
    service.start(); await vi.advanceTimersByTimeAsync(30_000);
    holder.release(); await holder.held;
    const worker = service as unknown as { executeSweep(sourceOnly: boolean): Promise<unknown>; runSweep(sourceOnly: boolean): Promise<unknown> };
    const original = worker.runSweep.bind(service);
    let finishSource!: () => void;
    const sourceBlock = new Promise<void>(resolve => { finishSource = resolve; });
    const source = vi.spyOn(worker, 'runSweep').mockImplementation(async sourceOnly => {
      if (sourceOnly) await sourceBlock;
      return original(sourceOnly);
    });
    const pending = worker.executeSweep(true);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(prune).not.toHaveBeenCalled();
    finishSource(); await pending;
    await vi.advanceTimersByTimeAsync(1);
    expect(source.mock.calls.map(([sourceOnly]) => sourceOnly)).toEqual([true, false]);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().lastFullSweep?.reclaimDeferred).toBeUndefined();
  });

  it('caps repeated contention retries and resets the allowance only on the regular cycle', async () => {
    const { service, prune } = fixture();
    const worker = vi.spyOn(service as unknown as { runSweep(sourceOnly: boolean): Promise<unknown> }, 'runSweep');
    occupy(); service.start();
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(prune).not.toHaveBeenCalled();
    expect(worker).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker).toHaveBeenCalledTimes(7);
  });

  it('cancels a pending recheck when stopped and never rearms it for a manual-only sweep', async () => {
    const { service, prune } = fixture();
    const holder = occupy();
    service.start(); await vi.advanceTimersByTimeAsync(30_000); service.stop();
    holder.release(); await holder.held;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(prune).not.toHaveBeenCalled();
    const next = occupy();
    await service.sweep(); next.release(); await next.held;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(prune).not.toHaveBeenCalled();
  });
});
