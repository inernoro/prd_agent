import fs from 'node:fs';
import path from 'node:path';
import type { BranchEntry } from '../types.js';
import type { StateService } from './state.js';

/**
 * JanitorService — Phase 2 of the CDS resilience plan.
 *
 * Long-lived CDS installations accumulate two kinds of junk:
 *   1. Abandoned git worktrees (branch deleted upstream, never cleaned locally)
 *   2. Stale docker layers (unused images eat disk)
 *
 * The janitor runs a periodic sweep that:
 *   - Identifies branches with `lastAccessedAt > worktreeTTLDays ago`
 *   - Skips any branch that is pinned (pinnedByUser / defaultBranch / isColorMarked)
 *   - Returns a report for the caller to act on (list → stop → delete)
 *   - Checks disk usage and emits a warning when > `diskWarnPercent`
 *
 * The actual worktree/container removal is delegated to callbacks, keeping
 * the janitor pure and testable. This mirrors the SchedulerService design
 * (cool/wake callbacks).
 *
 * See `doc/design.cds-resilience.md` Phase 2.
 */

export interface JanitorConfig {
  enabled: boolean;
  /** Delete worktrees/state for branches not accessed in this many days. */
  worktreeTTLDays: number;
  /** Emit disk warning when used% exceeds this threshold. 0-100. */
  diskWarnPercent: number;
  /** How often (in seconds) to run the sweep. */
  sweepIntervalSeconds: number;
}

/** Report returned by a single sweep pass. */
export interface JanitorSweepReport {
  timestamp: string;
  /** Branches removed by this pass. */
  removedBranches: string[];
  /** Branches that would have been removed but were pinned. */
  skippedPinned: string[];
  /** Disk usage at sweep time. null = stat failed. */
  disk: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
  /** true when disk usage exceeded diskWarnPercent. */
  diskWarning: boolean;
  /** Any errors encountered (non-fatal). */
  errors: string[];
}

/** Callback: remove a branch's worktree + docker state. */
export type RemoveBranchFn = (slug: string) => Promise<void>;

/** Callback: return disk usage info for `path`. Null = unavailable. */
export type DiskUsageFn = (targetPath: string) => { totalBytes: number; freeBytes: number } | null;

/** Isolate process.now() so tests can inject a deterministic clock. */
export interface JanitorClock {
  now(): number;
}

export const systemJanitorClock: JanitorClock = { now: () => Date.now() };

/**
 * Default disk usage implementation using `fs.statfsSync` (Node 18.15+).
 * Returns null on older Node or filesystem errors so the sweep still runs.
 */
export function defaultDiskUsage(targetPath: string): { totalBytes: number; freeBytes: number } | null {
  try {
    // statfsSync is available in Node 18.15+ / 20+.
    // We check for its presence at runtime since the types may vary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statfs = (fs as any).statfsSync;
    if (typeof statfs !== 'function') return null;
    const stat = statfs(targetPath);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    return { totalBytes, freeBytes };
  } catch {
    return null;
  }
}

/**
 * Determine whether a branch is protected from janitor cleanup.
 * Mirrors SchedulerService.isPinned but is independent (janitor may run
 * without the scheduler being enabled).
 */
export function isBranchProtected(branch: BranchEntry, defaultBranchId: string | null, configPinned: string[] = []): boolean {
  if (branch.pinnedByUser) return true;
  if (branch.isColorMarked) return true;
  if (defaultBranchId === branch.id) return true;
  if (configPinned.includes(branch.id)) return true;
  return false;
}

export class JanitorService {
  private sweepHandle: NodeJS.Timeout | null = null;
  private removeFn: RemoveBranchFn | null = null;

  constructor(
    private readonly stateService: StateService,
    private readonly config: JanitorConfig,
    private readonly worktreeBase: string,
    private readonly clock: JanitorClock = systemJanitorClock,
    private readonly diskUsage: DiskUsageFn = defaultDiskUsage,
  ) {}

