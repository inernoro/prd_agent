import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { launchObservationProcess } from './observation-process-launcher.js';
import { cleanObservationGroup, findObservationOwners } from './observation-process-group.js';
import type { ExecOptions, ExecResult, IShellExecutor } from '../types.js';

type FailureCode = 'capacity' | 'deadline' | 'cancelled' | 'unavailable' | 'closed' | 'callback' | 'cleanup';
type PoolFailureReason = 'startup-deadline' | 'process-error' | 'process-exit' | 'ipc-send' | 'process-create' | 'factory-fatal';
interface PoolFailure { reason: PoolFailureReason; phase: 'startup' | 'runtime'; at: string; elapsedMs: number; generation: number; supervisorPid?: number; factoryPid?: number; actors: number; actorPids: number[]; readyActors: number }
interface PoolLifecycle {
  startedAt?: string;
  readyAt?: string;
  readyElapsedMs?: number;
  readyGeneration?: number;
  startupFailure?: PoolFailure;
  failure?: PoolFailure;
}
const messages: Record<FailureCode, string> = {
  capacity: '状态查询繁忙，请稍后重试。', deadline: '状态查询超时，请稍后重试。',
  cancelled: '状态查询已取消。', unavailable: '状态查询执行器暂不可用，请稍后重试。',
  cleanup: '状态查询进程清理尚未确认，请稍后重试。', closed: '状态查询执行器已关闭。', callback: '状态查询输出处理失败，请稍后重试。',
};
export class ObservationExecutionError extends Error {
  constructor(readonly code: FailureCode) { super(messages[code]); this.name = 'ObservationExecutionError'; }
}
export class OperationExecutionError extends ObservationExecutionError {
  constructor(code: FailureCode) {
    super(code); this.name = 'OperationExecutionError';
    this.message = code === 'deadline' ? '任务执行超时，请核对实际结果后再继续。'
      : code === 'cleanup' ? '任务进程清理尚未确认，请核对实际状态后再继续。'
        : messages[code].replaceAll('状态查询执行器', '任务执行器').replaceAll('状态查询', '任务执行');
  }
}
interface Job {
  id: number;
  command: string;
  options: { cwd?: string; stdin?: string; env: NodeJS.ProcessEnv; stream: boolean; captureOutput: boolean };
  onData?: ExecOptions['onData'];
  beforeStart?: ExecOptions['beforeStart'];
  onAssigned?: ExecOptions['onAssigned'];
  startError?: unknown;
  startRejected?: boolean;
  cleanup: boolean;
  bytes: number;
  dataTail: Promise<void>;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
  failure?: FailureCode;
  active: boolean;
  resolve: (result: ExecResult) => void;
  reject: (error: unknown) => void;
}

/** 按指定通道隔离进程；操作槽在实际派发前向控制面重新取得资格，函数不传入actor。 */
export class IsolatedShellExecutor implements IShellExecutor {
  private factory?: ChildProcess;
  private factoryExit?: Promise<void>;
  private factoryProcessPid?: number;
  private factoryGeneration = 0;
  private factoryMetrics?: { rss: number; heapLimit: number };
  private supervisorMetrics?: { rss: number; heapLimit: number };
  private readonly supervised: boolean;
  private ready = false;
  private unavailable = false;
  private failed = false;
  private closed = false;
  private nextId = 0;
  private readonly owner = `cds-observation-${randomBytes(16).toString('hex')}`;
  private readonly actors = new Map<number, { pid: number; metrics?: { rss: number; heapLimit: number } }>();
  private readonly jobs = new Map<number, Job>();
  private readonly queue: Job[] = [];
  private active = 0;
  private activeCleanup = 0;
  private bytes = 0;
  private cleanupBytes = 0;
  private starting?: Promise<void>;
  private startResolve?: () => void;
  private startReject?: (error: ObservationExecutionError) => void;
  private startTimer?: NodeJS.Timeout;
  private startedMonotonic = 0;
  private readonly lifecycle: PoolLifecycle = {};
  private startupRestartTargetGeneration?: number;
  private startupCleanedGeneration = 0;
  private stopping?: Promise<void>;
  private closing?: Promise<void>;
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly maxBytes: number;
  private readonly processFactory: (owner: string) => ChildProcess;
  private readonly isolatedLane: 'observation' | 'operation';
  private readonly defaultTimeoutMs: number;
  private readonly reservedCleanup: number;
  private readonly reservedCleanupBytes: number;

