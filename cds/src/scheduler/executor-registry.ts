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
    // Use os.availableParallelism() so cgroup-limited runs report their
    // actual CPU allocation, not the host's physical core count. Falls back
    // to os.cpus().length on Node < 19. See ExecutorAgent.buildRegistration
    // for the matching logic in the remote-side agent.
    const cores = (typeof os.availableParallelism === 'function'
      ? os.availableParallelism()
      : os.cpus().length) || 1;
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

  /**
   * Process a heartbeat from an executor.
   *
   * Also syncs the executor's reported branches into master state so the
   * dashboard's branch list shows remote-owned branches with correct status.
   * This is the "merge" for P2 #8 (heartbeat branch sync): if the executor
   * reports a branch the master doesn't know about, we create a stub entry
   * so the UI can render "hosted on X". If the status differs we update
   * the master's copy. We never overwrite metadata the user set on master
   * (notes, tags, favorites) — those are master-side only.
   */
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

    // ── Sync heartbeat-reported branches to master state ──
    //
    // For each branch the executor reports, ensure a corresponding entry
    // exists in the master's stateService with executorId pointing at this
    // node. This lets GET /api/branches show branches that live on remote
    // executors (including ones the master never explicitly dispatched to,
    // e.g. local branches on a node that later joined the cluster).
    for (const [branchId, bStatus] of Object.entries(data.branches)) {
      const existing = this.stateService.getBranch(branchId);
      if (!existing) {
        // Stub entry: minimal metadata so the UI can list + navigate. The
        // executor remains the source of truth for the runtime details.
        this.stateService.addBranch({
          id: branchId,
          branch: branchId,            // best-guess display name
          worktreePath: '',             // lives on executor, not us
          services: (bStatus.services as Record<string, import('../types.js').ServiceState>) || {},
          status: (bStatus.status as import('../types.js').BranchEntry['status']) || 'idle',
          createdAt: new Date().toISOString(),
          executorId: node.id,
        });
      } else {
        // Keep master-side metadata (tags, notes, isFavorite, etc.) but
        // refresh status + services + executor ownership from the heartbeat.
        // We mutate in place; state.save() at the end of this method flushes.
        existing.executorId = node.id;
        existing.status = (bStatus.status as import('../types.js').BranchEntry['status']) || existing.status;
        if (bStatus.services && typeof bStatus.services === 'object') {
          existing.services = bStatus.services as Record<string, import('../types.js').ServiceState>;
        }
      }
    }

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
   *  - Embedded (master) nodes are NEVER marked offline and NEVER GC'd.
   *    They represent the master process itself: if checkHealth is running,
   *    the embedded master is by definition alive. An embedded node doesn't
   *    send heartbeats (there's no one to send them to — it IS the process
   *    that would receive them), so applying heartbeat-timeout logic to it
   *    incorrectly flips it offline after 45s, cascading into a "total
   *    capacity = 0" dashboard state. Regression test covers this.
   */
  private checkHealth(): void {
    const now = Date.now();
    const executors = this.getAll();
    let changed = false;

    for (const node of executors) {
      // Embedded master is always healthy — skip entirely.
      if (node.role === 'embedded') continue;

      const lastBeat = new Date(node.lastHeartbeat).getTime();
      const sinceLastBeat = now - lastBeat;

      // Phase 1: mark stale online nodes offline.
      if (node.status !== 'offline' && sinceLastBeat > HEARTBEAT_TIMEOUT_MS) {
        console.log(`  [scheduler] Executor ${node.id} heartbeat timeout, marking offline`);
        node.status = 'offline';
        this.stateService.setExecutor(node);
        changed = true;

        // ── Basic failover signaling (P2 #7) ──
        //
        // Mark all branches owned by this executor as errored so the
        // dashboard can surface "node offline, redeploy needed" in the
        // branch list. We don't automatically redeploy elsewhere — that
        // would require conflict-free migration logic we don't have yet.
        // But the user now has a clear signal and can click "redeploy"
        // which will go through the dispatcher and pick a healthy node.
        for (const branchId of node.branches) {
          const entry = this.stateService.getBranch(branchId);
          if (entry && entry.executorId === node.id) {
            entry.status = 'error';
            entry.errorMessage = `执行器 ${node.id} 已离线，请重新部署以迁移到其他节点`;
          }
        }
      }

      // Phase 2: GC long-offline remote nodes.
      if (
        node.status === 'offline' &&
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
