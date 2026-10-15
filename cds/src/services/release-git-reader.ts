import type { IShellExecutor } from '../types.js';
import { shellQuoteArg } from './secure-database-cli.js';

export const RELEASE_GIT_TIMEOUT_MS = 3000;
export type GitRunner = (args: readonly string[], signal?: AbortSignal) => string | Promise<string>;
export type ReleaseGitRunner = GitRunner;
const READ_TIMEOUT_MS = RELEASE_GIT_TIMEOUT_MS;
const MAX_QUEUED_READS = 16;
const MAX_INPUT_BYTES = 1024 * 1024;
interface ReadJob {
  command: string; bytes: number; deadline: number;
  assertCurrent?: () => void;
  resolve: (output: string) => void; reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}
interface ReadPool { active: boolean; bytes: number; queue: ReadJob[] }
const readPools = new WeakMap<IShellExecutor, ReadPool>();

/** 一个执行器最多一个非紧急Git；等待描述符与运行输入共同有界，不占满普通执行槽。 */
function drain(shell: IShellExecutor, pool: ReadPool): void {
  if (pool.active) return;
  const job = pool.queue.shift();
  if (!job) return;
  clearTimeout(job.timer);
  job.signal?.removeEventListener('abort', job.onAbort!);
  const timeout = Math.ceil(job.deadline - performance.now());
  if (timeout <= 0 || job.signal?.aborted) {
    pool.bytes -= job.bytes; job.reject(new Error('Release Git read deadline exceeded')); drain(shell, pool); return;
  }
  pool.active = true;
  void readOutput(shell, job.command, timeout, job.assertCurrent, job.signal).then(job.resolve, error => job.reject(error)).finally(() => {
    pool.active = false; pool.bytes -= job.bytes; drain(shell, pool);
  });
}
async function readOutput(shell: IShellExecutor, command: string, timeout: number, assertCurrent?: () => void, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('Release Git read cancelled');
  assertCurrent?.();
  let output = ''; let bytes = 0;
  const result = await shell.execBackgroundObservation!(command, {
    timeout, signal, captureOutput: false, beforeStart: () => {
      if (signal?.aborted) throw new Error('Release Git read cancelled');
      assertCurrent?.();
    },
    onData: (chunk, channel) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 256 * 1024) throw new Error('Release Git output capacity exceeded');
      if (channel !== 'stderr') output += chunk;
    },
  });
  if (signal?.aborted) throw new Error('Release Git read cancelled');
  assertCurrent?.();
  if (result.exitCode !== 0) throw new Error('Release Git read failed');
  return output;
}
/** 纯本地Git读取，复用既有非紧急隔离能力；缺能力明确不可用，不从Master创建命令。 */
export function createReleaseGitRunner(shell?: IShellExecutor, assertCurrent?: () => void): ReleaseGitRunner {
  return async (args, signal) => {
    if (signal?.aborted) throw new Error('Release Git read cancelled');
    if (!shell?.execBackgroundObservation) throw new Error('Release Git observation executor unavailable');
    const command = ['git', ...args].map(shellQuoteArg).join(' ');
    const bytes = Buffer.byteLength(command);
    let pool = readPools.get(shell);
    if (!pool) { pool = { active: false, bytes: 0, queue: [] }; readPools.set(shell, pool); }
    if (pool.queue.length >= MAX_QUEUED_READS || pool.bytes + bytes > MAX_INPUT_BYTES) {
      throw new Error('Release Git input capacity exceeded');
    }
    const ownedPool = pool;
    return new Promise<string>((resolve, reject) => {
      const job: ReadJob = { command, bytes, deadline: performance.now() + READ_TIMEOUT_MS, resolve, reject, assertCurrent, signal };
      ownedPool.bytes += bytes; ownedPool.queue.push(job);
      job.timer = setTimeout(() => {
        const index = ownedPool.queue.indexOf(job);
        if (index < 0) return;
        ownedPool.queue.splice(index, 1); ownedPool.bytes -= job.bytes;
        signal?.removeEventListener('abort', job.onAbort!);
        reject(new Error('Release Git read deadline exceeded'));
      }, READ_TIMEOUT_MS);
      job.onAbort = () => {
        const index = ownedPool.queue.indexOf(job);
        if (index < 0) return;
        ownedPool.queue.splice(index, 1); ownedPool.bytes -= job.bytes; clearTimeout(job.timer);
        signal?.removeEventListener('abort', job.onAbort!);
        reject(new Error('Release Git read cancelled'));
      };
      signal?.addEventListener('abort', job.onAbort, { once: true });
      drain(shell, ownedPool);
    });
  };
}

/** Compatibility name; the execution capability is still the private background lane. */
export const shellGitRunner = (shell: IShellExecutor, _scope?: string): GitRunner => createReleaseGitRunner(shell);
/** Embedded callers without an isolated executor return unavailable, never spawn from Master. */
export const workerGitRunner: GitRunner = createReleaseGitRunner();