  constructor(private readonly operation: IShellExecutor, config: {
    concurrency?: number; maxQueued?: number; maxBytes?: number; processFactory?: (owner: string) => ChildProcess;
    isolatedLane?: 'observation' | 'operation'; defaultTimeoutMs?: number; reservedCleanup?: number; reservedCleanupBytes?: number;
  } = {}) {
    this.concurrency = config.concurrency ?? 2;
    this.maxQueued = config.maxQueued ?? 64;
    this.maxBytes = config.maxBytes ?? 16 * 1024 * 1024;
    this.isolatedLane = config.isolatedLane ?? 'observation';
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 30_000;
    this.reservedCleanup = config.reservedCleanup ?? 0;
    this.reservedCleanupBytes = config.reservedCleanupBytes ?? (this.reservedCleanup > 0 ? Math.min(256 * 1024, Math.floor(this.maxBytes / 4)) : 0);
    if (!Number.isSafeInteger(this.reservedCleanup) || this.reservedCleanup < 0 || this.reservedCleanup >= this.concurrency ||
      (this.reservedCleanup > 0 && this.isolatedLane !== 'operation')) throw new Error('Invalid cleanup reservation');
    for (const n of [this.concurrency, this.maxQueued, this.maxBytes, this.defaultTimeoutMs]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid observation executor capacity');
    }
    if (this.concurrency > 16) throw new Error('Invalid observation executor capacity');
    if (!Number.isSafeInteger(this.reservedCleanupBytes) || (this.reservedCleanup > 0
      ? this.maxQueued <= this.reservedCleanup || this.reservedCleanupBytes < 1 || this.reservedCleanupBytes >= this.maxBytes
      : this.reservedCleanupBytes !== 0)) throw new Error('Invalid cleanup admission reservation');
    this.supervised = !config.processFactory;
    this.processFactory = config.processFactory ?? (owner => launchObservationProcess('observation-supervisor-process', owner));
  }
  private executionError(code: FailureCode): ObservationExecutionError {
    return this.isolatedLane === 'operation' ? new OperationExecutionError(code) : new ObservationExecutionError(code);
  }

