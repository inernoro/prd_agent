import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { launchObservationProcess } from './observation-process-launcher.js';
import { cleanObservationGroup, findObservationOwners } from './observation-process-group.js';
import type { ExecOptions, ExecResult, IShellExecutor } from '../types.js';

type FailureCode = 'capacity' | 'deadline' | 'cancelled' | 'unavailable' | 'closed' | 'callback' | 'cleanup';
const messages: Record<FailureCode, string> = {
  capacity: '状态查询繁忙，请稍后重试。', deadline: '状态查询超时，请稍后重试。',
  cancelled: '状态查询已取消。', unavailable: '状态查询执行器暂不可用，请稍后重试。',
  cleanup: '状态查询进程清理尚未确认，请稍后重试。', closed: '状态查询执行器已关闭。', callback: '状态查询输出处理失败，请稍后重试。',
};
export class ObservationExecutionError extends Error {
  constructor(readonly code: FailureCode) { super(messages[code]); this.name = 'ObservationExecutionError'; }
}
interface Job {
  id: number;
  command: string;
  options: { cwd?: string; stdin?: string; env: NodeJS.ProcessEnv; stream: boolean };
  onData?: (chunk: string) => void;
  bytes: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
  failure?: FailureCode;
  active: boolean;
  resolve: (result: ExecResult) => void;
  reject: (error: ObservationExecutionError) => void;
}

/** 显式观测由独立小进程执行；默认操作保留已有资格检查与执行顺序。 */
export class IsolatedShellExecutor implements IShellExecutor {
  private factory?: ChildProcess;
  private factoryExit?: Promise<void>;
  private ready = false;
  private unavailable = false;
  private closed = false;
  private nextId = 0;
  private readonly owner = `cds-observation-${randomBytes(16).toString('hex')}`;
  private readonly actors = new Map<number, { pid: number; metrics?: { rss: number; heapLimit: number } }>();
  private readonly jobs = new Map<number, Job>();
  private readonly queue: Job[] = [];
  private active = 0;
  private bytes = 0;
  private starting?: Promise<void>;
  private startResolve?: () => void;
  private startReject?: (error: ObservationExecutionError) => void;
  private startTimer?: NodeJS.Timeout;
  private stopping?: Promise<void>;
  private closing?: Promise<void>;
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly maxBytes: number;
  private readonly processFactory: (owner: string) => ChildProcess;

  constructor(private readonly operation: IShellExecutor, config: {
    concurrency?: number; maxQueued?: number; maxBytes?: number; processFactory?: (owner: string) => ChildProcess;
  } = {}) {
    this.concurrency = config.concurrency ?? 2;
    this.maxQueued = config.maxQueued ?? 64;
    this.maxBytes = config.maxBytes ?? 16 * 1024 * 1024;
    for (const n of [this.concurrency, this.maxQueued, this.maxBytes]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid observation executor capacity');
    }
    if (this.concurrency > 16) throw new Error('Invalid observation executor capacity');
    this.processFactory = config.processFactory ?? (owner => launchObservationProcess('observation-executor-process', owner));
  }

