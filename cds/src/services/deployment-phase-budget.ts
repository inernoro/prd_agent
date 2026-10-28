import os from 'node:os';
import { readFile } from 'node:fs/promises';
import type { BranchEntry, BuildProfile, IShellExecutor, ServiceRuntimeRef } from '../types.js';
import { serviceRuntimeRefs } from './service-runtime.js';

let memorySample = { mb: os.freemem() / 1048576, at: Date.now() };
let memoryRead: Promise<void> | undefined;
let daemonMemory: { usedMB: number; pids?: number; at: number; maxAgeMs: number } | undefined;
export function setDeploymentPhaseHostUsage(usedMB: number, at: number, maxAgeMs: number, pids?: number): void {
  if (Number.isFinite(usedMB) && usedMB >= 0) daemonMemory = { usedMB, at, maxAgeMs, pids };
}
export function deploymentHostPidBudget(): number | null {
  const raw = process.env.CDS_HOST_PID_BUDGET;
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 128 ? value : 0;
}
function sampleHostAvailablePids(): number {
  const budget = deploymentHostPidBudget();
  if (budget === null) return Infinity;
  if (!budget || !daemonMemory || daemonMemory.pids === undefined || Date.now() - daemonMemory.at > daemonMemory.maxAgeMs) return 0;
  return Math.max(0, budget - daemonMemory.pids - 256);
}
export function deploymentHostMemoryBudgetMB(): number | null {
  const raw = process.env.CDS_HOST_MEMORY_BUDGET_MB;
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1024 ? value : 0;
}
function sampleHostMemoryMB(): number {
  if (process.platform === 'linux' && !memoryRead) {
    memoryRead = readFile('/proc/meminfo', 'utf8').then(text => {
      const value = /(?:^|\n)MemAvailable:\s+(\d+) kB/.exec(text);
      if (!value) throw new Error('memory sample unavailable');
      memorySample = { mb: Number(value[1]) / 1024, at: Date.now() };
    }).catch(() => { memorySample = { mb: os.freemem() / 1048576, at: Date.now() }; })
      .finally(() => { memoryRead = undefined; });
  }
  const physical = process.platform !== 'linux' ? os.freemem() / 1048576 : Date.now() - memorySample.at > 5000 ? 0 : memorySample.mb;
  const budget = deploymentHostMemoryBudgetMB();
  if (budget === null) return physical;
  if (!budget || !daemonMemory || Date.now() - daemonMemory.at > daemonMemory.maxAgeMs) return 0;
  return Math.max(0, Math.min(physical, budget - daemonMemory.usedMB));
}
let memoryProvider = sampleHostMemoryMB;
export function setDeploymentPhaseMemoryProvider(provider: (() => number) | null): void {
  memoryProvider = provider || sampleHostMemoryMB;
}

export type DeploymentPhase = 'pull' | 'start' | 'ready' | 'cleanup' | 'terminal';
export interface DeploymentPhaseOwner { projectId?: string; branchId?: string; profileId?: string; operationId?: string | null }
interface Request {
  owner: DeploymentPhaseOwner; check?: () => void; signal?: AbortSignal;
  resolve: (release: () => void) => void; reject: (error: Error) => void;
  abort?: () => void; memoryMB: number; enqueuedAt: number;
  reservationKey?: string;
  pids: number;
}

/** 阶段互不占槽；旧服务的物理占用已在可用内存内，新启动额外预留控制面余量。 */
export class DeploymentPhaseBudget {
  private readonly active = new Map<DeploymentPhase, Set<Request>>();
  private readonly waiting = new Map<DeploymentPhase, Request[]>();
  private readonly lastProject = new Map<DeploymentPhase, string>();
  private readonly memoryReservations = new Map<string, { memoryMB: number; pids: number; owner: DeploymentPhaseOwner }>();
  private timer?: NodeJS.Timeout;
  private readonly limits: Record<DeploymentPhase, number>;
  constructor(private readonly availableMemoryMB: () => number = () => memoryProvider(),
    limits: Partial<Record<DeploymentPhase, number>> = {},
    private readonly headroomMB = 1024, private readonly availablePids = sampleHostAvailablePids) { this.limits = { pull: 3, start: 3, ready: 3, cleanup: 1, terminal: 1, ...limits }; }

