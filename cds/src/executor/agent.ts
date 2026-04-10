/**
 * Executor Agent — runs on each server that hosts containers.
 * Registers with the Scheduler, sends heartbeats, and reports status.
 *
 * Two registration modes:
 *  1. Bootstrap: first-time join. Send `X-Bootstrap-Token` from .cds.env,
 *     receive a `permanentToken` in the response, persist it back.
 *  2. Resume: restart after bootstrap. Send `X-Executor-Token` directly,
 *     no token exchange needed.
 *
 * See `doc/design.cds-cluster-bootstrap.md` §5.2 for the full sequence.
 */
import os from 'node:os';
import type { CdsConfig, ExecutorNode } from '../types.js';
import type { StateService } from '../services/state.js';
import { updateEnvFile, defaultEnvFilePath } from '../services/env-file.js';

export interface BootstrapRegisterResponse {
  node: ExecutorNode;
  permanentToken?: string;
  masterInfo?: { mode?: string; schedulerUrl?: string };
}

export class ExecutorAgent {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  readonly executorId: string;
  /** Set after a successful register() so heartbeat uses the updated token. */
  private effectiveToken: string | undefined;

  constructor(
    private readonly config: CdsConfig,
    private readonly stateService: StateService,
  ) {
    const hostname = os.hostname();
    this.executorId = `executor-${hostname}-${config.executorPort}`;
    this.effectiveToken = config.executorToken;
  }

  /**
   * Register this executor with the remote scheduler.
   *
   * Returns true on success. On failure, returns false so callers can decide
   * whether to retry (e.g., from a systemd restart loop).
   */
  async register(): Promise<boolean> {
    if (!this.config.schedulerUrl) {
      console.error('  [executor] CDS_MASTER_URL / CDS_SCHEDULER_URL not set, cannot register');
      return false;
    }

    const payload = this.buildRegistration();
    const isBootstrap = !this.effectiveToken && !!this.config.bootstrapToken;
    console.log(
      `  [executor] Registering with scheduler: ${this.config.schedulerUrl}` +
      (isBootstrap ? ' (bootstrap)' : ' (resume)'),
    );

    try {
      const res = await fetch(`${this.config.schedulerUrl}/api/executors/register`, {
        method: 'POST',
        headers: this.registerHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error(`  [executor] Registration failed (${res.status}): ${text}`);
        return false;
      }
      const body = (await res.json()) as BootstrapRegisterResponse;
      console.log(`  [executor] Registered as ${this.executorId}`);

      // Bootstrap path: the master just minted a permanent token for us.
      // Persist it to `.cds.env` so the next restart can skip bootstrap.
      if (body.permanentToken && body.permanentToken !== this.effectiveToken) {
        this.effectiveToken = body.permanentToken;
        this.persistPermanentToken(body.permanentToken);
      }
      return true;
    } catch (err) {
      console.error(`  [executor] Registration failed: ${(err as Error).message}`);
      return false;
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

  /** Explicitly unregister from the master. Used by `./exec_cds.sh disconnect`. */
  async unregister(): Promise<boolean> {
    if (!this.config.schedulerUrl) return false;
    try {
      const res = await fetch(
        `${this.config.schedulerUrl}/api/executors/${this.executorId}`,
        {
          method: 'DELETE',
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(5_000),
        },
      );
      return res.ok;
    } catch (err) {
      console.error(`  [executor] Unregister failed: ${(err as Error).message}`);
      return false;
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
      // Silent — scheduler may be temporarily unavailable. The next tick will retry.
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
      role: 'remote',
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

  /**
   * Headers for the initial /register call. Prefers the permanent token if
   * we already have one (restart-after-bootstrap case), otherwise sends the
   * one-shot bootstrap token.
   */
  private registerHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.effectiveToken) {
      headers['X-Executor-Token'] = this.effectiveToken;
    } else if (this.config.bootstrapToken) {
      headers['X-Bootstrap-Token'] = this.config.bootstrapToken.value;
    }
    return headers;
  }

  /** Headers for heartbeat / unregister — must use the permanent token. */
  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.effectiveToken) {
      headers['X-Executor-Token'] = this.effectiveToken;
    }
    return headers;
  }

  /**
   * Persist the freshly-minted permanent token back to `.cds.env` so that
   * the next process restart skips bootstrap. The write is atomic so a crash
   * mid-write can't corrupt the env file.
   */
  private persistPermanentToken(token: string): void {
    try {
      const envPath = defaultEnvFilePath();
      updateEnvFile(envPath, {
        CDS_EXECUTOR_TOKEN: token,
        // Clear the one-shot bootstrap token — it's been consumed.
        CDS_BOOTSTRAP_TOKEN: null,
        CDS_BOOTSTRAP_TOKEN_EXPIRES_AT: null,
      });
      console.log(`  [executor] Persisted permanent token to ${envPath}`);
    } catch (err) {
      console.error(`  [executor] Failed to persist token: ${(err as Error).message}`);
    }
  }
}
