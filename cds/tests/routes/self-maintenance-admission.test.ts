import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { endSelfUpdateDrain } from '../../src/services/deploy-drain.js';
import { setRestartWait } from '../../src/services/self-restart-wait.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
import { getHttpFixtureTrace, listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';
import type { CdsConfig, ExecOptions, ExecResult } from '../../src/types.js';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn: vi.fn(),
}));

const endpoints = ['self-update', 'self-force-sync', 'self-restart', 'self-update-dry-run'] as const;
type Endpoint = typeof endpoints[number];
type Reply = { status: number; raw: string };
const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const sha = 'a'.repeat(40);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('同实例四入口维护准入与真实请求完成条件', () => {
  let root: string, state: StateService, server: http.Server, shell: MockShellExecutor;
  let fullWorkflow: boolean, child: EventEmitter;
  let transport: ((cmd: string, options: ExecOptions | undefined, result: ExecResult) => Promise<ExecResult>) | undefined;
  let requests: Promise<Reply>[], executions: Promise<ExecResult>[], gates: ReturnType<typeof deferred>[];
  let logFds: Set<number>;
  function gate() { const value = deferred(); gates.push(value); return value; }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-maintenance-admission-'));
    for (const dir of ['cds/dist', 'cds/web/dist']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'cds/package.json'), '{}');
    fs.writeFileSync(path.join(root, 'cds/dist/index.js'), 'old backend');
    fullWorkflow = false; transport = undefined; requests = []; executions = []; gates = []; logFds = new Set();
    vi.stubEnv('CDS_PREVIEW_INSTANCE', '0');
    vi.stubEnv('CDS_SELFUPDATE_PREBUILT', '0');
    child = new EventEmitter();
    Object.assign(child, { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as ChildProcess);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const open = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args);
      if (String(args[0]) === path.join(root, 'cds/.cds/self-update-error.log')) logFds.add(fd);
      return fd;
    }) as typeof fs.openSync);
    const close = fs.closeSync.bind(fs);
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => { logFds.delete(fd); close(fd); });
    shell = new MockShellExecutor();
    shell.addResponsePattern(/.*/, ([cmd]) => {
      if (cmd.startsWith('git fetch') && !fullWorkflow) return { ...ok(), exitCode: 1, stderr: 'fixture fetch stopped' };
      if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok('main');
      if (cmd === 'git rev-parse --short HEAD') return ok(sha.slice(0, 8));
      if (cmd === 'git rev-parse HEAD') return ok(fullWorkflow ? sha : 'invalid');
      if (cmd.startsWith('git rev-parse origin/') || cmd.includes('--verify --quiet origin/')) return ok(sha);
      if (cmd.startsWith('git diff --name-only')) return ok('cds/package.json');
      if (cmd === 'node scripts/build-dist-esbuild.mjs') {
        fs.mkdirSync(path.join(root, 'cds/dist.next'), { recursive: true });
        fs.writeFileSync(path.join(root, 'cds/dist.next/index.js'), 'new backend');
      }
      return ok();
    });
    const originalExec = shell.exec.bind(shell);
    vi.spyOn(shell, 'exec').mockImplementation((cmd, options) => {
      const execution = originalExec(cmd, options).then(result => transport ? transport(cmd, options, result) : result);
      executions.push(execution);
      return execution;
    });
    state = new StateService(path.join(root, 'state.json'), root); state.load();
    const config = { repoRoot: root, worktreeBase: path.join(root, 'worktrees'), masterPort: 9900,
      workerPort: 5500, dockerNetwork: 'test', portStart: 10001, sharedEnv: {},
      rootDomains: ['example.test'], jwt: { secret: 'fixture', issuer: 'fixture' },
      mode: 'standalone', executorPort: 9901 } as CdsConfig;
    const app = express(); app.use(express.json());
    app.use('/api', createBranchRouter({ stateService: state, shell, config,
      worktreeService: new WorktreeService(shell, root), containerService: new ContainerService(shell, config) }));
    server = listenLoopbackFixture(app);
    if (!server.listening) await once(server, 'listening');
    const trace = getHttpFixtureTrace(server);
    expect(trace).toBeDefined();
    expect(server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  });

  afterEach(async () => {
    for (const value of gates) value.resolve();
    await Promise.allSettled(requests);
    await Promise.allSettled(executions);
    await state.flush();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const fd of logFds) fs.closeSync(fd);
    endSelfUpdateDrain(); setRestartWait(null); selfStatusCache._resetForTests();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function start(endpoint: Endpoint, body: unknown = { branch: 'main', drainTimeoutMs: 0, force: true }) {
    const trace = getHttpFixtureTrace(server);
    if (!trace) throw new Error('缺少自有 HTTP fixture 身份');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('夹具尚未监听');
    const payload = JSON.stringify(body);
    let req!: http.ClientRequest;
    const done = new Promise<Reply>((resolve, reject) => {
      req = http.request({ hostname: '127.0.0.1', port: address.port, path: `/api/${endpoint}`,
        method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, res => {
        let raw = '';
        res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; });
        res.on('aborted', () => reject(new Error('夹具响应中断'))); res.on('error', reject);
        res.on('end', () => {
          if (!res.complete || res.headers['x-cds-fixture-id'] !== trace.id
            || res.headers['x-cds-fixture-pid'] !== String(trace.pid)) {
            reject(new Error('夹具响应不完整或身份不匹配')); return;
          }
          resolve({ status: res.statusCode || 0, raw });
        });
      });
      req.on('error', reject); req.end(payload);
    });
    requests.push(done); void done.catch(() => {});
    return { req, done };
  }
  const post = (endpoint: Endpoint, body?: unknown) => start(endpoint, body).done;
  function busy(reply: Reply, endpoint: Endpoint) {
    expect.soft(reply.status, endpoint).toBe(endpoint === 'self-update-dry-run' ? 409 : 200);
    expect.soft(reply.raw, endpoint).toMatch(/concurrency|self_update_busy/);
  }
  async function allBusy() {
    const commands = shell.commands.length;
    for (const endpoint of endpoints) busy(await post(endpoint), endpoint);
    expect.soft(shell.commands).toHaveLength(commands);
  }

  it('dry-run先占用时四入口都拒绝，busy请求不释放原占用，完成后重新受理', async () => {
    const entered = gate(), release = gate(); let blocked = false;
    transport = async (cmd, _options, result) => {
      if (cmd.startsWith('pnpm install') && !blocked) {
        blocked = true; entered.resolve(); await release.promise;
      }
      return result;
    };
    const first = post('self-update-dry-run');
    await entered.promise;
    expect(state.getActiveSelfUpdate()).toBeNull();
    await allBusy();
    busy(await post('self-update-dry-run'), 'self-update-dry-run');
    release.resolve(); expect((await first).status).toBe(200);
    expect((await post('self-update-dry-run')).status).toBe(200);
  });

  it.each([
    ['self-update', 'git rev-parse --abbrev-ref HEAD', false],
    ['self-update', 'git rev-parse --short HEAD', true],
    ['self-force-sync', 'git rev-parse --short HEAD', true],
    ['self-restart', 'git rev-parse --abbrev-ref HEAD', false],
  ] as const)('%s首个%s await前占用，真实active rename失败也不放入兄弟', async (endpoint, command, activeWrite) => {
    const active = path.join(root, '.cds/active-update.json');
    fs.mkdirSync(active, { recursive: true });
    const entered = gate(), release = gate(); let blocked = false;
    transport = async (cmd, _options, result) => {
      if (cmd === command && !blocked) { blocked = true; entered.resolve(); await release.promise; }
      return result;
    };
    const first = post(endpoint, activeWrite ? { branch: 'main' } : {});
    await entered.promise;
    expect(fs.statSync(active).isDirectory()).toBe(true);
    if (activeWrite) expect(JSON.parse(fs.readFileSync(active + '.tmp', 'utf8')).pid).toBe(process.pid);
    expect(state.getActiveSelfUpdate()).toBeNull();
    await allBusy();
    release.resolve(); expect((await first).raw).toContain('event: error');
    expect((await post('self-update-dry-run')).status).toBe(200);
  });

  it('仍保留原持久active marker的拒绝语义，dry-run也不能写入', async () => {
    state.markSelfUpdateActive({ startedAt: new Date().toISOString(), trigger: 'manual', branch: 'main' });
    expect(state.getActiveSelfUpdate()?.pid).toBe(process.pid);
    await allBusy();
  });

  it.each(['install', 'tsc'] as const)('%s首reject后等待本轮迟返兄弟，保留原异常且不提前解锁', async round => {
    fs.writeFileSync(path.join(root, 'cds/web/package.json'), '{}');
    const entered = gate(), release = gate();
    const command = round === 'install' ? 'pnpm install --frozen-lockfile --prefer-offline --prod=false' : './node_modules/.bin/tsc --noEmit';
    const marker = path.join(root, 'late-writer-finished');
    transport = async (cmd, options, result) => {
      if (cmd !== command) return result;
      if (options?.cwd === path.join(root, 'cds/web')) {
        entered.resolve(); await release.promise;
        fs.writeFileSync(marker, round); return result;
      }
      await entered.promise; throw new Error(`${round}-original-rejection`);
    };
    let responded = false;
    const first = post('self-update-dry-run').then(reply => { responded = true; return reply; });
    await entered.promise; await nextTurn();
    const commands = shell.commands.length;
    busy(await post('self-update'), 'self-update');
    expect.soft(responded).toBe(false);
    expect.soft(shell.commands).toHaveLength(commands);
    expect(fs.existsSync(marker)).toBe(false);
    release.resolve(); const reply = await first;
    expect(reply.status).toBe(500); expect(JSON.parse(reply.raw).error).toBe(`${round}-original-rejection`);
    expect(fs.readFileSync(marker, 'utf8')).toBe(round);
    expect(shell.commands.filter(cmd => cmd === command)).toHaveLength(2);
    transport = undefined;
    expect((await post('self-update-dry-run')).status).toBe(200);
  });

  it('客户端HTTP close不是安装完成，未完成写者仍持有占用', async () => {
    const entered = gate(), release = gate(), finished = gate(); let blocked = false;
    transport = async (cmd, _options, result) => {
      if (cmd.startsWith('pnpm install') && !blocked) {
        blocked = true; entered.resolve(); await release.promise; finished.resolve();
      }
      return result;
    };
    const first = start('self-update-dry-run');
    await entered.promise;
    const closed = new Promise<void>(resolve => first.req.once('close', () => resolve()));
    first.req.destroy(); await closed;
    await expect(first.done).rejects.toThrow();
    await allBusy();
    release.resolve(); await finished.promise; await nextTurn();
    expect((await post('self-update-dry-run')).status).toBe(200);
  });

  // 只观察原500/1000/15000ms回调的生命周期，不把回调调用冒充真实elapsed或进程退出。
  function observeRestartTimers() {
    const scheduled: Array<{ ms: number; run: () => void; handle: NodeJS.Timeout; live: boolean }> = [];
    const realSet = global.setTimeout, realClear = global.clearTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if ((fn.name === 'launch' && (ms === 0 || ms === 500)) || ms === 1000 || ms === 15_000) {
        const handle = { unref: () => handle } as unknown as NodeJS.Timeout;
        scheduled.push({ ms: ms!, run: () => fn(...args), handle, live: true }); return handle;
      }
      return realSet(fn, ms, ...args);
    }) as typeof setTimeout);
    vi.spyOn(global, 'clearTimeout').mockImplementation((handle) => {
      const entry = scheduled.find(value => value.handle === handle);
      if (entry) entry.live = false; else realClear(handle);
    });
    return (ms: number) => {
      // 原flush也保留同为1000ms的race回调；只消费launch之后最近安排的退出回调。
      const entry = scheduled.slice().reverse().find(value => value.live && value.ms === ms);
      expect(entry, `缺少原${ms}ms回调`).toBeDefined();
      if (!entry) throw new Error('原重启回调未安排');
      entry.live = false; entry.run();
    };
  }

  it.each(['self-update', 'self-force-sync', 'self-restart'] as const)('%s响应结束后仍覆盖launch、child close、退出与原存活回收窗口', async endpoint => {
    fullWorkflow = true;
    const fire = observeRestartTimers();
    expect((await post(endpoint)).raw).toContain('event: done');
    expect(state.getActiveSelfUpdate()).toBeNull();
    busy(await post('self-update-dry-run'), 'self-update-dry-run');
    expect(spawn).not.toHaveBeenCalled();
    fire(endpoint === 'self-force-sync' ? 0 : 500);
    expect(spawn).toHaveBeenCalledWith('bash', ['./exec_cds.sh', 'daemon'], expect.objectContaining({ cwd: path.join(root, 'cds'), detached: true }));
    child.emit('error', new Error('fixture asynchronous error')); child.emit('close', 1);
    busy(await post('self-update-dry-run'), 'self-update-dry-run');
    fire(1000); expect(process.exit).toHaveBeenCalledWith(0);
    busy(await post('self-update-dry-run'), 'self-update-dry-run');
    fire(15_000);
    expect((await post('self-update-dry-run')).status).toBe(200);
  });

  it.each(['self-restart', 'self-force-sync'] as const)('%s同步spawn失败遵守R原退出或继续存活的释放时机', async endpoint => {
    fullWorkflow = true;
    vi.mocked(spawn).mockImplementation(() => { throw new Error('fixture synchronous spawn failure'); });
    const fire = observeRestartTimers();
    expect((await post(endpoint)).raw).toContain('event: done');
    busy(await post('self-update-dry-run'), 'self-update-dry-run');
    fire(endpoint === 'self-force-sync' ? 0 : 500);
    if (endpoint === 'self-restart') {
      busy(await post('self-update-dry-run'), 'self-update-dry-run');
      expect(process.exit).not.toHaveBeenCalled();
      fire(1000); expect(process.exit).toHaveBeenCalledWith(1);
    } else {
      expect((await post('self-update-dry-run')).status).toBe(200);
      expect(process.exit).not.toHaveBeenCalled();
    }
  });

  it('force-sync热路径build首reject仍等待迟返esbuild，不提前放入同树维护写者', async () => {
    fullWorkflow = true;
    const entered = gate(), release = gate();
    const marker = path.join(root, 'cds/dist.next/late-build-finished');
    const build = 'node scripts/build-dist-esbuild.mjs', tsc = './node_modules/.bin/tsc --noEmit';
    const dispatched: Array<{ cmd: string; options?: ExecOptions }> = [];
    transport = async (cmd, options, result) => {
      // analyzer将后端应用路径归入hotReloadablePaths，不命中RESTART_PATTERNS或web-only。
      if (cmd.startsWith('git diff --name-only')) return ok('cds/src/routes/branches.ts');
      if (cmd !== build && cmd !== tsc) return result;
      dispatched.push({ cmd, options });
      if (cmd === build) {
        entered.resolve(); await release.promise;
        fs.writeFileSync(marker, 'late esbuild'); return result;
      }
      await entered.promise; throw new Error('hot-build-original-rejection');
    };
    let responded = false;
    const first = post('self-force-sync').then(reply => { responded = true; return reply; });
    await entered.promise; await nextTurn();
    expect(dispatched.map(call => call.cmd)).toEqual([build, tsc]);
    expect(dispatched[0].options).toMatchObject({ cwd: path.join(root, 'cds'), timeout: 60_000, env: { OUT_DIR: 'dist.next' } });
    expect(dispatched[1].options).toMatchObject({ cwd: path.join(root, 'cds'), timeout: 120_000 });
    const commands = shell.commands.length;
    busy(await post('self-update-dry-run'), 'self-update-dry-run');
    expect.soft(responded).toBe(false);
    expect.soft(shell.commands).toHaveLength(commands);
    expect(fs.existsSync(marker)).toBe(false);
    release.resolve(); const reply = await first;
    expect(reply.raw).toContain('skipTsc');
    expect(reply.raw).toContain('hot-build-original-rejection');
    expect(reply.raw).not.toContain('event: done');
    expect(fs.readFileSync(marker, 'utf8')).toBe('late esbuild');
    expect(dispatched.map(call => call.cmd)).toEqual([build, tsc]);
    expect(spawn).not.toHaveBeenCalled(); expect(process.exit).not.toHaveBeenCalled();
    transport = undefined;
    expect((await post('self-update-dry-run')).status).toBe(200);
  });
});
