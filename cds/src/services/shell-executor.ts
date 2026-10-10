import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Worker } from 'node:worker_threads';
import type { IShellExecutor, ExecResult, ExecOptions } from '../types.js';

const executionContext = new AsyncLocalStorage<Pick<ExecOptions, 'priority' | 'schedulingGroup'>>();
export function withShellExecutionContext<T>(context: Pick<ExecOptions, 'priority' | 'schedulingGroup'>, work: () => T): T {
  return executionContext.run(context, work);
}

export interface ShellExecutorSettings {
  maxConcurrent?: number;
  maxQueued?: number;
}

interface ShellJob {
  id: number;
  command: string;
  options: ExecOptions;
  deadline: number;
  enqueuedAt: number;
  timer: NodeJS.Timeout;
  abort?: () => void;
  resolve: (result: ExecResult) => void;
  pid?: number;
  owner: string;
  cancelling?: number;
}

// 单独的常驻执行线程负责 native spawn；源码内嵌避免 tsx/vitest 与编译产物
// 的 worker 文件路径产生不同语义。命令、stdin、环境和结果仅通过私有消息通道。
const SHELL_WORKER = String.raw`
const { parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const jobs = new Map();
let closing = false;
function closedIfIdle() {
  if (closing && !jobs.size) parentPort.postMessage({ type: 'closed' });
}
const limit = 10 * 1024 * 1024;
function kill(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
}
function stop(job, code, reason) {
  if (job.stopping) return;
  job.stopping = { code, reason };
  job.child.stdout.resume(); job.child.stderr.resume();
  kill(job.child, 'SIGTERM');
  job.force = setTimeout(() => kill(job.child, 'SIGKILL'), 250);
}
parentPort.on('message', message => {
  if (message.type === 'ack') {
    const job = jobs.get(message.id);
    if (job) {
      job.pending = Math.max(0, job.pending - message.credit);
      if (job.pending < 128 * 1024) { job.child.stdout.resume(); job.child.stderr.resume(); }
    }
    return;
  }
  if (message.type === 'close') {
    closing = true;
    for (const job of jobs.values()) stop(job, 130, 'Shell executor closed');
    closedIfIdle();
    return;
  }
  if (message.type === 'cancel') {
    const job = jobs.get(message.id);
    if (job) stop(job, message.code, message.reason);
    return;
  }
  if (message.type !== 'run' || closing) return;
  const { id, command, options } = message;
  let child;
  try {
    // 固定supervisor不exec替换自己，其argv携带私有归属令牌；即使
    // native spawn之后线程硬中断、用户命令exec/清环境，仍能找回进程组。
    const supervisor = 'trap \'kill -TERM "$command_pid" 2>/dev/null; wait "$command_pid"; exit 130\' TERM INT; /bin/sh -c "$1" <&0 & command_pid=$!; wait "$command_pid"; exit $?';
    child = process.platform === 'win32'
      ? spawn(command, { shell: true, cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('/bin/sh', ['-c', supervisor, options.owner, command], {
        detached: true, cwd: options.cwd, env: options.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
  } catch {
    parentPort.postMessage({ type: 'result', id, result: { stdout: '', stderr: 'Process error', exitCode: 1 } });
    return;
  }
  const job = { child, stdout: [], stderr: [], bytes: 0, pending: 0, stopping: null };
  jobs.set(id, job);
  if (child.pid) parentPort.postMessage({ type: 'pid', id, pid: child.pid });
  let done = false;
  const finish = code => {
    if (done) return;
    done = true;
    // shell可能先退出并关闭管道，后台后代仍忽略TERM。确认取消完成前
    // 收敛整个组，不能因父shell close而撤掉后代的最终清理。
    if (job.stopping) kill(job.child, 'SIGKILL');
    clearTimeout(job.force);
    jobs.delete(id);
    parentPort.postMessage({ type: 'result', id, result: {
      stdout: Buffer.concat(job.stdout).toString(),
      stderr: Buffer.concat(job.stderr).toString() + (job.stopping ? job.stopping.reason : ''),
      exitCode: job.stopping ? job.stopping.code : (typeof code === 'number' ? code : 1)
    }});
    closedIfIdle();
  };
  const output = (name, chunk) => {
    if (job.stopping) return;
    job.bytes += chunk.length;
    if (job.bytes > limit) { stop(job, 1, 'Command output limit exceeded'); return; }
    job[name].push(chunk);
    if (options.stream) {
      // 最少按1KiB计费，同时限制大量微小消息；未确认输出有256KiB上界。
      const credit = Math.max(1024, chunk.length);
      job.pending += credit;
      parentPort.postMessage({ type: 'data', id, chunk: chunk.toString(), credit });
      if (job.pending >= 256 * 1024) { child.stdout.pause(); child.stderr.pause(); }
    }
  };
  child.stdout.on('data', chunk => output('stdout', chunk));
  child.stderr.on('data', chunk => output('stderr', chunk));
  child.stdin.on('error', () => {});
  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  child.on('error', () => { job.stopping = { code: 1, reason: 'Process error' }; finish(1); });
  child.on('close', finish);
});
`;

