import os from 'node:os';
import { readFile } from 'node:fs/promises';
import type { BranchEntry, BuildProfile } from '../types.js';
import { serviceRuntimeRefs } from './service-runtime.js';
import { ProjectAdmissionOrder } from './project-admission-order.js';
import { buildLoadPressure, type BuildLoadPressure } from './build-gate.js';
import { HOST_LOAD_SATURATED_RATIO } from './control-plane-pressure.js';

let memorySample = { mb: os.freemem() / 1048576, at: Date.now(), source: 'os-freemem' as 'os-freemem' | 'linux-memavailable' };
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
      memorySample = { mb: Number(value[1]) / 1024, at: Date.now(), source: 'linux-memavailable' };
    }).catch(() => { memorySample = { mb: os.freemem() / 1048576, at: Date.now(), source: 'os-freemem' }; })
      .finally(() => { memoryRead = undefined; });
  }
  if (process.platform !== 'linux') memorySample = { mb: os.freemem() / 1048576, at: Date.now(), source: 'os-freemem' };
  const physical = process.platform === 'linux' && Date.now() - memorySample.at > 5000 ? 0 : memorySample.mb;
  const budget = deploymentHostMemoryBudgetMB();
  if (budget === null) return physical;
  if (!budget || !daemonMemory || Date.now() - daemonMemory.at > daemonMemory.maxAgeMs) return 0;
  return Math.max(0, Math.min(physical, budget - daemonMemory.usedMB));
}
let memoryProvider = sampleHostMemoryMB;
export function setDeploymentPhaseMemoryProvider(provider: (() => number) | null): void {
  memoryProvider = provider || sampleHostMemoryMB;
}

/** 复用门禁的实际采样；不读取凭据、不触发 Docker 盘点、不修改预约或预算。 */
export function deploymentHostMemoryEvidence() {
  const effective = memoryProvider();
  const now = Date.now();
  const linux = process.platform === 'linux';
  const budgetMB = deploymentHostMemoryBudgetMB();
  const sampleAgeMs = linux ? now - memorySample.at : 0;
  const daemonAgeMs = daemonMemory ? now - daemonMemory.at : null;
  return {
    sampledAt: new Date(linux ? memorySample.at : now).toISOString(),
    source: linux ? memorySample.source : 'os-freemem',
    physicalAvailableMB: memorySample.mb,
    sampleAgeMs, sampleMaxAgeMs: linux ? 5000 : null,
    sampleFresh: !linux || sampleAgeMs <= 5000,
    sampleReadPending: Boolean(memoryRead),
    configuredBudgetMB: budgetMB,
    budgetState: budgetMB === null ? 'unconfigured' : budgetMB === 0 ? 'invalid' : 'configured',
    daemonUsedMB: daemonMemory?.usedMB ?? null,
    daemonSampleAgeMs: daemonAgeMs,
    daemonSampleMaxAgeMs: daemonMemory?.maxAgeMs ?? null,
    daemonSampleFresh: Boolean(daemonMemory && daemonAgeMs! <= daemonMemory.maxAgeMs),
    effectiveAvailableMB: Number.isFinite(effective) ? effective : null,
    providerOverride: memoryProvider !== sampleHostMemoryMB,
  };
}

