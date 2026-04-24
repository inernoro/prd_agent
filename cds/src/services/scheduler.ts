import type { BranchEntry, SchedulerConfig } from '../types.js';
import type { StateService } from './state.js';

/**
 * SchedulerService — branch warm-pool manager for small servers.
 *
 * Core idea: CDS does NOT keep every branch running forever. It maintains a
 * bounded "warm pool" of HOT branches. When a new branch needs to wake, if the
 * pool is full, the least-recently-accessed non-pinned branch is cooled down.
 * Idle branches are cooled automatically after `idleTTLSeconds`.
 *
 * See `doc/design.cds-resilience.md` for the full design.
 *
 * Pinning rules (a branch is "pinned" and cannot be evicted if ANY apply):
 *   1. `branch.pinnedByUser === true`
 *   2. `branch.isColorMarked === true` (user is actively debugging)
 *   3. `state.defaultBranch === branch.id`
 *   4. `config.pinnedBranches.includes(branch.id)`
 *
 * Wake/cool is delegated via callbacks so the scheduler stays pure and testable:
 *   - `wakeFn(slug)` — bring a branch from COLD to HOT (returns when HOT)
 *   - `coolFn(slug)` — bring a branch from HOT to COLD (returns when stopped)
 *
 * The scheduler is a no-op when `config.enabled === false`, preserving pre-v3.1
 * behavior bit-for-bit.
 */

export interface SchedulerSnapshot {
  enabled: boolean;
  config: SchedulerConfig;
  hot: Array<{ slug: string; lastAccessedAt: string | undefined; pinned: boolean }>;
  cold: Array<{ slug: string; lastAccessedAt: string | undefined }>;
  capacityUsage: { current: number; max: number };
}

export type WakeFn = (slug: string) => Promise<void>;
export type CoolFn = (slug: string) => Promise<void>;

/**
 * Minimal clock interface so tests can inject deterministic time.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * Minimum interval (ms) between persistent writes of lastAccessedAt from
 * touch(). High-traffic branches can get dozens of requests per second; we
 * don't need each one to hit disk. In-memory timestamps are always fresh.
 */
const TOUCH_PERSIST_THROTTLE_MS = 15_000;

export class SchedulerService {
  private tickHandle: NodeJS.Timeout | null = null;
  private wakeFn: WakeFn | null = null;
  private coolFn: CoolFn | null = null;
  /** slug → epoch ms of last persisted touch, used to throttle save() */
  private lastPersistedTouch = new Map<string, number>();

  constructor(
    private readonly stateService: StateService,
    private readonly config: SchedulerConfig,
    private readonly clock: Clock = systemClock,
  ) {}

  setWakeFn(fn: WakeFn): void {
    this.wakeFn = fn;
  }

  setCoolFn(fn: CoolFn): void {
    this.coolFn = fn;
  }

  /** Is the scheduler actively managing branches? */
  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  /**
   * Flip the enabled flag at runtime. Mirrors the UI toggle exposed via
   * `PUT /api/scheduler/enabled`. Idempotent: enabling an already-enabled
   * scheduler or disabling an already-disabled one is a no-op. When flipping
   * from enabled→disabled we stop the tick loop; when flipping from
   * disabled→enabled we start it. The persistent storage side of the
   * override is the caller's responsibility (StateService.setSchedulerEnabledOverride).
   */
  setEnabled(enabled: boolean): void {
    if (this.config.enabled === enabled) return;
    this.config.enabled = enabled;
    if (enabled) {
      this.start();
      console.log('[scheduler] enabled at runtime (via UI toggle)');
    } else {
      this.stop();
      console.log('[scheduler] disabled at runtime (via UI toggle)');
    }
  }