// 原执行线程硬中断时，PID消息可能尚未回到Master。恢复线程按每条命令
// 私有随机归属标记核对真实进程组，绝不匹配普通命令文本或输出整个环境。
const RECONCILE_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { spawnSync } = require('node:child_process');
const markers = new Set(workerData.owners);
function scan() {
  const result = spawnSync('ps', ['eww', '-ax', '-o', 'pid=,pgid=,args='], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 64 * 1024 * 1024
  });
  if (result.error || result.status !== 0) return false;
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match || !match[3].split(/\s+/).some(value => markers.has(value))) continue;
    const group = Number(match[2]);
    if (group <= 1 || group === process.pid) continue;
    try { process.kill(-group, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') return false;
    }
  }
  return true;
}
const first = scan();
setTimeout(() => parentPort.postMessage({ verified: first && scan() }), 50);
`;

export class ShellExecutor implements IShellExecutor {
  private worker?: Worker;
  private closed = false;
  private sequence = 0;
  private closePromise?: Promise<void>;
  private workerClosed?: () => void;
  private recovery?: Promise<void>;
  private readonly active = new Map<number, ShellJob>();
  private readonly queued: ShellJob[] = [];
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly lastGroupByPriority = new Map<number, string>();

  constructor(settings: ShellExecutorSettings = {}) {
    this.maxConcurrent = settings.maxConcurrent ?? 4;
    this.maxQueued = settings.maxQueued ?? 128;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent < 1 ||
        !Number.isInteger(this.maxQueued) || this.maxQueued < 0) {
      throw new Error('Invalid shell executor capacity');
    }
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    options = { ...executionContext.getStore(), ...options };
    if (this.closed) return this.failure(1, 'Shell executor closed');
    if (options.signal?.aborted) return this.failure(130, 'Command cancelled');
    const normalLimit = this.maxConcurrent > 1 ? this.maxConcurrent - 1 : 1;
    const normalActive = [...this.active.values()].filter(job => job.options.priority !== 'health').length;
    const diagnosticActive = [...this.active.values()].filter(job => job.options.priority === 'diagnostic').length;
    const canStartImmediately = !this.recovery && this.active.size < this.maxConcurrent
      && (options.priority !== 'diagnostic' || diagnosticActive < 1) &&
      (options.priority === 'health' || normalActive < normalLimit);
    if (!canStartImmediately && this.queued.length >= this.maxQueued) {
      return this.failure(75, 'Shell execution capacity exhausted');
    }
    // 包含容量等待；未提供超时的调用也有30分钟上界。显式更长超时保持有效。
    const timeout = options.timeout && options.timeout > 0 ? options.timeout : 30 * 60_000;
    return new Promise((resolve) => {
      const id = ++this.sequence;
      const job: ShellJob = {
        id, owner: `cds-owner-${randomUUID()}`, command, options, resolve, enqueuedAt: Date.now(), deadline: Date.now() + timeout,
        timer: setTimeout(() => this.cancel(id, 124, 'Command timed out'), timeout),
      };
      if (options.signal) {
        job.abort = () => this.cancel(id, 130, 'Command cancelled');
        options.signal.addEventListener('abort', job.abort, { once: true });
      }
      this.queued.push(job);
      this.pump();
    });
  }

  private failure(exitCode: number, stderr: string): ExecResult {
    return { stdout: '', stderr, exitCode };
  }

  private finish(job: ShellJob, result: ExecResult): void {
    clearTimeout(job.timer);
    if (job.abort) job.options.signal?.removeEventListener('abort', job.abort);
    this.active.delete(job.id);
    job.resolve(result);
  }

  private killPid(pid: number): void {
    try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch {}
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(SHELL_WORKER, { eval: true });
    this.worker = worker;
    worker.on('message', message => {
      if (message.type === 'closed') { this.workerClosed?.(); return; }
      const job = this.active.get(message.id);
      if (message.type === 'pid') {
        if (job) job.pid = message.pid;
        else this.killPid(message.pid);
      } else if (message.type === 'data') {
        try { job?.options.onData?.(message.chunk); }
        catch { if (job) this.cancel(job.id, 1, 'Output callback failed'); }
        finally {
          // 包含已取消任务的迟到消息，防止执行侧管道永久挂起。
          try { worker.postMessage({ type: 'ack', id: message.id, credit: message.credit }); } catch {}
        }
      } else if (message.type === 'result' && job) {
        this.finish(job, message.result);
        this.pump();
      }
      if (!this.active.size) worker.unref();
    });
    const failed = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.workerClosed?.();
      const interrupted = [...this.active.values()];
      for (const job of interrupted) if (job.pid) this.killPid(job.pid);
      this.recovery = (async () => {
        const verified = await this.reconcileOwnedProcesses(interrupted.map(job => job.owner));
        if (!verified) this.closed = true;
        for (const job of interrupted) this.finish(job, this.failure(job.cancelling ?? 1,
          verified ? 'Execution worker interrupted; command not replayed'
            : 'Execution worker interrupted; process ownership reconciliation failed; executor stopped'));
        if (!verified) for (const job of this.queued.splice(0)) this.finish(job, this.failure(1, 'Executor recovery requires reconciliation'));
      })().finally(() => {
        this.recovery = undefined;
        // 仅尚未执行的排队项继续；未知是否执行的命令绝不自动重放。
        this.pump();
      });
    };
    worker.on('error', failed);
    worker.on('exit', failed);
    return worker;
  }

  private pump(): void {
    if (this.closed || this.recovery) return;
    while (this.active.size < this.maxConcurrent && this.queued.length) {
      const normalLimit = this.maxConcurrent > 1 ? this.maxConcurrent - 1 : 1;
      const normalActive = [...this.active.values()].filter(job => job.options.priority !== 'health').length;
      const diagnosticActive = [...this.active.values()].filter(job => job.options.priority === 'diagnostic').length;
      const eligible = this.queued.map((job, index) => ({ job, index }))
        .filter(({ job }) => (job.options.priority === 'health' || normalActive < normalLimit)
          && (job.options.priority !== 'diagnostic' || diagnosticActive < 1));
      if (!eligible.length) return;
      const score = (job: ShellJob) => job.options.priority === 'health' ? 2
        : Date.now() - job.enqueuedAt >= 30_000 ? 2 : job.options.priority === 'diagnostic' ? 0 : 1;
      const highest = Math.max(...eligible.map(({ job }) => score(job)));
      const candidates = eligible.filter(({ job }) => score(job) === highest);
      const group = (job: ShellJob) => job.options.schedulingGroup || job.options.cwd || 'default';
      const groups = [...new Set(candidates.map(({ job }) => group(job)))];
      const previous = this.lastGroupByPriority.get(highest);
      const nextGroup = groups[(groups.indexOf(previous || '') + 1) % groups.length];
      const chosen = candidates.find(({ job }) => group(job) === nextGroup)!;
      const [job] = this.queued.splice(chosen.index, 1);
      this.lastGroupByPriority.set(highest, nextGroup);
      if (job.deadline <= Date.now()) {
        this.finish(job, this.failure(124, 'Command timed out'));
        continue;
      }
      try {
        const worker = this.getWorker();
        this.active.set(job.id, job);
        worker.ref();
        worker.postMessage({ type: 'run', id: job.id, command: job.command, options: {
          cwd: job.options.cwd, stdin: job.options.stdin, owner: job.owner,
          env: { ...process.env, ...job.options.env, CDS_SHELL_OWNER: job.owner }, stream: Boolean(job.options.onData),
        } });
      } catch {
        this.finish(job, this.failure(1, 'Command dispatch failed; command not replayed'));
      }
    }
  }

  private cancel(id: number, code: number, reason: string): void {
    const queuedIndex = this.queued.findIndex(job => job.id === id);
    if (queuedIndex >= 0) {
      const [job] = this.queued.splice(queuedIndex, 1);
      this.finish(job, this.failure(code, reason));
      return;
    }
    const job = this.active.get(id);
    if (job && !job.cancelling) {
      job.cancelling = code;
      try { this.worker?.postMessage({ type: 'cancel', id, code, reason }); }
      catch {
        if (job.pid) this.killPid(job.pid);
        this.finish(job, this.failure(code, reason));
        this.pump();
      }
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeWorker();
    return this.closePromise;
  }

  private async reconcileOwnedProcesses(owners: string[]): Promise<boolean> {
    if (!owners.length) return true;
    if (process.platform === 'win32') return false;
    return new Promise(resolve => {
      let worker: Worker;
      try { worker = new Worker(RECONCILE_WORKER, { eval: true, workerData: { owners } }); }
      catch { resolve(false); return; }
      let settled = false;
      const finish = (verified: boolean) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        void worker.terminate().catch(() => undefined); resolve(verified);
      };
      const timer = setTimeout(() => finish(false), 2500);
      worker.on('message', message => finish(message.verified === true));
      worker.on('error', () => finish(false));
      worker.on('exit', () => finish(false));
    });
  }

  private async closeWorker(): Promise<void> {
    await this.recovery;
    for (const job of this.queued.splice(0)) this.finish(job, this.failure(130, 'Shell executor closed'));
    const worker = this.worker;
    if (worker) {
      let timer: NodeJS.Timeout | undefined;
      try {
        // run/close使用有序通道，执行线程清理自己启动的所有组后确认。
        // 覆盖Master尚未收到PID的启动窗口；不直接terminate丢失子进程所有权。
        await new Promise<void>(resolve => {
          this.workerClosed = resolve;
          timer = setTimeout(resolve, 2000);
          try { worker.postMessage({ type: 'close' }); } catch { resolve(); }
        });
      } finally {
        clearTimeout(timer);
        this.workerClosed = undefined;
        const remaining = [...this.active.values()];
        for (const job of remaining) {
          if (job.pid) this.killPid(job.pid);
          this.finish(job, this.failure(130, 'Shell executor closed'));
        }
        this.worker = undefined;
        await worker.terminate().catch(() => undefined);
        await this.reconcileOwnedProcesses(remaining.map(job => job.owner));
      }
    }
  }

}

type PatternHandler = (match: RegExpMatchArray, options?: ExecOptions) => ExecResult;

export class MockShellExecutor implements IShellExecutor {
  readonly commands: string[] = [];
  /** 与 commands 平行：每次 exec 收到的 stdin（没给就是 undefined）。
   *  凭据走 stdin 之后，回归要能断言「密钥确实没进命令行、而是进了这里」。 */
  readonly stdins: Array<string | undefined> = [];
  /**
   * Parallel to `commands`: the `cwd` value passed with each exec() call
   * (may be undefined). Added in P4 Part 18 (G1.2) so the concurrent
   * stateless-WorktreeService test can assert that two concurrent calls
   * used different repoRoots without interference.
   */
  readonly cwds: Array<string | undefined> = [];
  private responses = new Map<string, ExecResult>();
  private patterns: Array<{ regex: RegExp; handler: PatternHandler }> = [];

  addResponse(command: string, result: ExecResult): void {
    this.responses.set(command, result);
  }

  addResponsePattern(regex: RegExp, handler: PatternHandler): void {
    this.patterns.push({ regex, handler });
  }

  /**
   * 同 addResponsePattern，但插到队首 —— exec() 是**首个命中即返回**，所以在
   * beforeEach 里注册过通用桩之后，单个用例想覆盖其中一条只能靠这个（往后追加永远
   * 匹配不到）。用于「这个用例的场景与通用桩的默认值不符」的局部修正。
   */
  addResponsePatternFirst(regex: RegExp, handler: PatternHandler): void {
    this.patterns.unshift({ regex, handler });
  }

  clearPatterns(): void {
    this.patterns = [];
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.commands.push(command);
    this.cwds.push(options?.cwd);
    this.stdins.push(options?.stdin);

    const exact = this.responses.get(command);
    if (exact) return exact;

    for (const { regex, handler } of this.patterns) {
      const match = command.match(regex);
      if (match) return handler(match, options);
    }

    return {
      stdout: '',
      stderr: `Command not mocked: ${command}`,
      exitCode: 1,
    };
  }
}
