import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { SchedulerService, type Clock } from '../../src/services/scheduler.js';
import type { BranchEntry, SchedulerConfig } from '../../src/types.js';

/**
 * Tests for the warm-pool scheduler.
 *
 * Strategy:
 * - Use a real StateService (with a tmp file) — cheap and exercises the
 *   persistence path we care about.
 * - Inject a fake Clock so LRU and idle TTL are deterministic.
 * - Record wake/cool calls via arrays rather than mocking containers.
 *
 * See doc/design.cds-resilience.md for the behaviors under test.
 */

class FakeClock implements Clock {
  constructor(private t: number = 0) {}
  now(): number { return this.t; }
  advance(ms: number): void { this.t += ms; }
  set(ms: number): void { this.t = ms; }
}

function makeBranch(id: string, status: BranchEntry['status'] = 'running', extras: Partial<BranchEntry> = {}): BranchEntry {
  return {
    id,
    branch: id,
    worktreePath: `/tmp/wt/${id}`,
    services: {},
    status,
    createdAt: new Date(0).toISOString(),
    ...extras,
  };
}

describe('SchedulerService', () => {
  let stateFile: string;
  let stateService: StateService;
  let scheduler: SchedulerService;
  let clock: FakeClock;
  let cooled: string[];
  let woken: string[];

  const defaultConfig: SchedulerConfig = {
    enabled: true,
    maxHotBranches: 3,
    idleTTLSeconds: 900,
    tickIntervalSeconds: 60,
    pinnedBranches: [],
  };

  function setup(cfgOverride: Partial<SchedulerConfig> = {}): void {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sched-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();
    clock = new FakeClock(1_700_000_000_000); // fixed epoch ms
    scheduler = new SchedulerService(stateService, { ...defaultConfig, ...cfgOverride }, clock);
    cooled = [];
    woken = [];
    scheduler.setCoolFn(async (slug) => { cooled.push(slug); });
    scheduler.setWakeFn(async (slug) => { woken.push(slug); });
  }

  beforeEach(() => setup());

  afterEach(() => {
    scheduler.stop();
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  });

  // ── touch ──

  describe('touch', () => {
    it('updates lastAccessedAt on the branch', () => {
      stateService.addBranch(makeBranch('feature-a'));
      scheduler.touch('feature-a');
      const branch = stateService.getBranch('feature-a')!;
      expect(branch.lastAccessedAt).toBe(new Date(clock.now()).toISOString());
    });

    it('is a no-op when scheduler is disabled', () => {
      setup({ enabled: false });
      stateService.addBranch(makeBranch('feature-a'));
      scheduler.touch('feature-a');
      expect(stateService.getBranch('feature-a')!.lastAccessedAt).toBeUndefined();
    });

    it('is a no-op for unknown branch', () => {
      expect(() => scheduler.touch('nonexistent')).not.toThrow();
    });
  });

  // ── capacity and LRU eviction ──

  describe('capacity', () => {
    it('markHot succeeds when under capacity', () => {
      stateService.addBranch(makeBranch('a'));
      scheduler.markHot('a');
      expect(stateService.getBranch('a')!.heatState).toBe('hot');
    });

    it('evictLruIfOverCapacity cools LRU branch when capacity exceeded', async () => {
      // Fill pool to capacity (max=3)
      for (const [slug, t] of [['a', 1000], ['b', 2000], ['c', 3000]] as const) {
        stateService.addBranch(makeBranch(slug, 'running', {
          heatState: 'hot',
          lastAccessedAt: new Date(t).toISOString(),
        }));
      }
      // Now try to wake a 4th branch — 'a' (oldest) should be evicted
      stateService.addBranch(makeBranch('d'));
      await scheduler.evictLruIfOverCapacity('d');
      expect(cooled).toEqual(['a']);
      expect(stateService.getBranch('a')!.heatState).toBe('cold');
    });

    it('does not evict if capacity is not exceeded', async () => {
      stateService.addBranch(makeBranch('a', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(1000).toISOString(),
      }));
      stateService.addBranch(makeBranch('b'));
      await scheduler.evictLruIfOverCapacity('b');
      expect(cooled).toEqual([]);
    });

    it('maxHotBranches=0 means unlimited', async () => {
      setup({ maxHotBranches: 0 });
      for (let i = 0; i < 10; i++) {
        stateService.addBranch(makeBranch(`b${i}`, 'running', {
          heatState: 'hot',
          lastAccessedAt: new Date(i).toISOString(),
        }));
      }
      await scheduler.evictLruIfOverCapacity();
      expect(cooled).toEqual([]);
    });
  });

  // ── pinning ──

  describe('pinning', () => {
    it('refuses to evict pinnedByUser branches', async () => {
      stateService.addBranch(makeBranch('a', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(1000).toISOString(),
        pinnedByUser: true,
      }));
      stateService.addBranch(makeBranch('b', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(2000).toISOString(),
      }));
      stateService.addBranch(makeBranch('c', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(3000).toISOString(),
      }));
      stateService.addBranch(makeBranch('d'));
      await scheduler.evictLruIfOverCapacity('d');
      // 'a' is the LRU but pinned → 'b' (next oldest) must be cooled instead
      expect(cooled).toEqual(['b']);
    });

    it('treats defaultBranch as pinned', async () => {
      stateService.addBranch(makeBranch('main', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(100).toISOString(),
      }));
      stateService.setDefaultBranch('main');
      stateService.addBranch(makeBranch('b', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(2000).toISOString(),
      }));
      stateService.addBranch(makeBranch('c', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(3000).toISOString(),
      }));
      stateService.addBranch(makeBranch('d'));
      await scheduler.evictLruIfOverCapacity('d');
      // 'main' is oldest but defaultBranch → 'b' evicted instead
      expect(cooled).toEqual(['b']);
    });

    it('treats isColorMarked as pinned', async () => {
      stateService.addBranch(makeBranch('debug', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(100).toISOString(),
        isColorMarked: true,
      }));
      stateService.addBranch(makeBranch('b', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(2000).toISOString(),
      }));
      stateService.addBranch(makeBranch('c', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(3000).toISOString(),
      }));
      stateService.addBranch(makeBranch('d'));
      await scheduler.evictLruIfOverCapacity('d');
      expect(cooled).toEqual(['b']);
    });

    it('treats config.pinnedBranches entries as pinned', async () => {
      setup({ pinnedBranches: ['keep-me'] });
      stateService.addBranch(makeBranch('keep-me', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(100).toISOString(),
      }));
      stateService.addBranch(makeBranch('b', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(2000).toISOString(),
      }));
      stateService.addBranch(makeBranch('c', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(3000).toISOString(),
      }));
      stateService.addBranch(makeBranch('d'));
      await scheduler.evictLruIfOverCapacity('d');
      expect(cooled).toEqual(['b']);
    });

    it('refuses to evict if ALL hot branches are pinned', async () => {
      for (const slug of ['a', 'b', 'c']) {
        stateService.addBranch(makeBranch(slug, 'running', {
          heatState: 'hot',
          lastAccessedAt: new Date(1000).toISOString(),
          pinnedByUser: true,
        }));
      }
      stateService.addBranch(makeBranch('d'));
      const count = await scheduler.evictLruIfOverCapacity('d');
      expect(count).toBe(0);
      expect(cooled).toEqual([]);
    });

    it('pin() sets pinnedByUser', () => {
      stateService.addBranch(makeBranch('a'));
      scheduler.pin('a');
      expect(stateService.getBranch('a')!.pinnedByUser).toBe(true);
    });

    it('unpin() clears pinnedByUser', () => {
      stateService.addBranch(makeBranch('a', 'running', { pinnedByUser: true }));
      scheduler.unpin('a');
      expect(stateService.getBranch('a')!.pinnedByUser).toBe(false);
    });

    it('markCold is a silent no-op for pinned branches', async () => {
      stateService.addBranch(makeBranch('a', 'running', {
        heatState: 'hot',
        pinnedByUser: true,
      }));
      await scheduler.markCold('a');
      expect(cooled).toEqual([]);
      expect(stateService.getBranch('a')!.heatState).toBe('hot');
    });
  });

  // ── idle TTL ──

  describe('idle TTL', () => {
    it('tick() cools branches that have been idle longer than idleTTLSeconds', async () => {
      // idleTTL = 900s = 900_000 ms
      const longAgo = clock.now() - 1_000_000; // > 900s ago
      stateService.addBranch(makeBranch('stale', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(longAgo).toISOString(),
      }));
      stateService.addBranch(makeBranch('fresh', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(clock.now() - 10_000).toISOString(), // 10s ago
      }));
      await scheduler.tick();
      expect(cooled).toEqual(['stale']);
      expect(stateService.getBranch('fresh')!.heatState).toBe('hot');
    });

    it('tick() skips pinned branches even if idle', async () => {
      const longAgo = clock.now() - 1_000_000;
      stateService.addBranch(makeBranch('a', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(longAgo).toISOString(),
        pinnedByUser: true,
      }));
      await scheduler.tick();
      expect(cooled).toEqual([]);
    });

    it('tick() is a no-op when scheduler disabled', async () => {
      setup({ enabled: false });
      stateService.addBranch(makeBranch('a', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(0).toISOString(),
      }));
      await scheduler.tick();
      expect(cooled).toEqual([]);
    });
  });

  // ── snapshot ──

  describe('getSnapshot', () => {
    it('reports hot and cold branches separately', () => {
      stateService.addBranch(makeBranch('hot1', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(1000).toISOString(),
      }));
      stateService.addBranch(makeBranch('hot2', 'running', {
        heatState: 'hot',
        lastAccessedAt: new Date(2000).toISOString(),
        pinnedByUser: true,
      }));
      stateService.addBranch(makeBranch('cold1', 'idle', {
        heatState: 'cold',
        lastAccessedAt: new Date(500).toISOString(),
      }));

      const snapshot = scheduler.getSnapshot();
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.hot.map(h => h.slug).sort()).toEqual(['hot1', 'hot2']);
      expect(snapshot.cold.map(c => c.slug)).toEqual(['cold1']);
      expect(snapshot.capacityUsage).toEqual({ current: 2, max: 3 });
      // Pinned flag propagates
      const hot2 = snapshot.hot.find(h => h.slug === 'hot2')!;
      expect(hot2.pinned).toBe(true);
    });

    it('treats legacy running branches (no heatState) as hot', () => {
      stateService.addBranch(makeBranch('legacy', 'running'));
      const snapshot = scheduler.getSnapshot();
      expect(snapshot.hot.map(h => h.slug)).toEqual(['legacy']);
    });
  });

  // ── disabled mode ──

  describe('disabled mode', () => {
    beforeEach(() => setup({ enabled: false }));

    it('isEnabled returns false', () => {
      expect(scheduler.isEnabled()).toBe(false);
    });

    it('start() does not install a tick', () => {
      scheduler.start();
      // No assertion possible without timers; just verify it doesn't throw
      // and stop() doesn't error either.
      scheduler.stop();
    });

    it('markHot/markCold are no-ops', async () => {
      stateService.addBranch(makeBranch('a'));
      scheduler.markHot('a');
      await scheduler.markCold('a');
      expect(stateService.getBranch('a')!.heatState).toBeUndefined();
      expect(cooled).toEqual([]);
    });

    it('getSnapshot reports enabled=false', () => {
      const snap = scheduler.getSnapshot();
      expect(snap.enabled).toBe(false);
    });
  });

  // ── runtime config setters (UI override of idleTTL / maxHot) ──

  describe('runtime config setters', () => {
    it('setIdleTTLSeconds mutates config so the next tick uses the new threshold', async () => {
      // idle TTL starts at 900s (15min). A branch idle for 600s should NOT
      // cool yet, but after lowering the threshold to 300s it should.
      stateService.addBranch(makeBranch('feature-a', 'running', { heatState: 'hot' }));
      scheduler.touch('feature-a');
      clock.advance(600_000); // 10 min idle

      await scheduler.tick();
      expect(cooled).toEqual([]); // still under the 15min default

      scheduler.setIdleTTLSeconds(300); // lower to 5 min at runtime
      await scheduler.tick();
      expect(cooled).toEqual(['feature-a']); // now over the 5min threshold
    });

    it('setMaxHotBranches mutates the capacity cap reflected in getSnapshot', () => {
      scheduler.setMaxHotBranches(7);
      expect(scheduler.getSnapshot().capacityUsage.max).toBe(7);
    });

    it('setIdleTTLSeconds / setMaxHotBranches are idempotent no-ops on same value', () => {
      scheduler.setIdleTTLSeconds(900); // same as default
      scheduler.setMaxHotBranches(3); // same as default
      const snap = scheduler.getSnapshot();
      expect(snap.config.idleTTLSeconds).toBe(900);
      expect(snap.config.maxHotBranches).toBe(3);
    });
  });

  // ── state persistence of the UI overrides ──

  describe('scheduler override persistence (StateService)', () => {
    it('idleTTL override round-trips and clears with undefined', () => {
      expect(stateService.getSchedulerIdleTTLOverride()).toBeUndefined();
      stateService.setSchedulerIdleTTLOverride(1800);
      expect(stateService.getSchedulerIdleTTLOverride()).toBe(1800);
      stateService.setSchedulerIdleTTLOverride(undefined);
      expect(stateService.getSchedulerIdleTTLOverride()).toBeUndefined();
    });

    it('maxHot override round-trips and clears with undefined', () => {
      expect(stateService.getSchedulerMaxHotOverride()).toBeUndefined();
      stateService.setSchedulerMaxHotOverride(0);
      expect(stateService.getSchedulerMaxHotOverride()).toBe(0);
      stateService.setSchedulerMaxHotOverride(undefined);
      expect(stateService.getSchedulerMaxHotOverride()).toBeUndefined();
    });

    it('overrides survive a save + reload cycle', () => {
      stateService.setSchedulerIdleTTLOverride(120);
      stateService.setSchedulerMaxHotOverride(5);
      stateService.save();
      const reloaded = new StateService(stateFile);
      reloaded.load();
      expect(reloaded.getSchedulerIdleTTLOverride()).toBe(120);
      expect(reloaded.getSchedulerMaxHotOverride()).toBe(5);
    });
  });
});
