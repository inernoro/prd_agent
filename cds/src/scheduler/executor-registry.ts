/**
 * ExecutorRegistry — manages registered executor nodes.
 * Tracks heartbeats, selects optimal executor for deployments.
 */
import type { ExecutorNode } from '../types.js';
import type { StateService } from '../services/state.js';

const HEARTBEAT_TIMEOUT_MS = 45_000; // 3 missed heartbeats (15s × 3)

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

  /** Register or update an executor */
  register(data: {
    id: string;
    host: string;
    port: number;
    capacity: ExecutorNode['capacity'];
    labels?: string[];
  }): ExecutorNode {
    const existing = this.stateService.getExecutor(data.id);
    const now = new Date().toISOString();

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
    };

    this.stateService.setExecutor(node);
    this.stateService.save();
    return node;
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

  /** Check health of all executors, mark offline if heartbeat timed out */
  private checkHealth(): void {
    const now = Date.now();
    const executors = this.getAll();
    let changed = false;

    for (const node of executors) {
      if (node.status === 'offline') continue;
      const lastBeat = new Date(node.lastHeartbeat).getTime();
      if (now - lastBeat > HEARTBEAT_TIMEOUT_MS) {
        console.log(`  [scheduler] Executor ${node.id} heartbeat timeout, marking offline`);
        node.status = 'offline';
        this.stateService.setExecutor(node);
        changed = true;
      }
    }

    if (changed) this.stateService.save();
  }
}
