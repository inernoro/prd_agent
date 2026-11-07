import os from 'node:os';
import { readFile } from 'node:fs/promises';
import type { BranchEntry, BuildProfile, IShellExecutor, ServiceRuntimeRef } from '../types.js';
import { serviceRuntimeRefs } from './service-runtime.js';
import { ProjectAdmissionOrder } from './project-admission-order.js';
import { buildLoadPressure, buildGateStatus, registerJointBuildSlot, pumpWaiters as pumpBuildWaiters,
  type BuildLoadPressure, type BuildSlot, type AcquireOptions } from './build-gate.js';
import { HOST_LOAD_SATURATED_RATIO } from './control-plane-pressure.js';

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
export const DEPLOYMENT_PHASE_WAIT_TIMEOUT_MS = 20 * 60_000;
export interface DeploymentPhaseOwner { projectId?: string; branchId?: string; profileId?: string; operationId?: string | null; operationGeneration?: number }
export interface SourceStartAdmission {
  readonly buildSlot: BuildSlot;
  readonly consumed: boolean;
  take(key: string, owner: DeploymentPhaseOwner, memoryMB: number | undefined, check: () => void): () => void;
  dispose(): void;
}
interface Request {
  owner: DeploymentPhaseOwner; check?: () => void; signal?: AbortSignal;
  resolve: (release: () => void) => void; reject: (error: Error) => void;
  abort?: () => void; memoryMB: number; enqueuedAt: number; waitId: string;
  reservationKey?: string;
  pids: number;
  tryAcquireBuild?: () => boolean;
}

