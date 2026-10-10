import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import * as childProcess from 'node:child_process';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { ContainerService } from '../../src/services/container.js';
import { collectContainerDiagnostics } from '../../src/services/container-diagnostics.js';
import type { CdsConfig } from '../../src/types.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, exec: vi.fn(actual.exec) };
});

const observation = { executionLane: 'observation' as const, timeout: 5000 };
const executors: IsolatedShellExecutor[] = [];
const dirs: string[] = [];
function executor(config?: ConstructorParameters<typeof IsolatedShellExecutor>[1]): IsolatedShellExecutor {
  const e = new IsolatedShellExecutor(new ShellExecutor(), config);
  executors.push(e);
  return e;
}
async function directory(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cds-observation-'));
  dirs.push(dir);
  return dir;
}
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture did not become ready');
}
const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
afterEach(async () => {
  await Promise.all(executors.splice(0).map(e => e.close?.()));
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
  vi.mocked(childProcess.exec).mockClear();
});

describe('IsolatedShellExecutor 真实进程', () => {
  it('观测进程创建不进入主线程，即使主线程执行器的 fork 卡顿', async () => {
    const spy = vi.mocked(childProcess.exec);
    const original = spy.getMockImplementation()!;
    spy.mockImplementation(((...args: Parameters<typeof childProcess.exec>) => {
      const until = performance.now() + 250;
      while (performance.now() < until) { /* 旧主线程 fork 的阻塞注入 */ }
      return original(...args);
    }) as typeof childProcess.exec);
    const delays: number[] = [];
    let previous = performance.now();
    const timer = setInterval(() => { const now = performance.now(); delays.push(now - previous); previous = now; }, 10);
    try {
      const result = await executor().exec('echo worker-ready', observation);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(result.stdout.trim()).toBe('worker-ready');
      expect(spy).not.toHaveBeenCalled();
      expect(Math.max(...delays)).toBeLessThan(150);
    } finally { clearInterval(timer); spy.mockImplementation(original); }
  });

  it('保留真实 stdout/stderr、stdin、cwd、非零退出与流式输出契约', async () => {
    const e = executor();
    const cwd = await directory();
    const chunks: string[] = [];
    const r = await e.exec('pwd; cat; echo error >&2; exit 7', {
      ...observation, cwd, stdin: 'input-from-parent\n', onData: chunk => chunks.push(chunk),
    });
    expect(r.exitCode).toBe(7);
    expect(r.stdout).toContain(cwd);
    expect(r.stdout).toContain('input-from-parent');
    expect(r.stderr.trim()).toBe('error');
    expect(chunks.join('')).toContain('input-from-parent');
    expect(chunks.join('')).toContain('error');
    expect(e.getStats().threadId).toBeGreaterThan(0);
  });

  it('每次提交使用当前环境快照，不带回 worker 启动时已删除的变量', async () => {
    const e = executor();
    const key = 'CDS_OBSERVATION_TEST_ENV';
    const previous = process.env[key];
    try {
      process.env[key] = 'initial';
      expect((await e.exec(`printf '%s' "$${key}"`, observation)).stdout).toBe('initial');
      delete process.env[key];
      expect((await e.exec(`printf '%s' "$${key}"`, observation)).stdout).toBe('');
      expect((await e.exec(`printf '%s' "$${key}"`, { ...observation, env: { [key]: 'override' } })).stdout).toBe('override');
    } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
  });

  it('默认操作仍复用原执行器，避免在资格检查后新增隐式操作队列', async () => {
    const operation = { exec: vi.fn(async () => ({ stdout: 'original', stderr: '', exitCode: 0 })) };
    const e = new IsolatedShellExecutor(operation);
    executors.push(e);
    expect((await e.exec('operation')).stdout).toBe('original');
    expect(operation.exec).toHaveBeenCalledWith('operation', undefined);
    expect(e.getStats().threadId).toBeUndefined();
  });

  it('排队超时与取消的命令不会延迟创建文件，满队列显式拒绝', async () => {
    const e = executor({ concurrency: 1, maxQueued: 2 });
    const dir = await directory();
    // 先完成 loader，明确下面的请求排在真实运行进程之后。
    await e.exec('true', observation);
    const active = e.exec('sleep 0.4', observation);
    const sentinel = path.join(dir, 'must-not-start');
    const abort = new AbortController();
    const expired = expect(e.exec(`touch ${quote(sentinel)}`, { ...observation, timeout: 40 })).rejects.toMatchObject({ code: 'deadline' });
    const cancelled = expect(e.exec(`touch ${quote(sentinel)}`, { ...observation, signal: abort.signal })).rejects.toMatchObject({ code: 'cancelled' });
    await expect(e.exec('secret-command', observation)).rejects.toMatchObject({ code: 'capacity' });
    abort.abort();
    await Promise.all([active, expired, cancelled]);
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(e.getStats()).toMatchObject({ active: 0, queued: 0, bytes: 0 });
  });

  it('真实进程组超时会清理子进程，之后仍可执行查询', async () => {
    const e = executor({ concurrency: 1 });
    await e.exec('true', observation);
    const dir = await directory();
    const pidFile = path.join(dir, 'child.pid');
    const timedOut = expect(e.exec(`sleep 30 & echo $! > ${quote(pidFile)}; wait`, { ...observation, timeout: 500 })).rejects.toMatchObject({ code: 'deadline' });
    await waitFor(async () => { try { await access(pidFile); return true; } catch { return false; } });
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await timedOut;
    // Linux 可能短暂保留由 init 等待回收的 zombie；ps 状态不能仍是可运行进程。
    const state = await new ShellExecutor().exec(`ps -o stat= -p ${pid}`);
    expect(state.stdout.trim()).toMatch(/^(Z.*)?$/);
    expect((await e.exec('echo healthy', observation)).stdout.trim()).toBe('healthy');
  });

  it('主动关闭等待运行进程终止，同时取消排队任务', async () => {
    const e = executor({ concurrency: 1 });
    await e.exec('true', observation);
    const dir = await directory();
    const pidFile = path.join(dir, 'active.pid');
    const active = expect(e.exec(`echo $$ > ${quote(pidFile)}; sleep 30`, observation)).rejects.toMatchObject({ code: 'closed' });
    await waitFor(async () => { try { await access(pidFile); return true; } catch { return false; } });
    const queued = expect(e.exec(`touch ${quote(path.join(dir, 'queued'))}`, observation)).rejects.toMatchObject({ code: 'closed' });
    await e.close();
    await Promise.all([active, queued]);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(access(path.join(dir, 'queued'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('worker 启动失败会隔离故障，不泄露命令或回退主线程', async () => {
    const operation = { exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) };
    const e = new IsolatedShellExecutor(operation, { workerFactory: () => new Worker('throw new Error("private failure")', { eval: true, execArgv: [] }) });
    executors.push(e);
    await expect(e.exec('private-command', { ...observation, stdin: 'private-input' })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(e.exec('another-secret', observation)).rejects.toThrow('状态查询执行器暂不可用');
    expect(operation.exec).not.toHaveBeenCalled();
    expect(e.getStats()).toMatchObject({ unavailable: true, active: 0, queued: 0, bytes: 0 });
  });

  it('实际容器查询入口把执行器故障保留为 unknown，不能回退成空集合或不存在', async () => {
    const operation = { exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) };
    const e = new IsolatedShellExecutor(operation, { workerFactory: () => new Worker('throw new Error("fixture")', { eval: true, execArgv: [] }) });
    executors.push(e);
    const config = { repoRoot: '/unused', worktreeBase: '/unused', dockerNetwork: 'unused', sharedEnv: {}, jwt: { secret: 'fixture', issuer: 'fixture' } } as CdsConfig;
    const container = new ContainerService(e, config);
    for (const read of [
      () => container.isRunning('fixture'), () => container.getRunningContainerNamesSnapshot(),
      () => container.getInfraHealth('fixture'), () => container.discoverAppContainersWithStatus(),
      () => container.discoverInfraContainers(), () => container.getServiceStats(['fixture']),
      () => container.getLogs('fixture'), () => collectContainerDiagnostics(e, 'fixture'),
    ]) await expect(read()).rejects.toMatchObject({ code: 'unavailable' });
    expect(operation.exec).not.toHaveBeenCalled();
  });

  it('流式回调失败只取消所属查询，其他查询保留正确结果', async () => {
    const e = executor();
    await expect(e.exec('echo private-output; sleep 30', { ...observation, onData: () => { throw new Error('private callback'); } })).rejects.toMatchObject({ code: 'callback' });
    expect((await e.exec('echo next', observation)).stdout.trim()).toBe('next');
  });

  it('运行线程异常退出会回收已登记进程，不重新执行或回退主线程', async () => {
    const source = new URL('../../src/services/shell-executor-worker.ts', import.meta.url).href;
    const loader = createRequire(import.meta.url).resolve('tsx/esm/api');
    const worker = new Worker(`require(${JSON.stringify(loader)}).tsImport(${JSON.stringify(source)}, { parentURL: ${JSON.stringify(import.meta.url)} });`, { eval: true, execArgv: [] });
    const e = executor({ workerFactory: () => worker });
    const dir = await directory();
    const pidFile = path.join(dir, 'fault-child.pid');
    const failed = expect(e.exec(`sleep 30 & echo $! > ${quote(pidFile)}; wait`, observation)).rejects.toMatchObject({ code: 'unavailable' });
    await waitFor(async () => { try { await access(pidFile); return true; } catch { return false; } });
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    await worker.terminate();
    await failed;
    await waitFor(async () => {
      const state = await new ShellExecutor().exec(`ps -o stat= -p ${pid}`);
      return /^(Z.*)?$/.test(state.stdout.trim());
    });
    await expect(e.exec('echo no-retry', observation)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('真实大输出经过消费确认保持完整，超过捕获预算时终止所属进程', async () => {
    const e = executor();
    let streamed = 0;
    const output = await e.exec(`${quote(process.execPath)} -e 'process.stdout.write("x".repeat(2*1024*1024))'`, {
      ...observation, onData: chunk => { streamed += Buffer.byteLength(chunk); },
    });
    expect(output.exitCode).toBe(0);
    expect(output.stdout.length).toBe(2 * 1024 * 1024);
    expect(streamed).toBe(output.stdout.length);
    const overflow = await e.exec(`${quote(process.execPath)} -e 'process.stdout.write("x".repeat(12*1024*1024))'`, observation);
    expect(overflow.exitCode).not.toBe(0);
    expect(overflow.stdout.length).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect((await e.exec('echo usable', observation)).stdout.trim()).toBe('usable');
  });
});
