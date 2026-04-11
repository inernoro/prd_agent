/**
 * ExecutorRegistry — manages registered executor nodes.
 * Tracks heartbeats, selects optimal executor for deployments.
 */
import os from 'node:os';
import type { ExecutorNode, ClusterCapacity } from '../types.js';
import type { StateService } from '../services/state.js';

const HEARTBEAT_TIMEOUT_MS = 45_000; // 3 missed heartbeats (15s × 3)

/**
 * Garbage-collect remote executors that have been offline for this long.
 * 24 hours strikes a balance: long enough that a node failing over a weekend
 * isn't lost, short enough that capacity dashboards don't accumulate ghosts
 * forever after `disconnect` calls fail their best-effort DELETE. Embedded
 * (master) executors are never GC'd — they re-register on every boot.
 */
const OFFLINE_GC_MS = 24 * 60 * 60 * 1000;

export type SchedulingStrategy = 'least-branches' | 'least-load' | 'round-robin';

export class ExecutorRegistry {
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly stateService: StateService) {}

  /** Start periodic health checks (every 20 seconds) */
  startHealthChecks(): void {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => this.checkHealth(), 20_000);
  }

  stopHealthChecks(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Register or update an executor.
   *
   * Special protection: once a node is recorded as `role === 'embedded'` it
   * cannot be downgraded to `'remote'` by a subsequent register call. This
   * prevents a malicious or buggy remote executor from claiming the master's
   * id and demoting the embedded entry, which would silently disable the
   * embedded deploy path. The only way to remove an embedded entry is through
   * `remove()`.
   */
  register(data: {
    id: string;
    host: string;
    port: number;
    capacity: ExecutorNode['capacity'];
    labels?: string[];
    role?: 'embedded' | 'remote';
  }): ExecutorNode {
    const existing = this.stateService.getExecutor(data.id);
    const now = new Date().toISOString();

    // Embedded role is sticky — never let a remote register downgrade it.
    let effectiveRole: 'embedded' | 'remote';
    if (existing?.role === 'embedded') {
      effectiveRole = 'embedded';
    } else {
      effectiveRole = data.role ?? existing?.role ?? 'remote';
    }

    const node: ExecutorNode = {
      id: data.id,
      host: data.host,
      port: data.port,
      status: 'online',
      capacity: data.capacity,
      load: existing?.load || { memoryUsedMB: 0, cpuPercent: 0 },
      labels: data.labels || [],
      branches: existing?.branches || [],
      lastHeartbeat: now,
      registeredAt: existing?.registeredAt || now,
      role: effectiveRole,
    };

    this.stateService.setExecutor(node);
    this.stateService.save();
    return node;
  }

  /**
   * Register the master itself as an "embedded" executor so its machine
   * resources are counted in total cluster capacity. The embedded node's
   * deploy path is still the existing standalone code (no HTTP), distinguished
   * by `role === 'embedded'`.
   *
   * Called once when the master boots in scheduler mode, or when standalone
   * upgrades to scheduler on first executor bootstrap. Idempotent.
   */
  registerEmbeddedMaster(masterPort: number, hostname?: string): ExecutorNode {
    const totalMB = Math.round(os.totalmem() / (1024 * 1024));
    const cores = os.cpus().length || 1;
    const host = hostname || os.hostname() || '127.0.0.1';
    const id = `master-${host}`;
    return this.register({
      id,
      host: '127.0.0.1', // master is always reachable via loopback from within itself
      port: masterPort,
      capacity: {
        // Same heuristic as ExecutorAgent.buildRegistration() — ~2GB per branch.
        maxBranches: Math.max(2, Math.floor(totalMB / 2048)),
        memoryMB: totalMB,
        cpuCores: cores,
      },
      labels: ['embedded', 'master'],
      role: 'embedded',
    });
  }

  /**
   * Aggregate capacity across all registered executors (online + offline).
   * Used by `GET /api/executors/capacity` so the dashboard and external
   * monitors can see total cluster capacity grow as executors join.
   *
   * "Used" load is summed across online nodes only (offline nodes can't
   * report a meaningful current load). The `freePercent` is a simple
   * weighted average of memory-free and CPU-free across the online set.
   */
  getTotalCapacity(): ClusterCapacity {
    const all = this.getAll();
    const online = all.filter(n => n.status !== 'offline');

    let totalMaxBranches = 0;
    let totalMemoryMB = 0;
    let totalCpuCores = 0;
    let usedBranches = 0;
    let usedMemoryMB = 0;
    // For weighted averages across online nodes.
    let cpuWeightedSum = 0;
    let cpuCoreTotal = 0;

    for (const node of online) {
      totalMaxBranches += node.capacity.maxBranches;
      totalMemoryMB += node.capacity.memoryMB;
      totalCpuCores += node.capacity.cpuCores;
      usedBranches += node.branches.length;
      usedMemoryMB += node.load.memoryUsedMB;
      cpuWeightedSum += (node.load.cpuPercent / 100) * node.capacity.cpuCores;
      cpuCoreTotal += node.capacity.cpuCores;
    }

    const cpuPercent = cpuCoreTotal > 0
      ? Math.round((cpuWeightedSum / cpuCoreTotal) * 100)
      : 0;

    // freePercent: average of mem-free and cpu-free across all online nodes.
    // When there's no capacity at all (no executors registered) we report 0
    // rather than dividing by zero, so dashboards show "cluster empty".
    let freePercent = 0;
    if (totalMemoryMB > 0) {
      const memFree = 100 - Math.round((usedMemoryMB / totalMemoryMB) * 100);
      const cpuFree = 100 - cpuPercent;
      freePercent = Math.max(0, Math.min(100, Math.round((memFree + cpuFree) / 2)));
    }

    return {
      online: online.length,
      offline: all.length - online.length,
      total: {
        maxBranches: totalMaxBranches,
        memoryMB: totalMemoryMB,
        cpuCores: totalCpuCores,
      },
      used: {
        branches: usedBranches,
        memoryMB: usedMemoryMB,
        cpuPercent,
      },
      freePercent,
      nodes: all.map(n => ({
        id: n.id,
        role: n.role || 'remote',
        host: n.host,
        status: n.status,
        capacity: n.capacity,
        load: n.load,
        branchCount: n.branches.length,
      })),
    };
  }

  /** Number of online executors — convenience accessor for mode-upgrade logic. */
  onlineCount(): number {
    return this.getOnline().length;
  }

  /** Process a heartbeat from an executor */
  heartbeat(executorId: string, data: {
    load: { memoryUsedMB: number; cpuPercent: number };
    branches: Record<string, { status: string; services: Record<string, unknown> }>;
  }): boolean {
    const node = this.stateService.getExecutor(executorId);
    if (!node) return false;

    node.status = 'online';
    node.load = data.load;
    node.branches = Object.keys(data.branches);
    node.lastHeartbeat = new Date().toISOString();

    this.stateService.setExecutor(node);
    this.stateService.save();
    return true;
  }

  /** Remove an executor */
  remove(executorId: string): void {
    this.stateService.removeExecutor(executorId);
    this.stateService.save();
  }

  /** Get all executors */
  getAll(): ExecutorNode[] {
    return Object.values(this.stateService.getExecutors());
  }

  /** Get online executors only */
  getOnline(): ExecutorNode[] {
    return this.getAll().filter(n => n.status === 'online');
  }

  /**
   * Select the best executor for a new deployment.
   * Strategy: least-branches (default), least-load, or round-robin.
   */
  selectExecutor(strategy: SchedulingStrategy = 'least-branches', labels?: string[]): ExecutorNode | null {
    let candidates = this.getOnline().filter(n => n.status !== 'draining');

    // Filter by labels if specified
    if (labels && labels.length > 0) {
      candidates = candidates.filter(n =>
        labels.every(label => n.labels.includes(label))
      );
    }

    if (candidates.length === 0) return null;

    switch (strategy) {
      case 'least-branches':
        candidates.sort((a, b) => a.branches.length - b.branches.length);
        return candidates[0];

      case 'least-load': {
        // Composite score: 60% memory, 40% CPU
        const score = (n: ExecutorNode) => {
          const memPct = n.capacity.memoryMB > 0 ? (n.load.memoryUsedMB / n.capacity.memoryMB) * 100 : 100;
          return memPct * 0.6 + n.load.cpuPercent * 0.4;
        };
        candidates.sort((a, b) => score(a) - score(b));
        return candidates[0];
      }

      case 'round-robin': {
        // Sort by last heartbeat (oldest first = least recently used)
        candidates.sort((a, b) => a.lastHeartbeat.localeCompare(b.lastHeartbeat));
        return candidates[0];
      }

      default:
        return candidates[0];
    }
  }

  /** Find which executor hosts a given branch */
  findExecutorForBranch(branchId: string): ExecutorNode | null {
    const executors = this.getAll();
    return executors.find(n => n.branches.includes(branchId)) || null;
  }

  /**
   * Check health of all executors:
   *  - Online nodes that miss `HEARTBEAT_TIMEOUT_MS` are marked offline.
   *  - Remote nodes that have been offline for `OFFLINE_GC_MS` are removed
   *    entirely. This is the safety net for cases where `disconnect`'s
   *    best-effort DELETE call failed and a node would otherwise sit in the
   *    capacity dashboard forever.
   *  - Embedded (master) nodes are NEVER GC'd — they re-register on boot.
   */
  private checkHealth(): void {
    const now = Date.now();
    const executors = this.getAll();
    let changed = false;

    for (const node of executors) {
      const lastBeat = new Date(node.lastHeartbeat).getTime();
      const sinceLastBeat = now - lastBeat;

      // Phase 1: mark stale online nodes offline.
      if (node.status !== 'offline' && sinceLastBeat > HEARTBEAT_TIMEOUT_MS) {
        console.log(`  [scheduler] Executor ${node.id} heartbeat timeout, marking offline`);
        node.status = 'offline';
        this.stateService.setExecutor(node);
        changed = true;
      }

      // Phase 2: GC long-offline remote nodes.
      if (
        node.status === 'offline' &&
        node.role !== 'embedded' &&
        sinceLastBeat > OFFLINE_GC_MS
      ) {
        console.log(`  [scheduler] GC executor ${node.id} (offline > 24h)`);
        this.stateService.removeExecutor(node.id);
        changed = true;
      }
    }

    if (changed) this.stateService.save();
  }
}