/** 阶段互不占槽；旧服务的物理占用已在可用内存内，新启动额外预留控制面余量。 */
export class DeploymentPhaseBudget {
  private nextWaitId = 0;
  private readonly active = new Map<DeploymentPhase, Set<Request>>();
  private readonly waiting = new Map<DeploymentPhase, Request[]>();
  private readonly projectOrders = new Map<DeploymentPhase, ProjectAdmissionOrder>();
  private readonly memoryReservations = new Map<string, { memoryMB: number; pids: number; owner: DeploymentPhaseOwner;
    startup?: { check?: () => void }; recovered?: boolean; containerId?: string }>();
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
        reason: phase === 'start' && !this.memoryAllows(request.memoryMB, request.reservationKey) ? 'memory-headroom'
          : phase === 'start' && !this.pidsAllow(request) ? 'pid-headroom'
          : phase === 'start' && !this.cpuAllows(request) ? 'cpu-startup-capacity'
          : phase === 'start' && request.tryAcquireBuild && (this.active.get(phase)?.size || 0) < this.limits[phase] ? 'build-capacity' : 'phase-capacity' })),
    }]));
  }

  /** 只观测真实、有界且资格仍有效的排队，不把执行中或已过期任务伪装成等待。 */
  waitingOperation(operationId: string, generation: number): { phase: DeploymentPhase; enqueuedAt: number; deadlineAt: number; waitId: string } | undefined {
    if (!operationId || !Number.isSafeInteger(generation) || generation < 1) return undefined;
    for (const [phase, queue] of this.waiting) for (const request of queue) {
      if (request.owner.operationId !== operationId || request.owner.operationGeneration !== generation
        || !request.check || request.signal?.aborted || Date.now() - request.enqueuedAt > DEPLOYMENT_PHASE_WAIT_TIMEOUT_MS) continue;
      try { request.check?.(); } catch { continue; }
      return { phase, enqueuedAt: request.enqueuedAt, deadlineAt: request.enqueuedAt + DEPLOYMENT_PHASE_WAIT_TIMEOUT_MS, waitId: request.waitId };
    }
    return undefined;
  }

  releaseMemory(key: string): void { this.memoryReservations.delete(key); this.pump(); }
  reserveKnownMemory(key: string, memoryMB: number, owner: DeploymentPhaseOwner, pids = 64, recovered = false, containerId?: string): void {
    this.memoryReservations.set(key, { memoryMB: Math.max(1, memoryMB || 512), pids: Math.max(1, pids || 64), owner, recovered,
      containerId: containerId && /^[a-f0-9]{64}$/.test(containerId) ? containerId : undefined });
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

  /** 真实盘点只释放同一份已终结预约；读取期间的新预约或在途创建不能被旧回执清掉。 */
  async reconcileMemoryReservations(unused: (key: string, owner: DeploymentPhaseOwner, containerId?: string) => Promise<boolean>,
    options: { recoveredOnly?: boolean; afterKey?: string } = {}): Promise<{ released: string[]; retained: string[] }> {
    const released: string[] = [], retained: string[] = [];
    const activeStart = (key: string) => [...(this.active.get('start') || [])].some(request => request.reservationKey === key);
    const candidates = [...this.memoryReservations].filter(([, reservation]) => !options.recoveredOnly || reservation.recovered);
    const after = candidates.findIndex(([key]) => key === options.afterKey);
    const ordered = after < 0 ? candidates : [...candidates.slice(after + 1), ...candidates.slice(0, after + 1)];
    for (const [key, reservation] of ordered) {
      let confirmed = false;
      if (!activeStart(key)) {
        try { confirmed = await unused(key, { ...reservation.owner }, reservation.containerId); } catch { /* 未确认仍保留 */ }
      }
      if (confirmed && this.memoryReservations.get(key) === reservation && !activeStart(key)) {
        this.releaseMemory(key); released.push(key);
      } else retained.push(key);
    }
    return { released, retained };
  }
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

  private cpuAllows(request: Request): boolean {
    // 历史物理责任不是本进程的启动体；资格失效只归还CPU占位，内存和PID仍须真实回收证明。
    const current = (check?: () => void) => { try { check?.(); return true; } catch { return false; } };
    const warming = [...this.memoryReservations].filter(([key, value]) => key !== request.reservationKey
      && value.startup && current(value.startup.check)).length
      + [...(this.active.get('start') || [])].filter(item => !item.reservationKey && current(item.check)).length;
    const pressure = this.hostLoad();
    const limit = pressure.ratio >= HOST_LOAD_SATURATED_RATIO ? 1 : this.limits.start;
    return warming < limit;
  }
  private startAllows(request: Request): boolean {
    return this.memoryAllows(request.memoryMB, request.reservationKey) && this.pidsAllow(request) && this.cpuAllows(request);
  }

  acquire(phase: DeploymentPhase, owner: DeploymentPhaseOwner, options: {
    check?: () => void; signal?: AbortSignal; memoryMB?: number; reservationKey?: string; pids?: number;
    /** 仅在启动资源均可授予时同步取得配套构建槽，失败仍留队且不占启动资源。 */
    tryAcquireBuild?: () => boolean;
  } = {}): Promise<() => void> {
    try { options.check?.(); } catch (error) { return Promise.reject(error); }
    if (options.signal?.aborted) return Promise.reject(new Error('部署阶段等待已取消'));
    const waiting = this.waiting.get(phase) || [];
    if (waiting.length >= 64) return Promise.reject(new Error('部署阶段等待已满，请稍后重试；旧服务保持可用'));
    this.waiting.set(phase, waiting);
    return new Promise((resolve, reject) => {
      const request: Request = { owner, check: options.check, signal: options.signal, resolve, reject,
        memoryMB: phase === 'start' ? Math.max(1, options.memoryMB || 512) : 0, pids: phase === 'start' ? Math.max(1, options.pids || 64) : 0,
        enqueuedAt: Date.now(), reservationKey: options.reservationKey, waitId: String(++this.nextWaitId),
        tryAcquireBuild: phase === 'start' ? options.tryAcquireBuild : undefined };
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

  /** 只供首次源码启动；编译与启动一起授予，已有服务仍沿原编译排队保护。 */
  async acquireSourceStart(owner: DeploymentPhaseOwner, key: string,
    buildOptions: AcquireOptions,
    options: { check?: () => void; signal?: AbortSignal; memoryMB?: number } = {}): Promise<SourceStartAdmission> {
    const capturedOwner = { ...owner };
    let buildSlot: BuildSlot | undefined, queueError: unknown;
    let currentCheck = () => {
      if (queueError !== undefined) throw queueError;
      options.check?.();
      if (options.signal?.aborted || buildOptions.signal?.aborted || buildOptions.isCancelled?.()) throw new Error('部署阶段等待已取消');
    };
    let tryBuild!: () => boolean;
    const registration = registerJointBuildSlot({ ...buildOptions, holder: buildOptions.holder
      ?? { ...capturedOwner, operationId: capturedOwner.operationId ?? undefined } }, () => {
      if (!tryBuild) return false;
      try { currentCheck(); } catch { return false; }
      const queue = this.waiting.get('start') || [], index = queue.findIndex(request => request.tryAcquireBuild === tryBuild);
      if (index < 0 || (this.active.get('start')?.size || 0) >= this.limits.start || !this.startAllows(queue[index])) return false;
      return !queue.slice(0, index).some(prior => (prior.owner.projectId || '_unknown') === (capturedOwner.projectId || '_unknown')
        && (!prior.tryAcquireBuild || this.startAllows(prior)));
    });
    tryBuild = () => {
      if (this.memoryReservations.has(key)) throw new Error('首次启动身份已有物理预约，请先核对原运行状态');
      buildSlot = registration.tryAcquire(); return !!buildSlot;
    };
    const enqueuedAt = Date.now(), pending = this.acquire('start', capturedOwner,
      { ...options, reservationKey: key, check: () => currentCheck(), tryAcquireBuild: tryBuild });
    let queued = false, queueEnded = false, releaseStart: (() => void) | undefined, memoryCleanup: (() => boolean) | undefined;
    const finishQueue = () => { if (queued && !queueEnded) { queueEnded = true; buildOptions.onStart?.({ waitedMs: Date.now() - enqueuedAt }); } };
    try {
      if (!buildSlot) { queued = true; const status = buildGateStatus();
        buildOptions.onQueued?.({ ahead: Math.max(0, status.queued - 1), active: status.active, max: status.max }); }
      const release = await pending; releaseStart = release;
      const reservation = this.memoryReservations.get(key), releaseMemory = this.captureMemoryRelease(key, capturedOwner);
      memoryCleanup = releaseMemory; finishQueue(); currentCheck();
      let consumed = false, disposed = false;
      const dispose = () => { if (disposed) return; disposed = true; release(); if (!consumed) releaseMemory(); buildSlot!.release(); };
      return { buildSlot: buildSlot!, get consumed() { return consumed; }, dispose,
        take: (actualKey, actualOwner, memoryMB, check) => {
          if (disposed || consumed || actualKey !== key || this.memoryReservations.get(key) !== reservation
            || Math.max(1, memoryMB || 512) !== reservation?.memoryMB
            || (['projectId', 'branchId', 'profileId', 'operationId', 'operationGeneration'] as const)
              .some(field => actualOwner[field] !== capturedOwner[field])) throw new Error('首次启动准入身份或资源已变化');
          const priorCheck = currentCheck; currentCheck = () => { priorCheck(); check(); };
          currentCheck(); consumed = true; return release;
        } };
    } catch (error) {
      queueError = error; this.pump();
      releaseStart ??= await pending.catch(() => undefined);
      if (releaseStart && !memoryCleanup) memoryCleanup = this.captureMemoryRelease(key, capturedOwner);
      releaseStart?.(); memoryCleanup?.(); buildSlot?.release();
      // 未获准入不得触发成功 onStart；原路由异常收尾负责结清队列显示。
      throw error;
    } finally { registration.dispose(); }
  }

  pump(): void {
    for (const [phase, queue] of this.waiting) {
      const active = this.active.get(phase) || new Set<Request>(); this.active.set(phase, active);
      for (let index = queue.length - 1; index >= 0; index--) {
        const request = queue[index];
        try { request.check?.(); if (request.signal?.aborted) throw new Error('部署阶段等待已取消');
          if (Date.now() - request.enqueuedAt > DEPLOYMENT_PHASE_WAIT_TIMEOUT_MS) throw new Error('部署阶段等待超时，旧服务保持可用');
        } catch (error) { queue.splice(index, 1); request.signal?.removeEventListener('abort', request.abort!); request.reject(error as Error); }
      }
      const unavailable = new Set<Request>();
      while (active.size < this.limits[phase] && queue.length) {
        const order = this.projectOrders.get(phase) || new ProjectAdmissionOrder();
        this.projectOrders.set(phase, order);
        // 联合准入尚缺物理资源或本轮确认缺编译槽时，不挡同项目已持编译槽的更新。
        // 普通请求和其余合格请求仍沿原项目轮转与项目内部顺序，避免半份资源相互等待。
        const eligible = (request: Request) => phase !== 'start' || this.startAllows(request);
        const available = queue.filter(request => !unavailable.has(request) && (!request.tryAcquireBuild || eligible(request)));
        const eligibleIndex = order.next(available, request => request.owner.projectId, eligible);
        if (eligibleIndex < 0) break;
        const candidate = available[eligibleIndex], index = queue.indexOf(candidate);
        try {
          if (candidate.tryAcquireBuild && !candidate.tryAcquireBuild()) { unavailable.add(candidate); continue; }
        } catch (error) {
          queue.splice(index, 1); candidate.signal?.removeEventListener('abort', candidate.abort!); candidate.reject(error as Error); continue;
        }
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
    pumpBuildWaiters();
  }

  async run<T>(phase: DeploymentPhase, owner: DeploymentPhaseOwner, task: () => Promise<T>,
    options: Parameters<DeploymentPhaseBudget['acquire']>[2] = {}): Promise<T> {
    const release = await this.acquire(phase, owner, options);
    try { options.check?.(); const result = await task(); options.check?.(); return result; } finally { release(); }
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
      if (runtime.staticWeb || runtime.runtimeKind === 'static') continue;
      const serving = service.servingRuntime;
      if (serving?.containerId && /^[a-f0-9]{64}$/.test(serving.containerId)
        && serving.containerName === runtime.containerName && serving.containerId === runtime.containerId) continue;
      const incomplete = runtime.creationIssued && (runtime === service ? service.status !== 'running'
        : runtime === service.pendingRuntime || !runtime.containerId);
      if (incomplete) candidates.push({ branch, profileId: service.profileId, runtime, memoryMB: hints.get(service.profileId) || 512 });
    }
  }
  // A stopped immutable container cannot consume a startup reservation. Verify its
  // identity and terminal Docker state without changing the retained runtime or container.
  const receipts = new Map<string, { status: string; project: string; branch: string; profile: string }>();
  const absentIds = new Set<string>();
  const ids = [...new Set(candidates.map(item => item.runtime.containerId).filter((id): id is string => !!id && /^[a-f0-9]{64}$/.test(id)))].slice(0, 64);
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
      if (result.exitCode !== 0) for (const match of result.stderr.matchAll(/No such (?:container|object):\s*([a-f0-9]{64})\b/gi)) {
        if (ids.includes(match[1]) && !receipts.has(match[1])) absentIds.add(match[1]);
      }
    } catch { /* Unavailable Docker is unknown, not evidence of a stopped runtime. */ }
  }
  for (const { branch, profileId, runtime, memoryMB } of candidates) {
    const receipt = runtime.containerId ? receipts.get(runtime.containerId) : undefined;
    const stopped = receipt && ['exited', 'dead'].includes(receipt.status)
      && receipt.project === (branch.projectId || '_unknown') && receipt.branch === branch.id && receipt.profile === profileId;
    if (!stopped && !(runtime.containerId && absentIds.has(runtime.containerId))) budget.reserveKnownMemory(runtime.containerName, memoryMB,
      { projectId: branch.projectId, branchId: branch.id, profileId }, 64, true, runtime.containerId);
  }
}
