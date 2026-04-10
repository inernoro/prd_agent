import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { JanitorService, type JanitorConfig, type JanitorClock, type DiskUsageFn, isBranchProtected } from '../../src/services/janitor.js';
import type { BranchEntry } from '../../src/types.js';

/**
 * Tests for JanitorService — Phase 2 worktree TTL + disk watermark.
 */

class FakeClock implements JanitorClock {
  constructor(private t: number = 0) {}
  now(): number { return this.t; }
  set(ms: number): void { this.t = ms; }
}

function makeBranch(id: string, lastAccessedDaysAgo?: number, extras: Partial<BranchEntry> = {}): BranchEntry {
  const now = new Date('2026-04-10T12:00:00Z').getTime();
  const lastAccessedAt = lastAccessedDaysAgo !== undefined
    ? new Date(now - lastAccessedDaysAgo * 24 * 60 * 60 * 1000).toISOString()
    : undefined;
  return {
    id,
    branch: id,
    worktreePath: `/tmp/wt/${id}`,
    services: {},
    status: 'idle',
    createdAt: new Date(0).toISOString(),
    lastAccessedAt,
    ...extras,
  };
}

describe('JanitorService', () => {
  let stateFile: string;
  let stateService: StateService;
  let janitor: JanitorService;
  let clock: FakeClock;
  let removed: string[];
  let mockDiskUsage: DiskUsageFn;
  let mockDiskState: { totalBytes: number; freeBytes: number } | null;

  const defaultConfig: JanitorConfig = {
    enabled: true,
    worktreeTTLDays: 30,
    diskWarnPercent: 80,
    sweepIntervalSeconds: 3600,
  };

  function setup(cfgOverride: Partial<JanitorConfig> = {}): void {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-janitor-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();
    clock = new FakeClock(new Date('2026-04-10T12:00:00Z').getTime());
    mockDiskState = { totalBytes: 10_000_000_000, freeBytes: 5_000_000_000 }; // 50%
    mockDiskUsage = () => mockDiskState;
    janitor = new JanitorService(
      stateService,
      { ...defaultConfig, ...cfgOverride },
      '/tmp/wt',
      clock,
      mockDiskUsage,
    );
    removed = [];
    janitor.setRemoveFn(async (slug) => { removed.push(slug); });
  }

  beforeEach(() => setup());

  afterEach(() => {
    janitor.stop();
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  });

  // ── isBranchProtected ──

  describe('isBranchProtected', () => {
    it('returns true for pinnedByUser', () => {
      expect(isBranchProtected(makeBranch('a', 100, { pinnedByUser: true }), null)).toBe(true);
    });
    it('returns true for isColorMarked', () => {
      expect(isBranchProtected(makeBranch('a', 100, { isColorMarked: true }), null)).toBe(true);
    });
    it('returns true when branch is defaultBranch', () => {
      expect(isBranchProtected(makeBranch('main', 100), 'main')).toBe(true);
    });
    it('returns true when branch is in configPinned list', () => {
      expect(isBranchProtected(makeBranch('keep', 100), null, ['keep'])).toBe(true);
    });
    it('returns false for unrelated branch', () => {
      expect(isBranchProtected(makeBranch('a', 100), 'main')).toBe(false);
    });
  });

  // ── TTL-based removal ──

  describe('sweep — TTL removal', () => {
    it('removes branches idle longer than worktreeTTLDays', async () => {
      stateService.addBranch(makeBranch('stale', 35)); // 35 days > 30
      stateService.addBranch(makeBranch('fresh', 5));  // 5 days < 30

      const report = await janitor.sweep();

      expect(report.removedBranches).toEqual(['stale']);
      expect(removed).toEqual(['stale']);
    });

    it('keeps branches that have never been accessed (no lastAccessedAt)', async () => {
      stateService.addBranch(makeBranch('new-never-accessed'));

      const report = await janitor.sweep();

      expect(report.removedBranches).toEqual([]);
      expect(removed).toEqual([]);
    });

    it('skips pinnedByUser branches even if stale', async () => {
      stateService.addBranch(makeBranch('pinned', 100, { pinnedByUser: true }));

      const report = await janitor.sweep();

      expect(report.removedBranches).toEqual([]);
      expect(report.skippedPinned).toEqual(['pinned']);
    });

    it('skips defaultBranch even if stale', async () => {
      stateService.addBranch(makeBranch('main', 100));
      stateService.setDefaultBranch('main');

      const report = await janitor.sweep();

      expect(report.removedBranches).toEqual([]);
      expect(report.skippedPinned).toEqual(['main']);
    });

    it('skips isColorMarked branches even if stale', async () => {
      stateService.addBranch(makeBranch('debug', 100, { isColorMarked: true }));

      const report = await janitor.sweep();

      expect(report.removedBranches).toEqual([]);
      expect(report.skippedPinned).toEqual(['debug']);
    });

    it('continues sweeping after one remove fails', async () => {
      stateService.addBranch(makeBranch('a', 40));
      stateService.addBranch(makeBranch('b', 40));

      janitor.setRemoveFn(async (slug) => {
        if (slug === 'a') throw new Error('boom');
        removed.push(slug);
      });

      const report = await janitor.sweep();

      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toContain('remove a');
      expect(report.removedBranches).toEqual(['b']);
    });

    it('sweep is a no-op for TTL when disabled but still checks disk', async () => {
      setup({ enabled: false });
      stateService.addBranch(makeBranch('stale', 100));

      const report = await janitor.sweep();

      expect(report.removedBranches).toEqual([]);
      expect(removed).toEqual([]);
      // But disk info still returned
      expect(report.disk).not.toBeNull();
    });
  });

  // ── Disk watermark ──

  describe('sweep — disk watermark', () => {
    it('reports disk usage', async () => {
      const report = await janitor.sweep();
      expect(report.disk).toEqual({
        totalBytes: 10_000_000_000,
        freeBytes: 5_000_000_000,
        usedPercent: 50,
      });
      expect(report.diskWarning).toBe(false);
    });

    it('sets diskWarning when used% >= threshold', async () => {
      mockDiskState = { totalBytes: 10_000_000_000, freeBytes: 1_000_000_000 }; // 90%
      const report = await janitor.sweep();
      expect(report.disk?.usedPercent).toBe(90);
      expect(report.diskWarning).toBe(true);
    });

    it('leaves disk field null when stat fails', async () => {
      mockDiskState = null;
      const report = await janitor.sweep();
      expect(report.disk).toBeNull();
      expect(report.diskWarning).toBe(false);
    });
  });

  // ── dryRun ──

  describe('dryRun', () => {
    it('returns would-remove / would-skip without mutating', async () => {
      stateService.addBranch(makeBranch('stale-a', 40));
      stateService.addBranch(makeBranch('stale-pinned', 40, { pinnedByUser: true }));
      stateService.addBranch(makeBranch('fresh', 5));

      const result = janitor.dryRun();

      expect(result.wouldRemove).toEqual(['stale-a']);
      expect(result.wouldSkip).toEqual(['stale-pinned']);
      // No actual removal
      expect(removed).toEqual([]);
    });
  });

  // ── start/stop idempotency ──

  describe('lifecycle', () => {
    it('start is a no-op when disabled', () => {
      setup({ enabled: false });
      janitor.start();
      janitor.stop();
      // No throw, no timer leak
    });

    it('double-start is safe', () => {
      janitor.start();
      janitor.start();
      janitor.stop();
    });
  });
});