  snapshot() {
    return Object.fromEntries((['pull', 'start', 'ready', 'cleanup', 'terminal'] as const).map(phase => [phase, {
      limit: this.limits[phase], active: [...(this.active.get(phase) || [])].map(request => ({ ...request.owner, memoryMB: request.memoryMB })),
      queued: (this.waiting.get(phase) || []).map(request => ({ ...request.owner, enqueuedAt: request.enqueuedAt,
        reason: phase === 'start' && !this.memoryAllows(request.memoryMB, request.reservationKey) ? 'memory-headroom'
          : phase === 'start' && !this.pidsAllow(request) ? 'pid-headroom' : 'phase-capacity' })),
    }]));
  }

  releaseMemory(key: string): void { this.memoryReservations.delete(key); this.pump(); }
  reserveKnownMemory(key: string, memoryMB: number, owner: DeploymentPhaseOwner, pids = 64): void {
    this.memoryReservations.set(key, { memoryMB: Math.max(1, memoryMB || 512), pids: Math.max(1, pids || 64), owner });
  }
  memorySnapshot() { return [...this.memoryReservations].map(([key, value]) => ({ key, ...value })); }
  private memoryAllows(memoryMB: number, key?: string): boolean {
    const available = this.availableMemoryMB();
    const reserved = [...this.memoryReservations].reduce((sum, [name, reservation]) => sum + (name === key ? 0 : reservation.memoryMB), 0)
      + [...(this.active.get('start') || [])].filter(request => !request.reservationKey).reduce((sum, request) => sum + request.memoryMB, 0);
    return Number.isFinite(available) && available >= this.headroomMB + reserved + memoryMB;
  }
  private pidsAllow(request: Request): boolean {
    const reserved = [...this.memoryReservations].reduce((sum, [key, value]) => sum + (key === request.reservationKey ? 0 : value.pids), 0)
      + [...(this.active.get('start') || [])].filter(item => !item.reservationKey).reduce((sum, item) => sum + item.pids, 0);
    return this.availablePids() >= reserved + request.pids;
  }

  acquire(phase: DeploymentPhase, owner: DeploymentPhaseOwner, options: {
    check?: () => void; signal?: AbortSignal; memoryMB?: number; reservationKey?: string; pids?: number;
  } = {}): Promise<() => void> {
    try { options.check?.(); } catch (error) { return Promise.reject(error); }
    if (options.signal?.aborted) return Promise.reject(new Error('部署阶段等待已取消'));
    const waiting = this.waiting.get(phase) || [];
    if (waiting.length >= 64) return Promise.reject(new Error('部署阶段等待已满，请稍后重试；旧服务保持可用'));
    this.waiting.set(phase, waiting);
    return new Promise((resolve, reject) => {
      const request: Request = { owner, check: options.check, signal: options.signal, resolve, reject,
        memoryMB: phase === 'start' ? Math.max(1, options.memoryMB || 512) : 0, pids: phase === 'start' ? Math.max(1, options.pids || 64) : 0,
        enqueuedAt: Date.now(), reservationKey: options.reservationKey };
      request.abort = () => {
        const index = waiting.indexOf(request);
        if (index >= 0) { waiting.splice(index, 1); request.signal?.removeEventListener('abort', request.abort!);
          reject(new Error('部署阶段等待已取消')); this.pump(); }
      };
      options.signal?.addEventListener('abort', request.abort, { once: true });
      waiting.push(request); this.pump();
      if (!this.timer && [...this.waiting.values()].some(queue => queue.length)) {
        this.timer = setInterval(() => this.pump(), 500); this.timer.unref();
      }
    });
  }