  setRemoveFn(fn: RemoveBranchFn): void {
    this.removeFn = fn;
  }

  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  /** Start periodic sweeps. Safe to call multiple times. No-op when disabled. */
  start(): void {
    if (!this.isEnabled()) return;
    if (this.sweepHandle) return;
    const intervalMs = Math.max(60_000, (this.config.sweepIntervalSeconds || 3600) * 1000);
    this.sweepHandle = setInterval(() => {
      this.sweep().catch((err) => {
        console.error('[janitor] sweep error:', (err as Error).message);
      });
    }, intervalMs);
    if (typeof this.sweepHandle.unref === 'function') {
      this.sweepHandle.unref();
    }
    console.log(`[janitor] started (TTL=${this.config.worktreeTTLDays}d, diskWarn=${this.config.diskWarnPercent}%, interval=${this.config.sweepIntervalSeconds}s)`);
  }

  stop(): void {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
  }

  /**
   * Run one sweep pass. Returns a full report, even when disabled
   * (enables manual / on-demand invocation via admin API).
   */
  async sweep(): Promise<JanitorSweepReport> {
    const report: JanitorSweepReport = {
      timestamp: new Date(this.clock.now()).toISOString(),
      removedBranches: [],
      skippedPinned: [],
      disk: null,
      diskWarning: false,
      errors: [],
    };

    // 1. Disk usage check (always, even when TTL cleanup disabled — cheap)
    try {
      const usage = this.diskUsage(this.worktreeBase);
      if (usage) {
        const usedBytes = usage.totalBytes - usage.freeBytes;
        const usedPercent = Math.round((usedBytes / usage.totalBytes) * 100);
        report.disk = { ...usage, usedPercent };
        if (usedPercent >= this.config.diskWarnPercent) {
          report.diskWarning = true;
          console.warn(`[janitor] DISK ${usedPercent}% used at ${this.worktreeBase} (threshold ${this.config.diskWarnPercent}%)`);
        }
      }
    } catch (err) {
      report.errors.push(`disk check: ${(err as Error).message}`);
    }

    // 2. Worktree TTL cleanup (only when enabled — destructive)
    if (!this.isEnabled()) return report;

    const now = this.clock.now();
    const ttlMs = this.config.worktreeTTLDays * 24 * 60 * 60 * 1000;
    const state = this.stateService.getState();
    const branches = this.stateService.getAllBranches();

    for (const branch of branches) {
      const protectedReason = isBranchProtected(branch, state.defaultBranch, []);
      if (protectedReason) {
        // We still track pinned stale branches so the operator can see them.
        if (branch.lastAccessedAt && (now - Date.parse(branch.lastAccessedAt)) > ttlMs) {
          report.skippedPinned.push(branch.id);
        }
        continue;
      }

      // Never delete a branch we've never observed being accessed —
      // it might be a newly created worktree.
      if (!branch.lastAccessedAt) continue;

      const idleMs = now - Date.parse(branch.lastAccessedAt);
      if (idleMs <= ttlMs) continue;

      // Found a stale branch. Delegate removal to the caller.
      try {
        if (this.removeFn) {
          await this.removeFn(branch.id);
        }
        report.removedBranches.push(branch.id);
        console.log(`[janitor] removed stale branch "${branch.id}" (idle ${Math.round(idleMs / (24*60*60*1000))}d)`);
      } catch (err) {
        report.errors.push(`remove ${branch.id}: ${(err as Error).message}`);
      }
    }

    return report;
  }

  /**
   * Dry run: returns the set of branches the next sweep would affect,
   * without performing any mutation.
   */
  dryRun(): { wouldRemove: string[]; wouldSkip: string[] } {
    const wouldRemove: string[] = [];
    const wouldSkip: string[] = [];
    const now = this.clock.now();
    const ttlMs = this.config.worktreeTTLDays * 24 * 60 * 60 * 1000;
    const state = this.stateService.getState();

    for (const branch of this.stateService.getAllBranches()) {
      if (!branch.lastAccessedAt) continue;
      const idleMs = now - Date.parse(branch.lastAccessedAt);
      if (idleMs <= ttlMs) continue;

      if (isBranchProtected(branch, state.defaultBranch, [])) {
        wouldSkip.push(branch.id);
      } else {
        wouldRemove.push(branch.id);
      }
    }
    // Reference `path` so the import is kept — it will be used by future
    // extensions (e.g. per-project worktree root globbing).
    void path;
    return { wouldRemove, wouldSkip };
  }
}
