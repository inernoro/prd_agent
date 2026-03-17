/**
 * Executor Agent — runs on each server that hosts containers.
 * Registers with the Scheduler, sends heartbeats, and reports status.
 */
import os from 'node:os';
import type { CdsConfig, ExecutorNode } from '../types.js';
import type { StateService } from '../services/state.js';

export class ExecutorAgent {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  readonly executorId: string;

  constructor(
    private readonly config: CdsConfig,
    private readonly stateService: StateService,
  ) {
    const hostname = os.hostname();
    this.executorId = `executor-${hostname}-${config.executorPort}`;
  }

  /** Register this executor with the remote scheduler */
  async register(): Promise<void> {
    if (!this.config.schedulerUrl) {
      console.error('  [executor] CDS_SCHEDULER_URL not set, cannot register');
      return;
    }

    const payload = this.buildRegistration();
    console.log(`  [executor] Registering with scheduler: ${this.config.schedulerUrl}`);

    try {
      const res = await fetch(`${this.config.schedulerUrl}/api/executors/register`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error(`  [executor] Registration failed (${res.status}): ${text}`);
        return;
      }
      console.log(`  [executor] Registered as ${this.executorId}`);
    } catch (err) {
      console.error(`  [executor] Registration failed: ${(err as Error).message}`);
    }
  }

  /** Start periodic heartbeat (every 15 seconds) */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 15_000);
    // Send initial heartbeat immediately
    this.sendHeartbeat();
  }

  /** Stop the heartbeat timer */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.config.schedulerUrl) return;

    const branches = this.stateService.getAllBranches();
    const branchStatus: Record<string, { status: string; services: Record<string, unknown> }> = {};
    for (const b of branches) {
      branchStatus[b.id] = { status: b.status, services: b.services };
    }

    const payload = {
      load: this.getSystemLoad(),
      branches: branchStatus,
    };

    try {
      await fetch(`${this.config.schedulerUrl}/api/executors/${this.executorId}/heartbeat`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Silent — scheduler may be temporarily unavailable
    }
  }

  private buildRegistration(): Partial<ExecutorNode> {
    const totalMem = Math.round(os.totalmem() / (1024 * 1024));
    const cpus = os.cpus().length;
    return {
      id: this.executorId,
      host: this.detectHost(),
      port: this.config.executorPort,
      capacity: {
        maxBranches: Math.max(2, Math.floor(totalMem / 2048)), // ~2GB per branch
        memoryMB: totalMem,
        cpuCores: cpus,
      },
      labels: [],
    };
  }

  private detectHost(): string {
    // Use explicit host if set
    if (process.env.CDS_EXECUTOR_HOST) return process.env.CDS_EXECUTOR_HOST;
    // Try to find a non-loopback IPv4 address
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      if (!iface) continue;
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          return addr.address;
        }
      }
    }
    return '127.0.0.1';
  }

  private getSystemLoad(): { memoryUsedMB: number; cpuPercent: number } {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMB = Math.round((totalMem - freeMem) / (1024 * 1024));
    // 1-minute load average as percentage of CPU cores
    const loadAvg = os.loadavg()[0];
    const cpuPercent = Math.round((loadAvg / os.cpus().length) * 100);
    return { memoryUsedMB: usedMB, cpuPercent: Math.min(cpuPercent, 100) };
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.config.executorToken) {
      headers['X-Executor-Token'] = this.config.executorToken;
    }
    return headers;
  }
}