  /** 启动时在大状态加载前预热。常规查询和替换查询进程不再由 Master 创建子进程。 */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(this.executionError('closed'));
    if (this.unavailable) return Promise.reject(this.executionError('unavailable'));
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    this.startedMonotonic = performance.now();
    this.lifecycle.startedAt = new Date().toISOString();
    this.starting = new Promise((resolve, reject) => { this.startResolve = resolve; this.startReject = reject; });
    this.startTimer = setTimeout(() => { void this.initialStartTimedOut(); }, 5000);
    try {
      const child = this.processFactory(this.owner);
      this.factory = child;
      this.factoryExit = new Promise(resolve => child.once('close', () => resolve()));
      child.on('message', (message: any) => this.onMessage(message));
      child.on('error', () => { void this.failPool('process-error'); });
      child.on('exit', () => { if (!this.closed && !this.stopping) void this.failPool('process-exit'); });
      child.send({ type: 'initialize', concurrency: this.concurrency }, error => { if (error && !this.stopping) void this.failPool('ipc-send'); });
    } catch { void this.failPool('process-create'); }
    return this.starting;
  }

  /** 复用既有操作池；缺少操作隔离能力就拒绝，不占健康池或委托原生Shell。 */
  execBackgroundObservation(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (this.closed) return Promise.reject(this.executionError('closed'));
    if (this.isolatedLane === 'operation') {
      return this.exec(command, { ...options, executionLane: 'operation', executionPurpose: undefined });
    }
    if (this.operation.execBackgroundObservation) {
      return this.operation.execBackgroundObservation(command, { ...options, executionPurpose: undefined });
    }
    return Promise.reject(this.executionError('unavailable'));
  }

  execOwnedOperation(command: string, options: ExecOptions & { beforeStart: () => void }): Promise<ExecResult> {
    if (this.isolatedLane === 'operation') return this.exec(command, { ...options, executionLane: 'operation' });
    return this.operation.execOwnedOperation
      ? this.operation.execOwnedOperation(command, options) : Promise.reject(this.executionError('unavailable'));
  }
  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if ((options?.executionLane ?? 'operation') !== this.isolatedLane) return this.operation.exec(command, options);
    options ??= {};
    if (this.closed) return Promise.reject(this.executionError('closed'));
    if (this.unavailable) return Promise.reject(this.executionError('unavailable'));
    if (options.signal?.aborted) return Promise.reject(this.executionError('cancelled'));
    // 尚未提供资格复核的旧操作不能在资格检查后暗中等槽。明确拒绝，交由业务阶段准入重试。
    const cleanup = this.isolatedLane === 'operation' && this.reservedCleanup > 0 && options.executionPurpose === 'temporary-cleanup';
    if (this.isolatedLane === 'operation' && !cleanup && !options.beforeStart &&
      (!this.ready || this.active - this.activeCleanup >= [...this.actors.values()].filter(actor => actor.metrics).length - this.reservedCleanup)) {
      return Promise.reject(this.executionError('capacity'));
    }
    const wireOptions = { cwd: options.cwd, stdin: options.stdin, env: { ...process.env, ...options.env }, stream: !!options.onData, captureOutput: options.captureOutput !== false };
    const bytes = Buffer.byteLength(command) + Buffer.byteLength(JSON.stringify(wireOptions));
    if (this.queue.length >= this.maxQueued || this.bytes + bytes > this.maxBytes) return Promise.reject(this.executionError('capacity'));
    if (this.reservedCleanup > 0) {
      const queuedCleanup = this.queue.filter(job => job.cleanup).length;
      // 仍使用原总上限；普通任务不能占用清理的等待名额或输入字节，清理自身也有硬限。
      if (cleanup
        ? queuedCleanup >= this.reservedCleanup || this.cleanupBytes + bytes > this.reservedCleanupBytes
        : this.queue.length - queuedCleanup >= this.maxQueued - this.reservedCleanup ||
          this.bytes - this.cleanupBytes + bytes > this.maxBytes - this.reservedCleanupBytes) {
        return Promise.reject(this.executionError('capacity'));
      }
    }
    const continuous = options.captureOutput === false && options.timeout === 0 && !!options.signal && !!options.onData;
    const timeout = continuous ? Infinity : options.timeout && Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const job: Job = { id, command, options: wireOptions, onData: options.onData, beforeStart: options.beforeStart, onAssigned: options.onAssigned, cleanup, bytes, dataTail: Promise.resolve(), active: false,
        deadline: performance.now() + timeout, timer: continuous ? undefined : setTimeout(() => this.cancel(id, 'deadline'), Math.min(timeout, 2_147_483_647)), signal: options.signal, resolve, reject };
      if (job.signal) { job.abort = () => this.cancel(id, 'cancelled'); job.signal.addEventListener('abort', job.abort, { once: true }); }
      this.jobs.set(id, job); this.queue.push(job); this.bytes += bytes; if (cleanup) this.cleanupBytes += bytes;
      this.refPool();
      void this.start().catch(() => {});
      this.drain();
    });
  }

  getStats(): { active: number; activeCleanup: number; reservedCleanup: number; reservedCleanupBytes: number; maxQueued: number; maxBytes: number; queued: number; queuedCleanup: number; bytes: number; cleanupBytes: number; unavailable: boolean; factoryPid?: number; supervisorPid?: number; factoryMetrics?: { rss: number; heapLimit: number }; supervisorMetrics?: { rss: number; heapLimit: number }; actors: Array<{ pid: number; rss?: number; heapLimit?: number }> } {
    return { active: this.active, activeCleanup: this.activeCleanup, reservedCleanup: this.reservedCleanup, reservedCleanupBytes: this.reservedCleanupBytes,
      maxQueued: this.maxQueued, maxBytes: this.maxBytes, queued: this.queue.length, queuedCleanup: this.queue.filter(job => job.cleanup).length,
      bytes: this.bytes, cleanupBytes: this.cleanupBytes, unavailable: this.unavailable, factoryPid: this.supervised ? this.factoryProcessPid : this.factory?.pid, supervisorPid: this.supervised ? this.factory?.pid : undefined,
      factoryMetrics: this.factoryMetrics, supervisorMetrics: this.supervisorMetrics, actors: [...this.actors.values()].map(actor => ({ pid: actor.pid, ...actor.metrics })) };
  }

  private onMessage(message: any): void {
    if (this.supervised) {
      if (message.type === 'factory-started') {
        if (!Number.isSafeInteger(message.generation) || message.generation <= this.factoryGeneration || !Number.isSafeInteger(message.pid) || message.pid <= 1) return;
        this.factoryGeneration = message.generation; this.factoryProcessPid = message.pid; this.supervisorMetrics = message.supervisorMetrics; this.factoryMetrics = undefined;
        return;
      }
      // 首代started尚未被观察时也可确认它已清理；只记水位，不清理新代状态。
      if (message.type === 'factory-cleaned' && Number.isSafeInteger(message.generation)
        && (message.generation === 1 || message.generation === this.factoryGeneration)) {
        this.startupCleanedGeneration = Math.max(this.startupCleanedGeneration, message.generation);
      }
      if (message.generation !== this.factoryGeneration) return;
      if (message.factoryMetrics) this.factoryMetrics = message.factoryMetrics;
      if (message.type === 'factory-resetting') { this.ready = false; this.unavailable = true; return; }
      if (message.type === 'factory-cleaned') {
        this.actors.clear(); this.factoryProcessPid = undefined; this.factoryMetrics = undefined; this.supervisorMetrics = message.supervisorMetrics;
        for (const job of [...this.jobs.values()]) this.finish(job, undefined, 'unavailable');
        return;
      }
    }
    if (message.type === 'actor' && Number.isInteger(message.pid) && message.pid > 1 && message.pid !== process.pid) {
      this.actors.set(message.index, { pid: message.pid });
      if (!this.closed && (!this.unavailable || this.supervised && !this.failed && !this.stopping)) this.send({ type: 'actor-registered', index: message.index, pid: message.pid });
      return;
    }
    if (message.type === 'actor-exited') {
      if (this.actors.get(message.index)?.pid === message.pid) this.actors.delete(message.index);
      return;
    }
    if (message.type === 'actor-ready') {
      const actor = this.actors.get(message.index);
      if (actor && actor.pid === message.pid) actor.metrics = message.metrics;
      return;
    }
    if (message.type === 'fatal') { void this.failPool('factory-fatal'); return; }
    if (message.type === 'ready' && !this.closed && (!this.unavailable || this.supervised && !this.failed && !this.stopping)
      && (!this.supervised || this.startupRestartTargetGeneration === undefined
        || this.factoryGeneration > this.startupRestartTargetGeneration && this.startupCleanedGeneration >= this.startupRestartTargetGeneration)) {
      const recoveredInitialStart = !!this.lifecycle.startupFailure && !this.lifecycle.readyAt;
      this.lifecycle.readyAt ??= new Date().toISOString();
      this.lifecycle.readyElapsedMs ??= Math.round(performance.now() - this.startedMonotonic);
      this.lifecycle.readyGeneration ??= this.factoryGeneration;
      this.unavailable = false;
      this.ready = true; clearTimeout(this.startTimer); this.startResolve?.(); this.drain();
      if (recoveredInitialStart) console.log(`[execution-pool-recovered] ${JSON.stringify({ lifecycle: this.getLifecycle(), stats: this.getStats() })}`);
      return;
    }
    const job = this.jobs.get(message.id);
    if (!job?.active) return;
    if (message.type === 'assigned') {
      if (this.isolatedLane !== 'operation' && !job.beforeStart) return;
      if (job.failure) return;
      if (job.deadline <= performance.now() || job.signal?.aborted) { this.cancel(job.id, job.signal?.aborted ? 'cancelled' : 'deadline'); return; }
      try {
        const registeredActor = [...this.actors.values()].some(actor => actor.pid === message.pid);
        job.onAssigned?.({ jobId: job.id, factoryGeneration: this.supervised ? this.factoryGeneration : null,
          factoryPid: this.supervised ? this.factoryProcessPid ?? null : this.factory?.pid ?? null,
          actorPid: registeredActor ? message.pid : null, lane: this.isolatedLane });
        job.beforeStart?.();
      }
      catch (error) { job.startRejected = true; job.startError = error; this.cancel(job.id, 'cancelled'); return; }
      if (job.failure) return;
      if (job.deadline <= performance.now() || job.signal?.aborted) { this.cancel(job.id, job.signal?.aborted ? 'cancelled' : 'deadline'); return; }
      this.send({ type: 'authorize', id: job.id });
    } else if (message.type === 'data') {
      job.dataTail = job.dataTail.then(async () => {
        if (!job.failure) await job.onData?.(message.chunk, message.channel);
        this.send({ type: 'ack', id: job.id, bytes: message.bytes });
      }).catch(() => { this.cancel(job.id, 'callback'); });
    } else if (message.type === 'result') {
      const actor = [...this.actors.values()].find(actor => actor.pid === message.pid);
      if (actor) actor.metrics = message.metrics;
      void job.dataTail.then(() => this.finish(job, message.result));
    } else if (message.type === 'cancelled') this.finish(job, undefined, job.failure ?? 'unavailable');
  }

  private send(message: object): void {
    if (this.factory?.connected) this.factory.send(message, error => { if (error && !this.stopping) void this.failPool('ipc-send'); });
  }
  private refPool(): void { this.factory?.ref(); this.factory?.channel?.ref(); }
  private drain(): void {
    if (!this.ready || !this.factory || this.closed || this.unavailable) return;
    while (this.active < this.concurrency && this.queue.length) {
      const index = this.queue.findIndex(job => job.cleanup ? this.activeCleanup < this.reservedCleanup : this.active - this.activeCleanup < this.concurrency - this.reservedCleanup);
      if (index < 0) break;
      const job = this.queue.splice(index, 1)[0];
      if (job.deadline <= performance.now()) { this.finish(job, undefined, 'deadline'); continue; }
      job.active = true; this.active++; if (job.cleanup) this.activeCleanup++; this.refPool();
      this.send({ type: 'exec', id: job.id, command: job.command, options: job.options,
        requireAuthorization: this.isolatedLane === 'operation' || !!job.beforeStart });
    }
    if (!this.jobs.size) { this.factory.unref(); this.factory.channel?.unref(); }
  }
  private cancel(id: number, code: FailureCode): void {
    const job = this.jobs.get(id); if (!job) return;
    job.failure ??= code;
    if (!job.active) this.finish(job, undefined, job.failure);
    else this.send({ type: 'cancel', id });
  }
  private finish(job: Job, result?: ExecResult, failure?: FailureCode): void {
    if (!this.jobs.delete(job.id)) return;
    clearTimeout(job.timer); if (job.abort) job.signal?.removeEventListener('abort', job.abort);
    if (job.active) { this.active--; if (job.cleanup) this.activeCleanup--; } else { const i = this.queue.indexOf(job); if (i >= 0) this.queue.splice(i, 1); }
    this.bytes -= job.bytes;
    if (job.cleanup) this.cleanupBytes -= job.bytes;
    const error = failure === 'cleanup' ? failure : job.failure ?? failure;
    if (error === 'cleanup') job.reject(this.executionError(error));
    else if (job.startRejected) job.reject(job.startError);
    else if (error) job.reject(this.executionError(error)); else job.resolve(result!);
    this.drain();
  }

  private stopPool(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.ready = false; clearTimeout(this.startTimer);
    // 空闲池已 unref。关停确认必须重新持有句柄，否则独立 CLI 会在 close/回执前退出0。
    this.refPool();
    this.stopping = (async () => {
      const groups = new Set([...this.actors.values()].map(actor => actor.pid));
      if (this.factory?.pid) groups.add(this.factory.pid);
      if (this.factoryProcessPid) groups.add(this.factoryProcessPid);
      for (const pid of groups) { try { process.kill(-pid, 'SIGKILL'); } catch { /* 下面确认清理 */ } }
      await this.factoryExit;
      // 创建回执尚未送达的启动进程不能承接任务；仍按私有归属找回并清理。
      for (let pass = 0; pass < 2; pass++) {
        for (const owned of await findObservationOwners(this.owner)) {
          if (owned.pid === process.pid || owned.pid <= 1) throw new Error('Invalid observation process owner');
          if (owned.pid === owned.group) groups.add(owned.group);
          try { process.kill(owned.pid, 'SIGKILL'); } catch { /* 后续进程组确认 */ }
        }
        await Promise.all([...groups].map(group => cleanObservationGroup(group)));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      this.actors.clear();
    })();
    return this.stopping;
  }
  private recordPoolFailure(reason: PoolFailureReason): void {
    // 清理前保存有限元数据，绝不记录命令、环境、输入或原始异常正文。
    this.lifecycle.failure = { reason, phase: this.lifecycle.readyAt ? 'runtime' : 'startup', at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - this.startedMonotonic), generation: this.factoryGeneration,
      supervisorPid: this.supervised ? this.factory?.pid : undefined,
      factoryPid: this.supervised ? this.factoryProcessPid : this.factory?.pid,
      actors: this.actors.size, actorPids: [...this.actors.values()].map(actor => actor.pid),
      readyActors: [...this.actors.values()].filter(actor => actor.metrics).length };
    if (!this.lifecycle.readyAt) this.lifecycle.startupFailure ??= this.lifecycle.failure;
  }
  private async initialStartTimedOut(): Promise<void> {
    if (!this.supervised) return this.failPool('startup-deadline');
    if (this.closed || this.failed || this.ready) return;
    // 原首次5秒照常失败；旧请求不重放。保留预热监督者清理旧代并按原恢复预算替换工厂。
    this.recordPoolFailure('startup-deadline');
    // initialize的首代固定为1；迟到回调不能把恢复目标重新解析成当前替换代。
    this.startupRestartTargetGeneration = 1;
    this.ready = false; this.unavailable = true;
    this.startReject?.(this.executionError('unavailable'));
    for (const job of [...this.jobs.values()]) this.finish(job, undefined, 'unavailable');
    this.send({ type: 'restart-after-startup-deadline', generation: this.startupRestartTargetGeneration });
  }
  private async failPool(reason: PoolFailureReason): Promise<void> {
    if (this.failed) return;
    this.recordPoolFailure(reason);
    this.failed = true; this.unavailable = true;
    let code: FailureCode = 'unavailable';
    try { await this.stopPool(); } catch { code = 'cleanup'; }
    this.startReject?.(this.executionError(code));
    for (const job of [...this.jobs.values()]) this.finish(job, undefined, code);
  }
  getLifecycle(): PoolLifecycle {
    const copy = (value?: PoolFailure): PoolFailure | undefined => value ? { ...value, actorPids: [...value.actorPids] } : undefined;
    return { ...this.lifecycle, failure: copy(this.lifecycle.failure), startupFailure: copy(this.lifecycle.startupFailure) };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const job of [...this.jobs.values()]) { job.failure ??= 'closed'; if (!job.active) this.finish(job, undefined, 'closed'); }
    this.closing = (async () => {
      let failure: FailureCode = 'closed';
      try { await this.stopPool(); } catch { failure = 'cleanup'; }
      this.startReject?.(this.executionError(failure));
      for (const job of [...this.jobs.values()]) this.finish(job, undefined, failure);
      if (failure === 'cleanup') throw this.executionError('cleanup');
    })();
    return this.closing;
  }
}