export type DeploymentPhase = 'pull' | 'start' | 'ready' | 'cleanup' | 'terminal';
export const DEPLOYMENT_PHASE_WAIT_TIMEOUT_MS = 20 * 60_000;
export interface DeploymentPhaseOwner { projectId?: string; branchId?: string; profileId?: string; operationId?: string | null; operationGeneration?: number }
export type DeploymentPhaseWaitReason = 'memory-headroom' | 'pid-headroom' | 'cpu-startup-capacity' | 'phase-capacity' | 'admission-deadline';
export interface DeploymentPhaseTimeoutDetails {
  phase: DeploymentPhase; reason: DeploymentPhaseWaitReason; waitedMs: number; active: number; limit: number;
  requestedMemoryMB: number; reservedMemoryMB: number; availableMemoryMB: number | null;
  requestedPids: number; reservedPids: number; availablePids: number | null;
}
const PHASE_LABELS: Record<DeploymentPhase, string> = { pull: '镜像拉取', start: '容器启动', ready: '就绪探测', cleanup: '容器清理', terminal: '终止清理' };
const WAIT_REASON_LABELS: Record<DeploymentPhaseWaitReason, string> = {
  'memory-headroom': '内存余量不足', 'pid-headroom': '进程余量不足', 'cpu-startup-capacity': '启动期并发已满',
  'phase-capacity': '阶段并发已满', 'admission-deadline': '已超过准入等待期限',
};
export class DeploymentPhaseTimeoutError extends Error {
  readonly code = 'deployment.phase-wait-timeout';
  constructor(readonly diagnostics: DeploymentPhaseTimeoutDetails) {
    super(`部署阶段等待超时：${PHASE_LABELS[diagnostics.phase]}，${WAIT_REASON_LABELS[diagnostics.reason]}；未获得阶段准入。请查看阶段准入事件后处理。`);
    this.name = 'DeploymentPhaseTimeoutError';
  }
}
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
  private readonly projectOrders = new Map<DeploymentPhase, ProjectAdmissionOrder>();
  private readonly memoryReservations = new Map<string, { memoryMB: number; pids: number; owner: DeploymentPhaseOwner;
    startup?: { check?: () => void }; recovered?: boolean }>();
  private timer?: NodeJS.Timeout;
  private readonly limits: Record<DeploymentPhase, number>;
  constructor(private readonly availableMemoryMB: () => number = () => memoryProvider(),
    limits: Partial<Record<DeploymentPhase, number>> = {},
    private readonly headroomMB = 1024, private readonly availablePids = sampleHostAvailablePids,
    private readonly hostLoad: () => BuildLoadPressure = buildLoadPressure) { this.limits = { pull: 3, start: 3, ready: 3, cleanup: 1, terminal: 1, ...limits }; }

  snapshot() {
    return Object.fromEntries((['pull', 'start', 'ready', 'cleanup', 'terminal'] as const).map(phase => [phase, {
      limit: this.limits[phase], active: [...(this.active.get(phase) || [])].map(request => ({ ...request.owner, memoryMB: request.memoryMB })),
      queued: (this.waiting.get(phase) || []).map(request => ({ ...request.owner, enqueuedAt: request.enqueuedAt,
        reason: this.waitReason(phase, request),
        ...(phase === 'start' ? { memoryAdmission: this.memoryDecision(request.memoryMB, request.reservationKey) } : {}) })),
    }]));
  }

  releaseMemory(key: string): void { this.memoryReservations.delete(key); this.pump(); }
  reserveKnownMemory(key: string, memoryMB: number, owner: DeploymentPhaseOwner, pids = 64, recovered = false): void {
    this.memoryReservations.set(key, { memoryMB: Math.max(1, memoryMB || 512), pids: Math.max(1, pids || 64), owner, recovered });
  }
  memorySnapshot() { return [...this.memoryReservations].map(([key, { memoryMB, pids, owner }]) => ({ key, memoryMB, pids, owner })); }

  /** 在异步停止/失败收尾之前捕获预约身份，确认后也不能清掉同名称的新预约。 */
  captureMemoryRelease(key: string, owner?: DeploymentPhaseOwner): () => boolean {
    const reservation = this.memoryReservations.get(key);
    const owned = !owner || reservation && (['projectId', 'branchId', 'profileId', 'operationId', 'operationGeneration'] as const)
      .every(field => reservation.owner[field] === owner[field]);
    return () => {
      if (!owned || !reservation || this.memoryReservations.get(key) !== reservation) return false;
      this.releaseMemory(key); return true;
    };
  }

  /** 只观测真实、有界且资格仍有效的排队，不把执行中或已过期任务伪装成等待。 */
  waitingOperation(operationId: string, generation: number): { phase: DeploymentPhase; enqueuedAt: number; deadlineAt: number } | undefined {
    if (!operationId || !Number.isSafeInteger(generation) || generation < 1) return undefined;
    for (const [phase, queue] of this.waiting) for (const request of queue) {
      if (request.owner.operationId !== operationId || request.owner.operationGeneration !== generation
        || !request.check || request.signal?.aborted || Date.now() - request.enqueuedAt > DEPLOYMENT_PHASE_WAIT_TIMEOUT_MS) continue;
      try { request.check?.(); } catch { continue; }
      return { phase, enqueuedAt: request.enqueuedAt, deadlineAt: request.enqueuedAt + DEPLOYMENT_PHASE_WAIT_TIMEOUT_MS };
    }
    return undefined;
  }

  /** 真实盘点只释放同一份已终结预约；读取期间的新预约或在途创建不能被旧回执清掉。 */
  async reconcileMemoryReservations(unused: (key: string, owner: DeploymentPhaseOwner) => Promise<boolean>,
    options: { recoveredOnly?: boolean; afterKey?: string } = {}): Promise<{ released: string[]; retained: string[] }> {
    const released: string[] = [], retained: string[] = [];
    const activeStart = (key: string) => [...(this.active.get('start') || [])].some(request => request.reservationKey === key);
    const candidates = [...this.memoryReservations].filter(([, reservation]) => !options.recoveredOnly || reservation.recovered);
    const after = candidates.findIndex(([key]) => key === options.afterKey);
    const ordered = after < 0 ? candidates : [...candidates.slice(after + 1), ...candidates.slice(0, after + 1)];
    for (const [key, reservation] of ordered) {
      let confirmed = false;
      if (!activeStart(key)) {
        try { confirmed = await unused(key, { ...reservation.owner }); } catch { /* 未确认仍保留 */ }
      }
      if (confirmed && this.memoryReservations.get(key) === reservation && !activeStart(key)) {
        this.releaseMemory(key); released.push(key);
      } else retained.push(key);
    }
    return { released, retained };
  }
  private memoryDecision(memoryMB: number, key?: string) {
    const available = this.availableMemoryMB();
    const reserved = [...this.memoryReservations].reduce((sum, [name, reservation]) => sum + (name === key ? 0 : reservation.memoryMB), 0)
      + [...(this.active.get('start') || [])].filter(request => !request.reservationKey).reduce((sum, request) => sum + request.memoryMB, 0);
    const required = this.headroomMB + reserved + memoryMB;
    return { availableMemoryMB: Number.isFinite(available) ? available : null,
      headroomMB: this.headroomMB, reservedMemoryMB: reserved, requestedMemoryMB: memoryMB,
      requiredMemoryMB: required, deficitMemoryMB: Number.isFinite(available) ? Math.max(0, required - available) : null,
      allowed: Number.isFinite(available) && available >= required };
  }
  private memoryAllows(memoryMB: number, key?: string): boolean { return this.memoryDecision(memoryMB, key).allowed; }
  private pidsAllow(request: Request): boolean {
    const reserved = [...this.memoryReservations].reduce((sum, [key, value]) => sum + (key === request.reservationKey ? 0 : value.pids), 0)
      + [...(this.active.get('start') || [])].filter(item => !item.reservationKey).reduce((sum, item) => sum + item.pids, 0);
    return this.availablePids() >= reserved + request.pids;
  }

  private cpuAllows(request: Request): boolean {
    // 物理责任可从历史恢复，但不是本进程的启动执行体。有效新启动持续计到真实就绪，
    // 资格失效只退出CPU占位，内存/PID预约仍须真实回收证明才能释放。
    const current = (check?: () => void) => { try { check?.(); return true; } catch { return false; } };
    const warming = [...this.memoryReservations].filter(([key, value]) => key !== request.reservationKey
      && value.startup && current(value.startup.check)).length
      + [...(this.active.get('start') || [])].filter(item => !item.reservationKey && current(item.check)).length;
    const pressure = this.hostLoad();
    const limit = pressure.ratio >= HOST_LOAD_SATURATED_RATIO ? 1 : this.limits.start;
    return warming < limit;
  }

  private waitReason(phase: DeploymentPhase, request: Request): DeploymentPhaseWaitReason {
    if (phase === 'start') {
      if (!this.memoryAllows(request.memoryMB, request.reservationKey)) return 'memory-headroom';
      if (!this.pidsAllow(request)) return 'pid-headroom';
      if (!this.cpuAllows(request)) return 'cpu-startup-capacity';
    }
    return (this.active.get(phase)?.size || 0) >= this.limits[phase] ? 'phase-capacity' : 'admission-deadline';
  }

  private timeoutDetails(phase: DeploymentPhase, request: Request): DeploymentPhaseTimeoutDetails {
    const reservations = [...this.memoryReservations].filter(([key]) => key !== request.reservationKey).map(([, value]) => value);
    const anonymous = [...(this.active.get('start') || [])].filter(item => !item.reservationKey);
    const finite = (value: number) => Number.isFinite(value) ? value : null;
    // 只记录汇总与本请求配额，不把其他项目、容器或环境变量泄露给失败请求。
    return { phase, reason: this.waitReason(phase, request), waitedMs: Date.now() - request.enqueuedAt,
      active: this.active.get(phase)?.size || 0, limit: this.limits[phase], requestedMemoryMB: request.memoryMB,
      reservedMemoryMB: [...reservations, ...anonymous].reduce((sum, value) => sum + value.memoryMB, 0),
      availableMemoryMB: phase === 'start' ? finite(this.availableMemoryMB()) : null,
      requestedPids: request.pids, reservedPids: [...reservations, ...anonymous].reduce((sum, value) => sum + value.pids, 0),
      availablePids: phase === 'start' ? finite(this.availablePids()) : null };
  }

  acquire(phase: DeploymentPhase, owner: DeploymentPhaseOwner, options: {
    check?: () => void; signal?: AbortSignal; memoryMB?: number; reservationKey?: string; pids?: number;
  } = {}): Promise<() => void> {
    try { options.check?.(); } catch (error) { return Promise.reject(error); }
    if (options.signal?.aborted) return Promise.reject(new Error('部署阶段等待已取消'));
    const waiting = this.waiting.get(phase) || [];
    if (waiting.length >= 64) return Promise.reject(new Error('部署阶段等待已满，未获得阶段准入；请稍后重试并核对现有服务状态'));
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
          if (Date.now() - request.enqueuedAt > DEPLOYMENT_PHASE_WAIT_TIMEOUT_MS) throw new DeploymentPhaseTimeoutError(this.timeoutDetails(phase, request));
        } catch (error) { queue.splice(index, 1); request.signal?.removeEventListener('abort', request.abort!); request.reject(error as Error); }
      }
      while (active.size < this.limits[phase] && queue.length) {
        const order = this.projectOrders.get(phase) || new ProjectAdmissionOrder();
        this.projectOrders.set(phase, order);
        const index = order.next(queue, request => request.owner.projectId,
          request => phase !== 'start' || this.memoryAllows(request.memoryMB, request.reservationKey)
            && this.pidsAllow(request) && this.cpuAllows(request));
        if (index < 0) break;
        const [request] = queue.splice(index, 1);
        request.signal?.removeEventListener('abort', request.abort!);
        active.add(request); order.grant(request.owner.projectId);
        if (phase === 'start' && request.reservationKey) {
          this.reserveKnownMemory(request.reservationKey, request.memoryMB, request.owner, request.pids);
          this.memoryReservations.get(request.reservationKey)!.startup = { check: request.check };
        }
        let released = false;
        request.resolve(() => { if (released) return; released = true; active.delete(request); this.pump(); });
      }
    }
    if (this.timer && ![...this.waiting.values()].some(queue => queue.length)) { clearInterval(this.timer); this.timer = undefined; }
  }

  async run<T>(phase: DeploymentPhase, owner: DeploymentPhaseOwner, task: () => Promise<T>,
    options: Parameters<DeploymentPhaseBudget['acquire']>[2] = {}): Promise<T> {
    const release = await this.acquire(phase, owner, options);
    try { options.check?.(); const result = await task(); options.check?.(); return result; } finally { release(); }
  }
}

