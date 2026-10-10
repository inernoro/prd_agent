import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ExecOptions, ExecResult, IShellExecutor } from '../types.js';

type FailureCode = 'capacity' | 'deadline' | 'cancelled' | 'unavailable' | 'closed' | 'callback';
const messages: Record<FailureCode, string> = {
  capacity: '状态查询繁忙，请稍后重试。', deadline: '状态查询超时，请稍后重试。',
  cancelled: '状态查询已取消。', unavailable: '状态查询执行器暂不可用，请稍后重试。',
  closed: '状态查询执行器已关闭。', callback: '状态查询输出处理失败，请稍后重试。',
};
export class ObservationExecutionError extends Error {
  constructor(readonly code: FailureCode) { super(messages[code]); this.name = 'ObservationExecutionError'; }
}
interface Job {
  id: number;
  command: string;
  options: { cwd?: string; stdin?: string; env: NodeJS.ProcessEnv; stream: boolean };
  onData?: (chunk: string) => void;
  flag: Int32Array;
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

function createObservationWorker(): Worker {
  const compiled = new URL('./shell-executor-worker.js', import.meta.url);
  if (existsSync(compiled)) return new Worker(compiled, { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
  const source = new URL('./shell-executor-worker.ts', import.meta.url).href;
  const loader = createRequire(import.meta.url).resolve('tsx/esm/api');
  // 开发态复用已安装的 tsx。编译态不依赖开发包，也不继承主进程的 loader/test 参数。
  return new Worker(`require(${JSON.stringify(loader)}).tsImport(${JSON.stringify(source)}, { parentURL: ${JSON.stringify(import.meta.url)} });`,
    { eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
}

/** 第一批仅隔离显式只读查询。默认操作保留已有资格检查与执行顺序。 */
export class IsolatedShellExecutor implements IShellExecutor {
  private worker?: Worker;
  private ready = false;
  private unavailable = false;
  private closed = false;
  private nextId = 0;
  private readonly jobs = new Map<number, Job>();
  private readonly queue: Job[] = [];
  private active = 0;
  private bytes = 0;
  private closing?: Promise<void>;
  private closeResolve?: () => void;
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly maxBytes: number;
  private readonly workerFactory: () => Worker;

  constructor(private readonly operation: IShellExecutor, config: {
    concurrency?: number; maxQueued?: number; maxBytes?: number; workerFactory?: () => Worker;
  } = {}) {
    this.concurrency = config.concurrency ?? 2;
    this.maxQueued = config.maxQueued ?? 64;
    this.maxBytes = config.maxBytes ?? 16 * 1024 * 1024;
    for (const n of [this.concurrency, this.maxQueued, this.maxBytes]) {
      if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid observation executor capacity');
    }
    this.workerFactory = config.workerFactory ?? createObservationWorker;
  }

  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (options?.executionLane !== 'observation') return this.operation.exec(command, options);
    if (this.closed) return Promise.reject(new ObservationExecutionError('closed'));
    if (this.unavailable) return Promise.reject(new ObservationExecutionError('unavailable'));
    if (options.signal?.aborted) return Promise.reject(new ObservationExecutionError('cancelled'));
    const env = { ...process.env, ...options.env };
    const wireOptions = { cwd: options.cwd, stdin: options.stdin, env, stream: !!options.onData };
    const bytes = Buffer.byteLength(command) + Buffer.byteLength(JSON.stringify(wireOptions));
    if (this.queue.length >= this.maxQueued || this.bytes + bytes > this.maxBytes) {
      return Promise.reject(new ObservationExecutionError('capacity'));
    }
    const timeout = options.timeout && Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : 30_000;
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const job: Job = {
        id, command, options: wireOptions, onData: options.onData, bytes, active: false,
        flag: new Int32Array(new SharedArrayBuffer(8)), deadline: performance.now() + timeout,
        timer: setTimeout(() => this.cancel(id, 'deadline'), Math.min(timeout, 2_147_483_647)),
        signal: options.signal, resolve, reject,
      };
      if (job.signal) {
        job.abort = () => this.cancel(id, 'cancelled');
        job.signal.addEventListener('abort', job.abort, { once: true });
      }
      this.jobs.set(id, job);
      this.queue.push(job);
      this.bytes += bytes;
      this.ensureWorker();
      this.drain();
    });
  }

  getStats(): { active: number; queued: number; bytes: number; unavailable: boolean; threadId?: number } {
    return { active: this.active, queued: this.queue.length, bytes: this.bytes, unavailable: this.unavailable, threadId: this.worker?.threadId };
  }

  private ensureWorker(): void {
    if (this.worker || this.unavailable || this.closed) return;
    try {
      const worker = this.workerFactory();
      this.worker = worker;
      worker.on('message', (message) => {
        if (message.type === 'ready') { this.ready = true; this.drain(); return; }
        const job = this.jobs.get(message.id);
        if (!job?.active) return;
        if (message.type === 'data') {
          try { if (!job.failure) job.onData?.(message.chunk); }
          catch { this.cancel(job.id, 'callback'); }
          worker.postMessage({ type: 'ack', id: job.id, bytes: message.bytes });
        } else if (message.type === 'result') this.finish(job, message.result);
        else if (message.type === 'cancelled') this.finish(job, undefined, job.failure ?? 'unavailable');
      });
      worker.on('error', () => this.failWorker());
      worker.on('exit', () => { if (!this.closed || this.jobs.size) this.failWorker(); });
    } catch { this.failWorker(); }
  }

  private drain(): void {
    if (!this.ready || !this.worker || this.closed || this.unavailable) return;
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.deadline <= performance.now()) { this.finish(job, undefined, 'deadline'); continue; }
      job.active = true;
      this.active++;
      this.worker.ref();
      this.worker.postMessage({ type: 'exec', id: job.id, command: job.command, options: job.options, control: job.flag.buffer });
    }
    if (!this.jobs.size) this.worker.unref();
  }

  private cancel(id: number, code: FailureCode): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.failure ??= code;
    Atomics.store(job.flag, 0, 1);
    // 已开始的工作必须等待 worker 确认进程结束，不能超时回包后偷偷执行。
    if (!job.active) this.finish(job, undefined, job.failure);
  }

  private finish(job: Job, result?: ExecResult, failure?: FailureCode): void {
    if (!this.jobs.delete(job.id)) return;
    clearTimeout(job.timer);
    if (job.abort) job.signal?.removeEventListener('abort', job.abort);
    if (job.active) this.active--;
    else { const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1); }
    this.bytes -= job.bytes;
    const error = job.failure ?? failure;
    if (error) job.reject(new ObservationExecutionError(error));
    else job.resolve(result!);
    if (this.closed) this.completeClose();
    else this.drain();
  }

  private failWorker(): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.ready = false;
    for (const job of [...this.jobs.values()]) {
      Atomics.store(job.flag, 0, 1);
      const pid = Atomics.load(job.flag, 1);
      if (pid > 0) {
        try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch { /* 已退出 */ }
      }
      this.finish(job, undefined, 'unavailable');
    }
    void this.worker?.terminate();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = new Promise((resolve) => { this.closeResolve = resolve; });
    for (const job of [...this.jobs.values()]) this.cancel(job.id, 'closed');
    this.completeClose();
    return this.closing;
  }

  private completeClose(): void {
    if (this.jobs.size || !this.closeResolve) return;
    const resolve = this.closeResolve;
    this.closeResolve = undefined;
    if (this.worker) void this.worker.terminate().then(() => resolve(), () => resolve());
    else resolve();
  }
}