  /**
   * Start the periodic tick. Safe to call multiple times.
   * Does nothing when scheduler is disabled.
   */
  start(): void {
    if (!this.isEnabled()) return;
    if (this.tickHandle) return;
    const intervalMs = Math.max(1000, (this.config.tickIntervalSeconds || 60) * 1000);
    this.tickHandle = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[scheduler] tick error:', (err as Error).message);
      });
    }, intervalMs);
    // Don't keep the event loop alive just for ticking.
    if (typeof this.tickHandle.unref === 'function') {
      this.tickHandle.unref();
    }
    console.log(`[scheduler] started (maxHot=${this.config.maxHotBranches}, idleTTL=${this.config.idleTTLSeconds}s, tick=${this.config.tickIntervalSeconds}s)`);
  }

  /**
   * Stop the periodic tick. Used on process shutdown and in tests.
   */
  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * Called by the proxy after a successful route to a branch.
   * Updates `lastAccessedAt` (the LRU key) in memory immediately and persists
   * to disk at most once per TOUCH_PERSIST_THROTTLE_MS per branch.
   *
   * Throttling is safe because:
   *   - Eviction reads the in-memory timestamp, which is always fresh
   *   - The persisted value only matters on process restart, and
   *     15s staleness is acceptable for a restart window
   *
   * No-op when scheduler is disabled.
   */
  touch(slug: string): void {
    if (!this.isEnabled()) return;
    const branch = this.stateService.getBranch(slug);
    if (!branch) return;

    const now = this.clock.now();
    branch.lastAccessedAt = new Date(now).toISOString();

    const lastPersist = this.lastPersistedTouch.get(slug) || 0;
    if (now - lastPersist >= TOUCH_PERSIST_THROTTLE_MS) {
      this.lastPersistedTouch.set(slug, now);
      this.stateService.save();
    }
  }

  /**
   * Mark a branch as HOT in the scheduler's view.
   * Called after a successful wake (deploy/redeploy) completes.
   * Does NOT perform any wake action itself — that is the caller's job.
   */
  markHot(slug: string): void {
    if (!this.isEnabled()) return;
    const branch = this.stateService.getBranch(slug);
    if (!branch) return;
    branch.heatState = 'hot';
    if (!branch.lastAccessedAt) {
      branch.lastAccessedAt = new Date(this.clock.now()).toISOString();
    }
    this.stateService.save();
  }

  /**
   * Cool a branch: invoke the registered coolFn and mark heatState=cold.
   * The coolFn is responsible for stopping containers and updating service statuses.
   * Pinned branches are never cooled — the call is a silent no-op.
   */
  async markCold(slug: string): Promise<void> {
    if (!this.isEnabled()) return;
    const branch = this.stateService.getBranch(slug);
    if (!branch) return;
    if (this.isPinned(branch)) return;
    if (branch.heatState === 'cold' || branch.heatState === 'cooling') return;

    branch.heatState = 'cooling';
    this.stateService.save();

    try {
      if (this.coolFn) {
        await this.coolFn(slug);
      }
      branch.heatState = 'cold';
      this.stateService.save();
      console.log(`[scheduler] cooled branch "${slug}"`);
    } catch (err) {
      console.error(`[scheduler] cool failed for "${slug}":`, (err as Error).message);
      // Revert on failure so we retry next tick.
      branch.heatState = 'hot';
      this.stateService.save();
      throw err;
    }
  }

  /**
   * Wake a branch: invoke the registered wakeFn and mark heatState=hot.
   * Enforces capacity: if the hot pool would exceed maxHotBranches, evicts
   * the LRU non-pinned branch first.
   */
  async wake(slug: string): Promise<void> {
    if (!this.isEnabled()) {
      if (this.wakeFn) await this.wakeFn(slug);
      return;
    }
    const branch = this.stateService.getBranch(slug);
    // Note: branch may not yet exist if this is a first-time request. In that
    // case we still call wakeFn (it will create the branch), and mark hot after.
    if (branch && (branch.heatState === 'hot' || branch.heatState === 'warming')) {
      // Already hot — just refresh access time.
      this.touch(slug);
      return;
    }

    // Evict LRU if the new branch would push us over capacity.
    await this.evictLruIfOverCapacity(slug);

    if (branch) {
      branch.heatState = 'warming';
      this.stateService.save();
    }

    try {
      if (this.wakeFn) {
        await this.wakeFn(slug);
      }
      const fresh = this.stateService.getBranch(slug);
      if (fresh) {
        fresh.heatState = 'hot';
        fresh.lastAccessedAt = new Date(this.clock.now()).toISOString();
        this.stateService.save();
      }
    } catch (err) {
      const fresh = this.stateService.getBranch(slug);
      if (fresh) {
        fresh.heatState = 'cold';
        this.stateService.save();
      }
      throw err;
    }
  }

  /**
   * Mark a branch as pinned-by-user.
   */
  pin(slug: string): void {
    const branch = this.stateService.getBranch(slug);
    if (!branch) throw new Error(`分支 "${slug}" 不存在`);
    branch.pinnedByUser = true;
    this.stateService.save();
  }

  /**
   * Remove pinned-by-user flag. Note: the branch may still be implicitly
   * pinned via defaultBranch / colorMarked / config.pinnedBranches.
   */
  unpin(slug: string): void {
    const branch = this.stateService.getBranch(slug);
    if (!branch) throw new Error(`分支 "${slug}" 不存在`);
    branch.pinnedByUser = false;
    this.stateService.save();
  }

  /**
   * Is this branch protected from eviction?
   *
   * Protection sources:
   *   1. pinnedByUser flag
   *   2. isColorMarked flag (user is debugging)
   *   3. defaultBranch (the only branch guaranteed to exist)
   *   4. config.pinnedBranches includes the slug
   */
  isPinned(branch: BranchEntry): boolean {
    if (branch.pinnedByUser) return true;
    if (branch.isColorMarked) return true;
    const state = this.stateService.getState();
    if (state.defaultBranch === branch.id) return true;
    if (this.config.pinnedBranches?.includes(branch.id)) return true;
    return false;
  }

  /**
   * Find the LRU (least-recently-accessed) non-pinned HOT branch.
   * Returns null if there's nothing to evict.
   */
  selectLruVictim(excludeSlug?: string): BranchEntry | null {
    const hotBranches = this.getHotBranches().filter(b => b.id !== excludeSlug && !this.isPinned(b));
    if (hotBranches.length === 0) return null;

    return hotBranches.reduce<BranchEntry | null>((oldest, b) => {
      if (!oldest) return b;
      const oldestTs = oldest.lastAccessedAt ? Date.parse(oldest.lastAccessedAt) : 0;
      const bTs = b.lastAccessedAt ? Date.parse(b.lastAccessedAt) : 0;
      return bTs < oldestTs ? b : oldest;
    }, null);
  }

  /**
   * If the hot pool would exceed maxHotBranches after waking `excludeSlug`,
   * cool the LRU victim. Returns the number of branches cooled (0 or 1).
   *
   * maxHotBranches === 0 means unlimited.
   */
  async evictLruIfOverCapacity(excludeSlug?: string): Promise<number> {
    if (!this.isEnabled()) return 0;
    const max = this.config.maxHotBranches;
    if (!max || max <= 0) return 0;

    const hotCount = this.getHotBranches().filter(b => b.id !== excludeSlug).length;
    // +1 for the branch we're about to wake (if it's not already hot).
    if (hotCount + 1 <= max) return 0;

    const victim = this.selectLruVictim(excludeSlug);
    if (!victim) {
      console.warn(`[scheduler] capacity overrun: ${hotCount + 1} hot but no evictable branch (all pinned)`);
      return 0;
    }

    await this.markCold(victim.id);
    return 1;
  }

  /**
   * Background tick: cool branches idle for more than idleTTLSeconds,
   * and ensure capacity is within budget.
   */
  async tick(): Promise<void> {
    if (!this.isEnabled()) return;

    const now = this.clock.now();
    const idleTTLMs = (this.config.idleTTLSeconds || 900) * 1000;

    // 1. Idle-based cooling
    const hotBranches = this.getHotBranches();
    for (const branch of hotBranches) {
      if (this.isPinned(branch)) continue;
      const lastAccess = branch.lastAccessedAt ? Date.parse(branch.lastAccessedAt) : 0;
      if (lastAccess <= 0) continue; // never accessed; don't cool yet
      if (now - lastAccess > idleTTLMs) {
        try {
          await this.markCold(branch.id);
        } catch (err) {
          console.error(`[scheduler] idle cool failed for "${branch.id}":`, (err as Error).message);
        }
      }
    }

    // 2. Capacity-based cooling (in case external deploys bypassed wake())
    const max = this.config.maxHotBranches;
    if (max > 0) {
      let hotCount = this.getHotBranches().length;
      while (hotCount > max) {
        const victim = this.selectLruVictim();
        if (!victim) break;
        try {
          await this.markCold(victim.id);
          hotCount--;
        } catch {
          break;
        }
      }
    }
  }

  /**
   * Return the current hot pool as BranchEntry[].
   * A branch is considered "hot" when heatState=hot OR heatState is undefined
   * but the branch is actually running (legacy branches pre-scheduler).
   */
  private getHotBranches(): BranchEntry[] {
    const all = this.stateService.getAllBranches();
    return all.filter(b => {
      if (b.heatState === 'hot') return true;
      if (b.heatState === undefined && b.status === 'running') return true;
      return false;
    });
  }

  /**
   * Return a serializable snapshot for the Dashboard / API.
   */
  getSnapshot(): SchedulerSnapshot {
    const all = this.stateService.getAllBranches();
    const hot = all
      .filter(b => b.heatState === 'hot' || (b.heatState === undefined && b.status === 'running'))
      .map(b => ({
        slug: b.id,
        lastAccessedAt: b.lastAccessedAt,
        pinned: this.isPinned(b),
      }));
    const cold = all
      .filter(b => b.heatState === 'cold' || b.heatState === 'cooling')
      .map(b => ({
        slug: b.id,
        lastAccessedAt: b.lastAccessedAt,
      }));

    return {
      enabled: this.isEnabled(),
      config: this.config,
      hot,
      cold,
      capacityUsage: {
        current: hot.length,
        max: this.config.maxHotBranches,
      },
    };
  }
}