export const deploymentPhaseBudget = new DeploymentPhaseBudget();

export function restoreDeploymentMemoryReservations(branches: readonly BranchEntry[], profiles: (branch: BranchEntry) => BuildProfile[]): void {
  for (const branch of branches) {
    const hints = new Map(profiles(branch).map(profile => [profile.id, profile.resources?.memoryMB || 512]));
    for (const service of Object.values(branch.services)) for (const runtime of serviceRuntimeRefs(service)) {
      // 失败替换仍可保留已经发布的旧版本；它和普通 running 服务一样，
      // 没有待兑现的启动承诺。不能因父服务 error 再恢复一份启动预约。
      // 这里只分类持久身份，不以异步内存采样抵扣，也不释放本进程任何预约。
      const published = service.status === 'error' && runtime.containerId
        && /^[a-f0-9]{64}$/.test(runtime.containerId)
        && service.servingRuntime?.containerName === runtime.containerName
        && service.servingRuntime.containerId === runtime.containerId
        && service.pendingRuntime?.containerName !== runtime.containerName;
      const incomplete = !published && runtime.creationIssued && (runtime === service ? service.status !== 'running'
        : runtime === service.pendingRuntime || !runtime.containerId);
      if (incomplete) deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, hints.get(service.profileId) || 512,
        { projectId: branch.projectId, branchId: branch.id, profileId: service.profileId }, 64, true);
    }
  }
}
