/**
 * BranchDispatcher — Phase 3 of the CDS resilience plan.
 *
 * Bridges the existing scheduler/executor scaffold (ExecutorRegistry) with
 * the Phase 1 per-node warm-pool scheduler. This is the **systematic**
 * integration: the Master Scheduler (running in mode=scheduler) picks an
 * executor for a new branch by reading each executor's /api/scheduler/state
 * (Phase 1 API) and choosing the one with the most headroom in its local
 * warm pool — NOT just the one with lowest aggregate memory.
 *
 * Why not just reuse ExecutorRegistry.selectExecutor('least-load')?
 *   - `least-load` uses heartbeat-reported raw memory/cpu percentages
 *   - `capacity-aware` (this file) uses Phase 1 scheduler's
 *     `capacityUsage.current / max` ratio — the actual "hot branch count"
 *     vs the configured maxHotBranches cap
 *
 * The two strategies answer different questions:
 *   - least-load: "which host has the most free RAM right now?"
 *   - capacity-aware: "which host has the most room in its warm pool?"
 *
 * For small-server clusters, capacity-aware is the right question because
 * memory usage can spike transiently during builds but the warm pool
 * is the stable long-term capacity signal.
 *
 * See `doc/design.cds-resilience.md` Phase 3.
 */

import type { ExecutorNode } from '../types.js';
import type { ExecutorRegistry } from './executor-registry.js';

/** Snapshot returned by an executor's /api/scheduler/state endpoint. */
export interface ExecutorSchedulerSnapshot {
  enabled: boolean;
  capacityUsage: { current: number; max: number };
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
  /** Pick the executor with the lowest (hot / max) ratio. */
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

    // Filter out executors with a usable snapshot (enabled AND non-empty capacity)
    const rankable = snapshots.filter(p =>
      p.snapshot !== null &&
      p.snapshot.enabled === true &&
      p.snapshot.capacityUsage.max > 0,
    );

    if (rankable.length === 0) {
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

    // Score by utilization ratio; break ties by raw branch count
    rankable.sort((a, b) => {
      const ratioA = a.snapshot!.capacityUsage.current / a.snapshot!.capacityUsage.max;
      const ratioB = b.snapshot!.capacityUsage.current / b.snapshot!.capacityUsage.max;
      if (ratioA !== ratioB) return ratioA - ratioB;
      return a.executor.branches.length - b.executor.branches.length;
    });

    const winner = rankable[0];
    const pct = Math.round(
      (winner.snapshot!.capacityUsage.current / winner.snapshot!.capacityUsage.max) * 100,
    );
    return {
      executor: winner.executor,
      reason: `capacity-aware: ${winner.executor.id} at ${pct}% (${winner.snapshot!.capacityUsage.current}/${winner.snapshot!.capacityUsage.max})`,
      snapshots,
    };
  }
}