  /** 启动时在大状态加载前预热。常规查询和替换查询进程不再由 Master 创建子进程。 */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new ObservationExecutionError('closed'));
    if (this.unavailable) return Promise.reject(new ObservationExecutionError('unavailable'));
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => { this.startResolve = resolve; this.startReject = reject; });
    this.startTimer = setTimeout(() => { void this.failPool(); }, 5000);
    try {
      const child = this.processFactory(this.owner);
      this.factory = child;
      this.factoryExit = new Promise(resolve => child.once('close', () => resolve()));
      child.on('message', (message: any) => this.onMessage(message));
      child.on('error', () => { void this.failPool(); });
      child.on('exit', () => { if (!this.closed && !this.stopping) void this.failPool(); });
      child.send({ type: 'initialize', concurrency: this.concurrency }, error => { if (error && !this.stopping) void this.failPool(); });
    } catch { void this.failPool(); }
    return this.starting;
  }

  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (options?.executionLane !== 'observation') return this.operation.exec(command, options);
    if (this.closed) return Promise.reject(new ObservationExecutionError('closed'));
    if (this.unavailable) return Promise.reject(new ObservationExecutionError('unavailable'));
    if (options.signal?.aborted) return Promise.reject(new ObservationExecutionError('cancelled'));
    const wireOptions = { cwd: options.cwd, stdin: options.stdin, env: { ...process.env, ...options.env }, stream: !!options.onData };
    const bytes = Buffer.byteLength(command) + Buffer.byteLength(JSON.stringify(wireOptions));
    if (this.queue.length >= this.maxQueued || this.bytes + bytes > this.maxBytes) return Promise.reject(new ObservationExecutionError('capacity'));
    const timeout = options.timeout && Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : 30_000;
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const job: Job = { id, command, options: wireOptions, onData: options.onData, bytes, active: false,
        deadline: performance.now() + timeout, timer: setTimeout(() => this.cancel(id, 'deadline'), Math.min(timeout, 2_147_483_647)), signal: options.signal, resolve, reject };
      if (job.signal) { job.abort = () => this.cancel(id, 'cancelled'); job.signal.addEventListener('abort', job.abort, { once: true }); }
      this.jobs.set(id, job); this.queue.push(job); this.bytes += bytes;
      this.refPool();
      void this.start().catch(() => {});
      this.drain();
    });
  }

  getStats(): { active: number; queued: number; bytes: number; unavailable: boolean; factoryPid?: number; actors: Array<{ pid: number; rss?: number; heapLimit?: number }> } {
    return { active: this.active, queued: this.queue.length, bytes: this.bytes, unavailable: this.unavailable, factoryPid: this.factory?.pid,
      actors: [...this.actors.values()].map(actor => ({ pid: actor.pid, ...actor.metrics })) };
  }

  private onMessage(message: any): void {
    if (message.type === 'actor' && Number.isInteger(message.pid) && message.pid > 1 && message.pid !== process.pid) {
      this.actors.set(message.index, { pid: message.pid });
      if (!this.closed && !this.unavailable) this.send({ type: 'actor-registered', index: message.index, pid: message.pid });
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
    if (message.type === 'fatal') { void this.failPool(); return; }
    if (message.type === 'ready' && !this.closed && !this.unavailable) {
      this.ready = true; clearTimeout(this.startTimer); this.startResolve?.(); this.drain(); return;
    }
    const job = this.jobs.get(message.id);
    if (!job?.active) return;
    if (message.type === 'data') {
      try { if (!job.failure) job.onData?.(message.chunk); } catch { this.cancel(job.id, 'callback'); }
      this.send({ type: 'ack', id: job.id, bytes: message.bytes });
    } else if (message.type === 'result') {
      const actor = [...this.actors.values()].find(actor => actor.pid === message.pid);
      if (actor) actor.metrics = message.metrics;
      this.finish(job, message.result);
    } else if (message.type === 'cancelled') this.finish(job, undefined, job.failure ?? 'unavailable');
  }

  private send(message: object): void {
    if (this.factory?.connected) this.factory.send(message, error => { if (error && !this.stopping) void this.failPool(); });
  }
  private refPool(): void { this.factory?.ref(); this.factory?.channel?.ref(); }
  private drain(): void {
    if (!this.ready || !this.factory || this.closed || this.unavailable) return;
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.deadline <= performance.now()) { this.finish(job, undefined, 'deadline'); continue; }
      job.active = true; this.active++; this.refPool();
      this.send({ type: 'exec', id: job.id, command: job.command, options: job.options });
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
    if (job.active) this.active--; else { const i = this.queue.indexOf(job); if (i >= 0) this.queue.splice(i, 1); }
    this.bytes -= job.bytes;
    const error = failure === 'cleanup' ? failure : job.failure ?? failure;
    if (error) job.reject(new ObservationExecutionError(error)); else job.resolve(result!);
    this.drain();
  }

  private stopPool(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.ready = false; clearTimeout(this.startTimer);
    this.stopping = (async () => {
      const groups = new Set([...this.actors.values()].map(actor => actor.pid));
      if (this.factory?.pid) groups.add(this.factory.pid);
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
  private async failPool(): Promise<void> {
    if (this.unavailable) return;
    this.unavailable = true;
    let code: FailureCode = 'unavailable';
    try { await this.stopPool(); } catch { code = 'cleanup'; }
    this.startReject?.(new ObservationExecutionError(code));
    for (const job of [...this.jobs.values()]) this.finish(job, undefined, code);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const job of [...this.jobs.values()]) { job.failure ??= 'closed'; if (!job.active) this.finish(job, undefined, 'closed'); }
    this.closing = (async () => {
      let failure: FailureCode = 'closed';
      try { await this.stopPool(); } catch { failure = 'cleanup'; }
      this.startReject?.(new ObservationExecutionError(failure));
      for (const job of [...this.jobs.values()]) this.finish(job, undefined, failure);
      if (failure === 'cleanup') throw new ObservationExecutionError('cleanup');
    })();
    return this.closing;
  }
}
