/**
 * BranchDispatcher — Phase 3 of the CDS resilience plan.
 *
 * Bridges the existing scheduler/executor scaffold (ExecutorRegistry) with
 * the Phase 1 per-node warm-pool scheduler. This is the **systematic**
 * integration: the Master Scheduler (running in mode=scheduler) picks an
 * executor according to each node's /api/scheduler/state. New nodes use their
 * memory budget and older nodes still report a branch-count limit.
 *
 * See `doc/design.cds.resilience.md` Phase 3.
 */

import type { ExecutorNode } from '../types.js';
import type { ExecutorRegistry } from './executor-registry.js';
import type { PreviewMemoryCapacity } from '../services/deployment-phase-budget.js';

/** Snapshot returned by an executor's /api/scheduler/state endpoint. */
export interface ExecutorSchedulerSnapshot {
  enabled: boolean;
  capacityUsage: { current: number; max: number | null };
  memoryCapacity?: PreviewMemoryCapacity | null;
  hot: Array<{ slug: string; lastAccessedAt?: string; pinned: boolean }>;
  cold: Array<{ slug: string; lastAccessedAt?: string }>;
}

/** Fetched snapshot paired with its executor node. */
export interface ExecutorSnapshotPair {
  executor: ExecutorNode;
  snapshot: ExecutorSchedulerSnapshot | null;
  fetchError?: string;
}

export type DispatchStrategy =
  /** Pick the executor with the lowest reported capacity utilization. */
  | 'capacity-aware'
  /** Fall back to ExecutorRegistry's least-branches strategy. */
  | 'least-branches';

/** Result of a dispatch attempt. */
export interface DispatchResult {
  executor: ExecutorNode | null;
  reason: string;
  snapshots?: ExecutorSnapshotPair[];
}

/**
 * Minimal HTTP client interface so tests can inject mocks without
 * pulling in fetch/undici mocking libraries.
 */
export interface SnapshotFetcher {
  fetch(executor: ExecutorNode): Promise<ExecutorSchedulerSnapshot | null>;
}

/**
 * Default fetcher: uses global fetch() to call the executor's
 * GET /api/scheduler/state endpoint.
 */
export class HttpSnapshotFetcher implements SnapshotFetcher {
  constructor(private readonly authHeaderValue?: string) {}

  async fetch(executor: ExecutorNode): Promise<ExecutorSchedulerSnapshot | null> {
    const url = `http://${executor.host}:${executor.port}/api/scheduler/state`;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.authHeaderValue) {
        headers['X-AI-Access-Key'] = this.authHeaderValue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok) return null;
        const data = await res.json();
        // Validate shape minimally.
        if (typeof data !== 'object' || data === null) return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = data as any;
        if (typeof d.enabled !== 'boolean') return null;
        if (!d.capacityUsage || typeof d.capacityUsage.current !== 'number') return null;
        return d as ExecutorSchedulerSnapshot;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  }
}

export class BranchDispatcher {
  constructor(
    private readonly registry: ExecutorRegistry,
    private readonly fetcher: SnapshotFetcher,
  ) {}

  /**
   * Fetch /api/scheduler/state from every online executor in parallel.
   * Returns one entry per online executor, with snapshot=null for failures.
   * Draining executors are excluded.
   */
  async fetchAllSnapshots(): Promise<ExecutorSnapshotPair[]> {
    const candidates = this.registry.getOnline().filter(e => e.status !== 'draining');
    const pairs = await Promise.all(
      candidates.map(async (executor) => {
        try {
          const snapshot = await this.fetcher.fetch(executor);
          return { executor, snapshot };
        } catch (err) {
          return {
            executor,
            snapshot: null,
            fetchError: (err as Error).message,
          };
        }
      }),
    );
    return pairs;
  }

  /**
   * Pick the best executor for a new branch.
   *
   * `capacity-aware` (default): choose the executor with the lowest
   *   hot-pool utilization (current / max). Ties broken by branch count.
   *   Executors whose scheduler is DISABLED or whose snapshot failed
   *   fall back to the least-branches metric from the registry.
   *
   * `least-branches`: legacy fallback, defers entirely to ExecutorRegistry.
   *
   * Returns `null` when no executor is available (all offline or draining).
   */
  async selectExecutorForBranch(
    branchSlug: string,
    strategy: DispatchStrategy = 'capacity-aware',
  ): Promise<DispatchResult> {
    // Step 1: check if branch already lives on an executor (idempotency)
    const existingHost = this.registry.findExecutorForBranch(branchSlug);
    if (existingHost) {
      return {
        executor: existingHost,
        reason: `branch already deployed on ${existingHost.id}`,
      };
    }

    // Step 2: strategy dispatch
    if (strategy === 'least-branches') {
      const pick = this.registry.selectExecutor('least-branches');
      return {
        executor: pick,
        reason: pick
          ? `least-branches: ${pick.id} (${pick.branches.length} branches)`
          : 'no online executors',
      };
    }

    // capacity-aware: fetch snapshots in parallel
    const snapshots = await this.fetchAllSnapshots();
    if (snapshots.length === 0) {
      return {
        executor: null,
        reason: 'no online executors',
        snapshots: [],
      };
    }

    const rankable = snapshots.flatMap(pair => {
      const snapshot = pair.snapshot;
      if (!snapshot?.enabled) return [];
      const memory = snapshot.memoryCapacity;
      if (memory !== undefined) {
        if (!memory || !Number.isFinite(memory.usedMB) || memory.usedMB < 0
          || !Number.isFinite(memory.limitMB) || memory.usedMB >= memory.limitMB) return [];
        return [{ pair, ratio: memory.usedMB / memory.limitMB, usage: '内存预算' }];
      }
      const { current, max } = snapshot.capacityUsage;
      return typeof max === 'number' && max > 0 ? [{ pair, ratio: current / max, usage: `${current}/${max}` }] : [];
    });

    if (rankable.length === 0) {
      if (snapshots.some(({ snapshot }) => snapshot?.enabled && snapshot.memoryCapacity !== undefined)) {
        return { executor: null, reason: '暂时没有可确认内存余量的执行器，请稍后重试。', snapshots };
      }
      // Fallback: no executor has a usable Phase 1 snapshot (they're all
      // running disabled/unreachable) → defer to registry's branch count.
      const pick = this.registry.selectExecutor('least-branches');
      return {
        executor: pick,
        reason: pick
          ? `fallback (no usable snapshots): least-branches → ${pick.id}`
          : 'no online executors and no fallback available',
        snapshots,
      };
    }

    rankable.sort((a, b) => a.ratio - b.ratio || a.pair.executor.branches.length - b.pair.executor.branches.length);
    const { pair: winner, ratio, usage } = rankable[0];
    return {
      executor: winner.executor,
      reason: `capacity-aware: ${winner.executor.id} at ${Math.round(ratio * 100)}% (${usage})`,
      snapshots,
    };
  }
}