  pump(): void {
    for (const [phase, queue] of this.waiting) {
      const active = this.active.get(phase) || new Set<Request>(); this.active.set(phase, active);
      for (let index = queue.length - 1; index >= 0; index--) {
        const request = queue[index];
        try { request.check?.(); if (request.signal?.aborted) throw new Error('部署阶段等待已取消');
          if (Date.now() - request.enqueuedAt > 1200000) throw new Error('部署阶段等待超时，旧服务保持可用');
        } catch (error) { queue.splice(index, 1); request.signal?.removeEventListener('abort', request.abort!); request.reject(error as Error); }
      }
      while (active.size < this.limits[phase] && queue.length) {
        const previous = this.lastProject.get(phase);
        let index = queue.findIndex(request => (request.owner.projectId || '_unknown') !== previous
          && (phase !== 'start' || this.memoryAllows(request.memoryMB, request.reservationKey) && this.pidsAllow(request)));
        if (index < 0) index = queue.findIndex(request => phase !== 'start' || this.memoryAllows(request.memoryMB, request.reservationKey) && this.pidsAllow(request));
        if (index < 0) break;
        const [request] = queue.splice(index, 1);
        request.signal?.removeEventListener('abort', request.abort!);
        active.add(request); this.lastProject.set(phase, request.owner.projectId || '_unknown');
        if (phase === 'start' && request.reservationKey) this.reserveKnownMemory(request.reservationKey, request.memoryMB, request.owner, request.pids);
        let released = false;
        request.resolve(() => { if (released) return; released = true; active.delete(request); this.pump(); });
      }
    }
    if (this.timer && ![...this.waiting.values()].some(queue => queue.length)) { clearInterval(this.timer); this.timer = undefined; }
  }

  async run<T>(phase: DeploymentPhase, owner: DeploymentPhaseOwner, task: () => Promise<T>,
    options: Parameters<DeploymentPhaseBudget['acquire']>[2] = {}): Promise<T> {
    const release = await this.acquire(phase, owner, options);
    try { options.check?.(); return await task(); } finally { release(); }
  }
}

export const deploymentPhaseBudget = new DeploymentPhaseBudget();

export async function restoreDeploymentMemoryReservations(
  branches: readonly BranchEntry[], profiles: (branch: BranchEntry) => BuildProfile[],
  options: { shell?: IShellExecutor; budget?: DeploymentPhaseBudget } = {},
): Promise<void> {
  const budget = options.budget || deploymentPhaseBudget;
  const candidates: Array<{ branch: BranchEntry; profileId: string; runtime: ServiceRuntimeRef; memoryMB: number }> = [];
  for (const branch of branches) {
    const hints = new Map(profiles(branch).map(profile => [profile.id, profile.resources?.memoryMB || 512]));
    for (const service of Object.values(branch.services)) for (const runtime of serviceRuntimeRefs(service)) {
      const incomplete = runtime.creationIssued && (runtime === service ? service.status !== 'running'
        : runtime === service.pendingRuntime || !runtime.containerId);
      if (incomplete) candidates.push({ branch, profileId: service.profileId, runtime, memoryMB: hints.get(service.profileId) || 512 });
    }
  }
  // A stopped immutable container cannot consume a startup reservation. Verify its
  // identity and terminal Docker state without changing the retained runtime or container.
  const receipts = new Map<string, { status: string; project: string; branch: string; profile: string }>();
  const ids = [...new Set(candidates.map(item => item.runtime.containerId).filter((id): id is string => !!id && /^[a-f0-9]{64}$/.test(id)))];
  if (options.shell && ids.length) {
    const format = '{"id":{{json .Id}},"status":{{json .State.Status}},"project":{{json (index .Config.Labels "cds.project.id")}},"branch":{{json (index .Config.Labels "cds.branch.id")}},"profile":{{json (index .Config.Labels "cds.profile.id")}}}';
    try {
      const result = await options.shell.exec(`docker inspect --format '${format}' ${ids.join(' ')}`, { timeout: 5000, executionLane: 'observation' });
      for (const line of result.stdout.trim().split('\n')) {
        try {
          const receipt = JSON.parse(line);
          if (ids.includes(receipt.id)) receipts.set(receipt.id, receipt);
        } catch { /* Missing or malformed receipts retain their reservation. */ }
      }
    } catch { /* Unavailable Docker is unknown, not evidence of a stopped runtime. */ }
  }
  for (const { branch, profileId, runtime, memoryMB } of candidates) {
    const receipt = runtime.containerId ? receipts.get(runtime.containerId) : undefined;
    const stopped = receipt && ['exited', 'dead'].includes(receipt.status)
      && receipt.project === (branch.projectId || '_unknown') && receipt.branch === branch.id && receipt.profile === profileId;
    if (!stopped) budget.reserveKnownMemory(runtime.containerName, memoryMB, { projectId: branch.projectId, branchId: branch.id, profileId });
  }
}
