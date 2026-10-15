import { traceExecutor } from '../helpers/cleanup-lifecycle-trace.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as childProcess from 'node:child_process';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { launchObservationProcess } from '../../src/services/observation-process-launcher.js';
import { ContainerService } from '../../src/services/container.js';
import { collectContainerDiagnostics } from '../../src/services/container-diagnostics.js';
import { readReadyFixturePid } from '../helpers/process-pid-fixture.js';
import type { CdsConfig, ExecAssignment } from '../../src/types.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, exec: vi.fn(actual.exec), spawn: vi.fn(actual.spawn) };
});

const observation = { executionLane: 'observation' as const, timeout: 5000 };
const executors: IsolatedShellExecutor[] = [];
const dirs: string[] = [];
function executor(config?: ConstructorParameters<typeof IsolatedShellExecutor>[1]): IsolatedShellExecutor {
  const e = traceExecutor(new IsolatedShellExecutor(new ShellExecutor(), config), 'isolated-shell');
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
  vi.mocked(childProcess.spawn).mockClear();
});

describe('IsolatedShellExecutor 真实进程', () => {
  it('启动诊断保留真实就绪时间并返回独立快照', async () => {
    const e = executor({ concurrency: 1 });
    await e.start();
    const diagnostic = e.getLifecycle();
    expect(Date.parse(diagnostic.startedAt!)).toBeLessThanOrEqual(Date.parse(diagnostic.readyAt!));
    expect(diagnostic.readyElapsedMs).toBeGreaterThanOrEqual(0);
    expect(diagnostic.failure).toBeUndefined();
    diagnostic.readyAt = 'changed-by-consumer';
    expect(e.getLifecycle().readyAt).not.toBe('changed-by-consumer');
    expect((await e.exec('printf still-working', observation)).stdout).toBe('still-working');
  });

  it('原5秒首次启动失败保留原因且不暴露命令或私有输入', async () => {
    const operation = { exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) };
    const e = new IsolatedShellExecutor(operation, { processFactory: () => childProcess.spawn(process.execPath,
      ['--eval', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }) });
    executors.push(e);
    await expect(e.exec('private-command', { ...observation, timeout: 10000, stdin: 'private-input', env: { PRIVATE_KEY: 'private-value' } }))
      .rejects.toMatchObject({ code: 'unavailable' });
    const diagnostic = e.getLifecycle();
    expect(diagnostic.failure).toMatchObject({ reason: 'startup-deadline', phase: 'startup', generation: 0, actors: 0, readyActors: 0 });
    expect(diagnostic.failure!.elapsedMs).toBeGreaterThanOrEqual(4900);
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-command|private-input|PRIVATE_KEY|private-value/);
    diagnostic.failure!.reason = 'process-create';
    diagnostic.failure!.actorPids.push(12345);
    expect(e.getLifecycle().failure!.reason).toBe('startup-deadline');
    expect(e.getLifecycle().failure!.actorPids).toEqual([]);
    await expect(e.exec('must-not-retry', observation)).rejects.toMatchObject({ code: 'unavailable' });
    expect(operation.exec).not.toHaveBeenCalled();
  }, 15000);

  it('同步创建错误只记录有限原因，原异常正文不进入诊断', async () => {
    const e = executor({ processFactory: () => { throw new Error('secret-provider-message'); } });
    await expect(e.start()).rejects.toMatchObject({ code: 'unavailable' });
    expect(e.getLifecycle().failure).toMatchObject({ reason: 'process-create', phase: 'startup' });
    expect(JSON.stringify(e.getLifecycle())).not.toContain('secret-provider-message');
  });

  it.each(['observation', 'operation'] as const)('%s默认池首次5秒失败仍保留失败，由原监督进程清理后恢复新请求，不重放旧请求', async (lane) => {
    const e = executor({ concurrency: 1, isolatedLane: lane });
    const dir = await directory(), marker = path.join(dir, 'must-not-replay');
    const startupFailed = expect(e.start()).rejects.toMatchObject({ code: 'unavailable' });
    const channel = (e as unknown as { factory: childProcess.ChildProcess }).factory;
    let paused = 0, lateReadyRejected = false;
    channel.on('message', (message: any) => {
      if (message.type === 'factory-started' && !paused) { paused = message.pid; process.kill(-paused, 'SIGSTOP'); }
      if (message.type === 'factory-resetting' && paused && !lateReadyRejected) {
        channel.emit('message', { type: 'ready', generation: message.generation });
        lateReadyRejected = e.getStats().unavailable;
      }
    });
    const oldBeforeStart = vi.fn();
    const oldRequestFailed = expect(e.exec(`touch ${quote(marker)}`, { executionLane: lane, timeout: 20000, beforeStart: oldBeforeStart }))
      .rejects.toMatchObject({ code: 'unavailable' });
    await startupFailed; await oldRequestFailed;
    expect(paused).toBeGreaterThan(1);
    expect(e.getLifecycle().failure).toMatchObject({ reason: 'startup-deadline', phase: 'startup' });
    const end = performance.now() + 6500;
    while (e.getStats().unavailable && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
    expect(e.getStats().unavailable).toBe(false);
    expect(e.getStats().supervisorPid).toBe(channel.pid);
    expect(e.getStats().factoryPid).not.toBe(paused);
    expect(lateReadyRejected).toBe(true);
    expect(oldBeforeStart).not.toHaveBeenCalled();
    await expect(access(marker)).rejects.toThrow();
    const dead = await new ShellExecutor().exec(`ps -o stat= -p ${paused}`);
    expect(dead.stdout.trim()).toMatch(/^(Z.*)?$/);
    const spawnsBefore = vi.mocked(childProcess.spawn).mock.calls.length;
    const newBeforeStart = vi.fn();
    expect((await e.exec('printf recovered-after-initial-failure', { executionLane: lane, beforeStart: newBeforeStart })).stdout).toBe('recovered-after-initial-failure');
    expect(newBeforeStart).toHaveBeenCalledTimes(1);
    await e.start();
    expect(vi.mocked(childProcess.spawn).mock.calls.length).toBe(spawnsBefore);
    expect(e.getLifecycle().failure!.reason).toBe('startup-deadline');
  }, 15000);

  it('在操作授权前回传真实actor、工厂代次和任务身份，取消队列不伪造身份', async () => {
    const e = executor({ isolatedLane: 'operation', concurrency: 2, reservedCleanup: 1 });
    await e.start();
    let assignment: ExecAssignment | undefined;
    const result = await e.exec('printf assigned-operation', { beforeStart: () => {}, onAssigned: value => { assignment = value; } });
    expect(result.stdout).toBe('assigned-operation');
    expect(assignment).toMatchObject({ lane: 'operation', factoryPid: e.getStats().factoryPid });
    expect(assignment!.factoryGeneration).toBeGreaterThan(0);
    expect(assignment!.jobId).toBeGreaterThan(0);
    expect(e.getStats().actors.some(actor => actor.pid === assignment!.actorPid)).toBe(true);
    const activeCancellation = new AbortController();
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const active = e.exec('printf queue-blocker; sleep 30', { signal: activeCancellation.signal, beforeStart: () => {}, onData: () => { signalStarted(); } });
    const activeRejected = expect(active).rejects.toMatchObject({ code: 'cancelled' });
    await started;
    const cancellation = new AbortController();
    const queuedAssignment = vi.fn();
    const queued = e.exec('printf must-not-start', { signal: cancellation.signal, beforeStart: () => {}, onAssigned: queuedAssignment });
    expect(e.getStats().queued).toBe(1);
    const queuedRejected = expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    cancellation.abort(); await queuedRejected;
    activeCancellation.abort(); await activeRejected;
    expect(queuedAssignment).not.toHaveBeenCalled();
  });

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

  it('真实查询的父进程属于独立执行器，而非 Master 地址空间', async () => {
    const e = executor();
    const result = await e.exec(`exec ${quote(process.execPath)} -e 'console.log(process.ppid)'`, observation);
    const parentPid = Number(result.stdout.trim());
    // 此断言在原线程执行器上失败：线程内创建的子进程仍以 Master 为父进程。
    expect(parentPid).not.toBe(process.pid);
    expect(e.getStats().actors.map(actor => actor.pid)).toContain(parentPid);
    expect(e.getStats().factoryPid).not.toBe(process.pid);
  });

  it('预热后常规查询和超时清理均不从Master创建新进程，确认后复用健康actor', async () => {
    const e = executor({ concurrency: 1 });
    await e.start();
    const initialActor = e.getStats().actors[0].pid;
    vi.mocked(childProcess.spawn).mockClear();
    expect((await e.exec('echo first', observation)).stdout.trim()).toBe('first');
    await expect(e.exec('sleep 30', { ...observation, timeout: 100 })).rejects.toMatchObject({ code: 'deadline' });
    expect((await e.exec('echo after-replacement', observation)).stdout.trim()).toBe('after-replacement');
    expect(e.getStats().actors[0].pid).toBe(initialActor);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('一个查询超时不终止其他同时运行的查询', async () => {
    const e = executor({ concurrency: 2 });
    await e.start();
    const timeout = expect(e.exec('sleep 30', { ...observation, timeout: 100 })).rejects.toMatchObject({ code: 'deadline' });
    const unaffected = e.exec('sleep 0.3; echo preserved', observation);
    await timeout;
    expect((await unaffected).stdout.trim()).toBe('preserved');
    expect((await e.exec('echo usable', observation)).stdout.trim()).toBe('usable');
  });

  it('成功退出也清理关闭输出流后留存的后台子进程', async () => {
    const e = executor({ concurrency: 1 });
    const dir = await directory();
    const pidFile = path.join(dir, 'background.pid');
    const result = await e.exec(`sleep 30 >/dev/null 2>&1 & echo $! > ${quote(pidFile)}; exit 0`, observation);
    expect(result.exitCode).toBe(0);
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    const state = await new ShellExecutor().exec(`ps -o stat= -p ${pid}`);
    expect(state.stdout.trim()).toMatch(/^(Z.*)?$/);
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
    expect(e.getStats().factoryPid).toBeGreaterThan(1);
    expect(e.getStats().actors).toHaveLength(2);
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
    expect(e.getStats().factoryPid).toBeUndefined();
    expect(e.getStats().actors).toEqual([]);
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
    let fixturePid: number | undefined;
    await waitFor(async () => { fixturePid = await readReadyFixturePid(pidFile); return fixturePid !== undefined; });
    const poolBefore = e.getStats();
    const members = [fixturePid, poolBefore.supervisorPid, poolBefore.factoryPid, ...poolBefore.actors.map(a => a.pid)]
      .filter((pid): pid is number => typeof pid === 'number' && pid > 1);
    const processBeforePending = new ShellExecutor().exec(`ps -o pid=,ppid=,pgid=,lstart=,stat= -p ${members.join(',')}`);
    const queued = expect(e.exec(`touch ${quote(path.join(dir, 'queued'))}`, observation)).rejects.toMatchObject({ code: 'closed' });
    await e.close();
    await Promise.all([active, queued]);
    const pidText = await readFile(pidFile, 'utf8');
    const pid = Number(pidText.trim());
    // 先在原断言时点冻结结果，不能让异步诊断等待掩盖刚关闭时的失败。
    let originalFailure: unknown;
    try { expect(() => process.kill(pid, 0)).toThrow(); } catch (error) { originalFailure = error; }
    const processBefore = await processBeforePending;
    const processAfter = originalFailure
      ? await new ShellExecutor().exec(`ps -o pid=,ppid=,pgid=,lstart=,stat= -p ${[pid, ...members].filter(p => p && p > 1).join(',')}`) : undefined;
    const receipt = { at: new Date().toISOString(), originalCloseAssertionPassed: !originalFailure,
      pid, pidText, poolBefore, poolAfter: e.getStats(), processBefore: processBefore.stdout.trim(), processAfter: processAfter?.stdout.trim(),
      queueDidNotExecute: await access(path.join(dir, 'queued')).then(() => false, () => true) };
    const evidence = process.env.CDS_REGRESSION_EVIDENCE_DIR;
    if (evidence && path.isAbsolute(evidence)) {
      mkdirSync(evidence, { recursive: true, mode: 0o700 });
      appendFileSync(path.join(evidence, `close-${process.pid}.jsonl`), JSON.stringify(receipt) + '\n', { mode: 0o600 });
    }
    if (originalFailure) console.error(JSON.stringify({ closePidStillPresent: true, ...receipt }));
    await expect(access(path.join(dir, 'queued'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (originalFailure) throw originalFailure;
  });

  it('独立进程启动失败会隔离故障，不泄露命令或回退主线程', async () => {
    const operation = { exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) };
    const e = new IsolatedShellExecutor(operation, { processFactory: () => childProcess.spawn(process.execPath, ['--eval', 'throw new Error("private failure")'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }) });
    executors.push(e);
    await expect(e.exec('private-command', { ...observation, stdin: 'private-input' })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(e.exec('another-secret', observation)).rejects.toThrow('状态查询执行器暂不可用');
    expect(operation.exec).not.toHaveBeenCalled();
    expect(e.getStats()).toMatchObject({ unavailable: true, active: 0, queued: 0, bytes: 0 });
  });

  it('实际容器查询入口把执行器故障保留为 unknown，不能回退成空集合或不存在', async () => {
    const operation = { exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) };
    const e = new IsolatedShellExecutor(operation, { processFactory: () => childProcess.spawn(process.execPath, ['--eval', 'throw new Error("fixture")'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }) });
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

  it('流式消费后合并确认字节，保持原帧与窗口上限而减少跨进程回执', async () => {
    const e = executor({ concurrency: 1 }); await e.start();
    const channel = (e as unknown as { factory: childProcess.ChildProcess }).factory;
    const sent = vi.spyOn(channel, 'send'); let frames = 0, bytes = 0;
    const result = await e.exec(`${quote(process.execPath)} -e ${quote("process.stdout.write('x'.repeat(1024*1024))")}`, {
      ...observation, captureOutput: false, onData: chunk => { frames++; bytes += Buffer.byteLength(chunk); },
    });
    const acks = sent.mock.calls.map(call => call[0] as any).filter(message => message.type === 'ack');
    expect(bytes).toBe(1024 * 1024); expect(result.stdout).toBe(''); expect(result.exitCode).toBe(0);
    expect(frames).toBeGreaterThanOrEqual(128);
    expect(acks.length).toBeLessThanOrEqual(Math.ceil(frames / 2));
    expect(acks.every(message => message.bytes >= 32 * 1024)).toBe(true);
  });

  it.runIf(process.platform === 'darwin')('macOS取消时actor归属读取失败，由监督确认后拒绝旧任务而不挂管道', async () => {
    const dir = await directory(), actorFile = path.join(dir, 'actor.pid'), childFile = path.join(dir, 'query-child.pid');
    await writeFile(path.join(dir, 'ps'), `#!/bin/sh\nif [ "$PPID" = "$(cat ${quote(actorFile)})" ]; then\n printf 'owned group read unavailable' >&2; exit 1\nfi\nexec /bin/ps "$@"\n`, { mode: 0o700 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${dir}:${previousPath || ''}`;
    const e = executor({ concurrency: 1 });
    try {
      await e.start(); const initial = e.getStats(); const actor = initial.actors[0].pid;
      await writeFile(actorFile, String(actor));
      const abort = new AbortController();
      const outcome = e.exec(`sleep 30 & echo $! > ${quote(childFile)}; wait`, { ...observation, signal: abort.signal })
        .then(() => ({ code: 'unexpected-success' }), error => error);
      let child: number | undefined;
      await waitFor(async () => !!(child = await readReadyFixturePid(childFile)));
      abort.abort(); expect(await outcome).toMatchObject({ code: 'cancelled' });
      const stopped = await new ShellExecutor().exec(`ps -o pid=,stat= -p ${actor},${child}`);
      expect(stopped.stdout.split('\n').map(line => line.trim()).filter(Boolean)
        .every(line => line.split(/\s+/)[1]?.startsWith('Z'))).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      await e.close();
    }
  });

  it('工厂进程异常退出会回收所属查询，不重新执行或回退主线程', async () => {
    let factory: childProcess.ChildProcess;
    const e = executor({ processFactory: owner => {
      factory = launchObservationProcess('observation-executor-process', owner);
      return factory;
    } });
    const dir = await directory();
    const pidFile = path.join(dir, 'fault-child.pid');
    const failed = expect(e.exec(`sleep 30 & echo $! > ${quote(pidFile)}; wait`, observation)).rejects.toMatchObject({ code: 'unavailable' });
    await waitFor(async () => { try { await access(pidFile); return true; } catch { return false; } });
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    process.kill(-factory!.pid!, 'SIGKILL');
    await failed;
    await waitFor(async () => {
      const state = await new ShellExecutor().exec(`ps -o stat= -p ${pid}`);
      return /^(Z.*)?$/.test(state.stdout.trim());
    });
    await expect(e.exec('echo no-retry', observation)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it.each(['observation', 'operation'] as const)('%s默认工厂失效后由预热监督进程恢复，新请求不重放旧任务', async (lane) => {
    const e = executor({ isolatedLane: lane, concurrency: 2 }); await e.start();
    const dir = await directory(), executions = path.join(dir, 'once.txt'), marker = path.join(dir, 'started.txt');
    const stats = e.getStats(); const originalFactory = stats.factoryPid!, supervisor = stats.supervisorPid!;
    expect(supervisor).toBeGreaterThan(1); expect(originalFactory).not.toBe(supervisor);
    const failed = expect(e.exec(`echo once >> ${quote(executions)}; touch ${quote(marker)}; sleep 30`, {
      executionLane: lane, timeout: 5000, beforeStart: () => {},
    })).rejects.toMatchObject({ code: 'unavailable' });
    await waitFor(async () => { try { await access(marker); return true; } catch { return false; } });
    process.kill(-originalFactory, 'SIGKILL'); await failed;
    await waitFor(() => !e.getStats().unavailable && !!e.getStats().factoryPid && e.getStats().factoryPid !== originalFactory);
    const after = e.getStats(); expect(after.supervisorPid).toBe(supervisor);
    const factoryParent = await new ShellExecutor().exec(`ps -o ppid= -p ${after.factoryPid}`);
    expect(Number(factoryParent.stdout.trim())).toBe(supervisor);
    expect((await e.exec('echo recovered', { executionLane: lane, beforeStart: () => {} })).stdout.trim()).toBe('recovered');
    expect((await readFile(executions, 'utf8')).trim()).toBe('once');
  });

  it('替换工厂暂停而不就绪时仍按原5秒预算清理并再次恢复', async () => {
    const e = executor({ concurrency: 1 }); await e.start();
    const initial = e.getStats();
    const channel = (e as unknown as { factory: childProcess.ChildProcess }).factory;
    expect(channel.pid).toBe(initial.supervisorPid);
    let paused = 0; let pauseError: unknown;
    const ownedPids = new Set<number>([initial.factoryPid!, ...initial.actors.map(actor => actor.pid)]);
    const listener = (message: any): void => {
      if (['factory-started', 'actor'].includes(message.type) && Number.isSafeInteger(message.pid) && message.pid > 1) ownedPids.add(message.pid);
      if (message.type === 'factory-started' && message.pid !== initial.factoryPid && !paused) {
        paused = message.pid; try { process.kill(paused, 'SIGSTOP'); } catch (error) { pauseError = error; }
      }
    };
    channel.on('message', listener);
    try {
      process.kill(-initial.factoryPid!, 'SIGKILL'); await waitFor(() => paused > 1);
      expect(pauseError).toBeUndefined(); expect(e.getStats().unavailable).toBe(true);
      const pausedState = await new ShellExecutor().exec(`ps -o stat= -p ${paused}`);
      expect(pausedState.stdout.trim()).toMatch(/^T/);
      const end = performance.now() + 6500;
      while (e.getStats().unavailable && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
      const after = e.getStats(); expect(after.unavailable).toBe(false);
      expect(after.supervisorPid).toBe(initial.supervisorPid); expect(after.factoryPid).not.toBe(paused);
      const oldState = await new ShellExecutor().exec(`ps -o stat= -p ${paused}`);
      expect(oldState.stdout.trim()).toMatch(/^(Z.*)?$/);
      expect((await e.exec('echo recovered-after-boot-timeout', observation)).stdout.trim()).toBe('recovered-after-boot-timeout');
      await e.close();
      const stopped = await new ShellExecutor().exec(`ps -o pid=,stat= -p ${[...ownedPids].join(',')}`);
      expect(stopped.stdout.split('\n').map(line => line.trim()).filter(Boolean)
        .every(line => line.split(/\s+/)[1]?.startsWith('Z'))).toBe(true);
    } finally { channel.off('message', listener); }
  }, 12_000);

  it('默认工厂连续故障在原30秒窗口内最多创建三次，窗口后恢复', async () => {
    const e = executor({ concurrency: 1 }); await e.start();
    const supervisor = e.getStats().supervisorPid!;
    for (let attempt = 0; attempt < 2; attempt++) {
      const original = e.getStats().factoryPid!; process.kill(-original, 'SIGKILL');
      await waitFor(() => !e.getStats().unavailable && !!e.getStats().factoryPid && e.getStats().factoryPid !== original);
    }
    process.kill(-e.getStats().factoryPid!, 'SIGKILL');
    await waitFor(() => e.getStats().unavailable && !e.getStats().factoryPid);
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(e.getStats()).toMatchObject({ unavailable: true, supervisorPid: supervisor });
    expect(e.getStats().factoryPid).toBeUndefined();
    await expect(e.exec('echo during-backoff', observation)).rejects.toMatchObject({ code: 'unavailable' });
    const end = performance.now() + 35_000;
    while (e.getStats().unavailable && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
    expect(e.getStats()).toMatchObject({ unavailable: false, supervisorPid: supervisor });
    expect((await e.exec('echo recovered-after-limit', observation)).stdout.trim()).toBe('recovered-after-limit');
  }, 40_000);

  it('监督进程自身故障明确停止，所属旧任务清理后不会从Master自动重放', async () => {
    const e = executor({ concurrency: 1 }); await e.start();
    const dir = await directory(), started = path.join(dir, 'started');
    const previous = e.getStats();
    const rejected = expect(e.exec(`touch ${quote(started)}; sleep 30`, observation)).rejects.toMatchObject({ code: 'unavailable' });
    await waitFor(async () => { try { await access(started); return true; } catch { return false; } });
    process.kill(-previous.supervisorPid!, 'SIGKILL'); await rejected;
    await expect(e.exec('echo no-master-replay', observation)).rejects.toMatchObject({ code: 'unavailable' });
    for (const pid of [previous.supervisorPid!, previous.factoryPid!, ...previous.actors.map(actor => actor.pid)]) {
      const result = await new ShellExecutor().exec(`ps -o stat= -p ${pid}`);
      expect(result.stdout.trim()).toMatch(/^(Z.*)?$/);
    }
  });

  it('独立命令关闭空闲观测池后仍执行清理回执，不提前以成功退出', async () => {
    const dir = await directory();
    const receipt = path.join(dir, 'closed.receipt');
    const loader = createRequire(import.meta.url).resolve('tsx/esm/api');
    const parent = import.meta.url;
    const isolated = new URL('../../src/services/isolated-shell-executor.ts', parent).href;
    const shell = new URL('../../src/services/shell-executor.ts', parent).href;
    const script = `(async()=>{
      const {tsImport}=require(${JSON.stringify(loader)});
      const {IsolatedShellExecutor}=await tsImport(${JSON.stringify(isolated)},{parentURL:${JSON.stringify(parent)}});
      const {ShellExecutor}=await tsImport(${JSON.stringify(shell)},{parentURL:${JSON.stringify(parent)}});
      const executor=new IsolatedShellExecutor(new ShellExecutor());
      await executor.exec('true',{executionLane:'observation',timeout:5000});
      await executor.close();
      require('node:fs').writeFileSync(${JSON.stringify(receipt)},'closed');
    })().catch(()=>{process.exitCode=1;});`;
    const result = await new ShellExecutor().exec(`${quote(process.execPath)} --eval ${quote(script)}`, { timeout: 10000 });
    expect(result.exitCode).toBe(0);
    expect(await readFile(receipt, 'utf8')).toBe('closed');
  });

  it('启动 PID 尚未登记时，工厂故障仍回收带私有归属的独立进程且不启动查询', async () => {
    const dir = await directory();
    const pidFile = path.join(dir, 'unregistered.pid');
    const sentinel = path.join(dir, 'must-not-start');
    let factory: childProcess.ChildProcess;
    const e = executor({ processFactory: owner => {
      const script = `const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['--eval','setInterval(()=>{},1000);process.on("disconnect",()=>{});','--',process.argv[1]],
          {detached:true,stdio:['ignore','ignore','ignore','ipc']});
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
        process.on('message',()=>{});setInterval(()=>{},1000);`;
      factory = childProcess.spawn(process.execPath, ['--eval', script, '--', owner], {
        detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      return factory;
    } });
    const failed = expect(e.exec(`touch ${quote(sentinel)}`, observation)).rejects.toMatchObject({ code: 'unavailable' });
    await waitFor(async () => { try { await access(pidFile); return true; } catch { return false; } });
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(e.getStats().actors).toEqual([]);
    process.kill(-factory!.pid!, 'SIGKILL');
    await failed;
    const state = await new ShellExecutor().exec(`ps -o stat= -p ${pid}`);
    expect(state.stdout.trim()).toMatch(/^(Z.*)?$/);
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
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
