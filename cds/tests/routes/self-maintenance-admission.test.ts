import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { Writable } from 'node:stream';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBranchRouter, WEB_DIST_BUILD_COMMAND } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor, ShellExecutor } from '../../src/services/shell-executor.js';
import { IsolatedShellExecutor, OperationExecutionError } from '../../src/services/isolated-shell-executor.js';
import { SelfMaintenanceRuntime } from '../../src/services/self-maintenance-runtime.js';
import { endSelfUpdateDrain } from '../../src/services/deploy-drain.js';
import { setRestartWait } from '../../src/services/self-restart-wait.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
import { CDS_RESTART_PERMIT_COMMAND } from '../../src/services/self-update-handoff.js';
import { getHttpFixtureTrace, listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';
import type { CdsConfig, ExecAssignment, ExecOptions, ExecResult, IShellExecutor } from '../../src/types.js';

const { restartSpawn } = vi.hoisted(() => ({ restartSpawn: vi.fn<typeof import('node:child_process').spawn>() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: ((...args: Parameters<typeof actual.spawn>) => {
    // 只截许可脚本；真实owned supervisor/actor的ChildProcess及参数原样透传。
    if (args[0] === 'bash' && Array.isArray(args[1]) && args[1][0] === '-p' && args[1][1] === '-c') {
      return restartSpawn(...args);
    }
    return actual.spawn(...args);
  }) as typeof actual.spawn };
});

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
  let maintenance: SelfMaintenanceRuntime, filesPool: IsolatedShellExecutor;
  let fullWorkflow: boolean, child: EventEmitter & Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>;
  let permitWrites: string[], childExitCode: number | undefined;
  let permitWrite: ((value: string) => Promise<void>) | undefined, pipeClose: (() => Promise<void>) | undefined;
  let tearingDown: boolean, pendingDelays: (() => void)[];
  let transport: ((cmd: string, options: ExecOptions | undefined, result: ExecResult) => Promise<ExecResult>) | undefined;
  let requests: Promise<Reply>[], executions: Promise<ExecResult>[], gates: ReturnType<typeof deferred>[];
  let logFds: Set<number>;
  let realArtifactDeletes: boolean, artifactDeletePaths: Set<string>;
  let realNoopGitEnv: Record<string, string> | undefined;
  let ownedDeletes: Array<{ ownerId: string | null; assignment?: ExecAssignment; result: ExecResult;
    removed: string[]; timeout?: number }>;
  function gate() { const value = deferred(); gates.push(value); return value; }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-maintenance-admission-'));
    for (const dir of ['cds/dist', 'cds/web/dist']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'cds/package.json'), '{}');
    fs.writeFileSync(path.join(root, 'cds/dist/index.js'), 'old backend');
    fullWorkflow = false; transport = undefined; requests = []; executions = []; gates = []; logFds = new Set();
    realArtifactDeletes = false; artifactDeletePaths = new Set(); ownedDeletes = [];
    realNoopGitEnv = undefined;
    permitWrites = []; childExitCode = undefined; permitWrite = undefined; pipeClose = undefined;
    tearingDown = false; pendingDelays = [];
    vi.stubEnv('CDS_PREVIEW_INSTANCE', '0');
    vi.stubEnv('CDS_SELFUPDATE_PREBUILT', '0');
    child = new EventEmitter() as typeof child;
    const pipe = new Writable({
      write(chunk, _encoding, callback) {
        const value = String(chunk); permitWrites.push(value);
        Promise.resolve().then(() => permitWrite?.(value)).then(() => callback(), callback);
      },
      final(callback) {
        Promise.resolve().then(() => pipeClose?.()).then(() => {
          Object.assign(child, { exitCode: childExitCode ?? (permitWrites.length ? 0 : 1) });
          child.emit('close', child.exitCode, null); callback();
        }, callback);
      },
    });
    // 仅补齐受控子进程形状；真实pipe/进程退出另由原叶独立用例证明，不把PID当ready。
    Object.assign(child, { pid: process.pid, exitCode: null, signalCode: null,
      stdio: [null, null, null, pipe], unref: vi.fn() });
    restartSpawn.mockReset().mockReturnValue(child as ChildProcess);
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
    filesPool = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 1 });
    // 旧Mock命令只作受控控制流/分类，不伪造assignment或物理停止；五目录交给真实owned worker。
    const controlledShell: IShellExecutor = { exec: shell.exec.bind(shell), execOwnedOperation: async (cmd, options) => {
      if (/self-maintenance-files-process\.(ts|js)/.test(cmd)) return filesPool.execOwnedOperation(cmd, options);
      // 仅noOp代表例开启；Git命令原样经真实owned进程执行，不让Mock伪造checkout/reset。
      if (realNoopGitEnv && cmd.startsWith('git ')) {
        return filesPool.execOwnedOperation(cmd, { ...options, env: { ...options.env, ...realNoopGitEnv } });
      }
      // 仅产物I/O代表例启用固定系统rm；Git/build/Docker仍由原Mock控制，绝不执行它们。
      if (realArtifactDeletes && /^(?:\/bin\/)?rm -rf -- /.test(cmd)) {
        // 只接受原shellQuote形状及本fixture有限产物路径，不给真实OS透传任意删除目标。
        const args = cmd.replace(/^(?:\/bin\/)?rm -rf -- /, '');
        const quoted = args.match(/'[^']*'/g) ?? [];
        const artifact = /^(?:dist\.next|dist\.old\.[A-Za-z0-9._-]+|web\/dist\.next|web\/dist\.previous\.old\.[A-Za-z0-9._-]+|\.cds\/prebuilt-self-update-\d+)$/;
        const outside = quoted.some(value => !artifact.test(path.relative(path.join(root, 'cds'), value.slice(1, -1))));
        if (!quoted.length || quoted.join(' ') !== args || outside) {
          throw new Error('夹具拒绝非本票固定产物删除命令');
        }
        const ownerId = maintenance.observe()?.id ?? null;
        const paths = new Set(artifactDeletePaths);
        for (const dir of [path.join(root, 'cds'), path.join(root, 'cds/web')]) {
          for (const name of fs.readdirSync(dir)) {
            if (name.startsWith('dist.old.') || name.startsWith('dist.previous.old.')) paths.add(path.join(dir, name));
          }
        }
        const present = [...paths].filter(value => fs.existsSync(value));
        let assignment: ExecAssignment | undefined;
        const result = await filesPool.execOwnedOperation(cmd, { ...options, onAssigned: value => {
          assignment = { ...value }; options.onAssigned?.(value);
        } });
        ownedDeletes.push({ ownerId, assignment, result, timeout: options.timeout,
          removed: present.filter(value => !fs.existsSync(value)) });
        return result;
      }
      options.beforeStart();
      try {
        const result = await shell.exec(cmd, options);
        if (options.signal?.aborted) throw new OperationExecutionError('cancelled');
        return result;
      } catch (error) {
        if (error instanceof OperationExecutionError) throw error;
        // 仅测试侧明确分类已settle的Mock拒绝，保留原异常消息与原promise收尾，不冒充进程清理。
        const failure = new OperationExecutionError('callback');
        failure.message = error instanceof Error ? error.message : String(error);
        throw failure;
      }
    } };
    maintenance = new SelfMaintenanceRuntime(controlledShell, root, () => {});
    state = new StateService(path.join(root, 'state.json'), root); state.load();
    const config = { repoRoot: root, worktreeBase: path.join(root, 'worktrees'), masterPort: 9900,
      workerPort: 5500, dockerNetwork: 'test', portStart: 10001, sharedEnv: {},
      rootDomains: ['example.test'], jwt: { secret: 'fixture', issuer: 'fixture' },
      mode: 'standalone', executorPort: 9901 } as CdsConfig;
    const app = express(); app.use(express.json());
    app.use('/api', createBranchRouter({ stateService: state, shell: controlledShell, config, selfMaintenanceRuntime: maintenance,
      worktreeService: new WorktreeService(shell, root), containerService: new ContainerService(shell, config) }));
    server = listenLoopbackFixture(app);
    if (!server.listening) await once(server, 'listening');
    const trace = getHttpFixtureTrace(server);
    expect(trace).toBeDefined();
    expect(server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  });

  afterEach(async () => {
    tearingDown = true;
    // 失败清理只解除未触发的delay，不执行exit或15秒回调，也不计作断言证据。
    for (const value of gates) value.resolve();
    for (const resume of pendingDelays) resume();
    await Promise.allSettled(requests);
    await Promise.allSettled(executions);
    await state.flush();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await maintenance.close(); await filesPool.close();
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

  function observeMasterRecursiveRemoval() {
    const calls: Array<{ target: string; existed: boolean }> = [];
    const remove = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'rmSync').mockImplementation(((target, options) => {
      const resolved = path.resolve(String(target));
      if (options?.recursive && resolved.startsWith(path.join(root, 'cds') + path.sep)) {
        calls.push({ target: resolved, existed: fs.existsSync(target) });
      }
      return remove(target, options); // 透明记录，不阻止真实删除，也不伪造错误。
    }) as typeof fs.rmSync);
    return calls;
  }

  function assertOwnedDeletes(ownerId: string, requiredPaths: string[]) {
    expect.soft(ownedDeletes.length).toBeGreaterThan(0);
    for (const receipt of ownedDeletes) {
      expect(receipt.ownerId).toBe(ownerId);
      expect(receipt.result.exitCode, receipt.result.stderr).toBe(0);
      expect(receipt.assignment).toMatchObject({ lane: 'operation' });
      expect(Number.isSafeInteger(receipt.assignment?.actorPid) && receipt.assignment!.actorPid! > 1).toBe(true);
      expect(receipt.assignment?.actorPid).not.toBe(process.pid);
      expect(receipt.timeout).toBeGreaterThan(0);
      expect(receipt.timeout).toBeLessThanOrEqual(15 * 60_000);
    }
    for (const target of requiredPaths) {
      expect.soft(ownedDeletes.some(receipt => receipt.removed.includes(target)), target).toBe(true);
    }
  }

  it.each(['self-update', 'self-force-sync'] as const)('%s真实同SHA与dirty源码仍对齐目标，noOp不创建五目录快照或删除任务', async endpoint => {
    const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: '/usr/bin/false', GIT_ALLOW_PROTOCOL: 'file' };
    const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], {
      env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git(['init', '--quiet', '--initial-branch=before']);
    fs.writeFileSync(path.join(root, '.gitignore'), '/state.json*\n/.cds/\n/cds/\n');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'committed tracked\n');
    git(['add', '--', '.gitignore', 'tracked.txt']);
    git(['-c', 'user.name=本轮Git夹具', '-c', 'user.email=owned-fixture@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', '无变化更新夹具基线']);
    const head = git(['rev-parse', 'HEAD']);
    git(['branch', 'main', head]);
    git(['remote', 'add', 'origin', root]);
    git(['update-ref', 'refs/remotes/origin/main', head]);
    // origin仅指向本fixture自身；真实fetch走本地file传输，禁止外部网络协议。
    expect(git(['remote', 'get-url', 'origin'])).toBe(root);
    expect(git(['rev-parse', 'main'])).toBe(head);
    expect(git(['rev-parse', 'origin/main'])).toBe(head);
    expect(git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).toBe('before');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'staged dirty\n');
    git(['add', '--', 'tracked.txt']);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'unstaged dirty after staging\n');
    expect(git(['status', '--porcelain=v1', '--untracked-files=all'])).toBe('MM tracked.txt');
    const files = new Map([
      ['dist/index.js', 'original backend\n'], ['dist/.build-sha', head],
      ['web/dist/index.html', '<html>original web</html>\n'], ['web/dist/.build-sha', head],
      ['web/dist.previous/previous.js', 'original previous web\n'],
      ['node_modules/fixture.js', 'original backend dependency\n'],
      ['node_modules/.cds-install-stamp', 'original backend install stamp\n'],
      ['web/node_modules/fixture.js', 'original web dependency\n'],
      ['web/node_modules/.cds-install-stamp', 'original web install stamp\n'],
    ]);
    const cds = path.join(root, 'cds');
    for (const [relative, value] of files) {
      const file = path.join(cds, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
    }
    for (const relative of ['dist', 'web/dist', 'web/dist.previous', 'node_modules', 'web/node_modules']) {
      expect(fs.statSync(path.join(cds, relative)).isDirectory()).toBe(true);
    }
    expect(fs.existsSync(path.join(cds, 'dist/.build-error'))).toBe(false);
    expect(fs.existsSync(path.join(cds, 'web/dist/.build-error'))).toBe(false);
    type Dispatch = { command: string; action?: string; ownerId: string | null;
      assignment?: ExecAssignment; exitCode?: number };
    const gitJobs: Dispatch[] = [], fileJobs: Dispatch[] = [];
    const execute = filesPool.execOwnedOperation.bind(filesPool);
    vi.spyOn(filesPool, 'execOwnedOperation').mockImplementation(async (command, options) => {
      const worker = /self-maintenance-files-process\.(ts|js)/.test(command);
      const input = worker ? JSON.parse(options.stdin || '{}') as { action: string; ownerId: string } : undefined;
      const dispatch: Dispatch = { command, action: input?.action, ownerId: maintenance.observe()?.id ?? null };
      if (input) {
        expect(input.ownerId).toBe(dispatch.ownerId); fileJobs.push(dispatch);
      } else {
        expect(command.startsWith('git ')).toBe(true); gitJobs.push(dispatch);
      }
      const result = await execute(command, { ...options, onAssigned: assignment => {
        dispatch.assignment = { ...assignment }; options.onAssigned?.(assignment);
      } });
      dispatch.exitCode = result.exitCode;
      return result;
    });
    const backupPrefix = path.join(fs.realpathSync(root), 'cds/.cds/restart-rollback-');
    // 真实历史损坏记录也不能让noOp进入retention读取、分配或清理路径。
    const retentionFile = path.join(root, 'cds/.cds/checkpoint-retention.json');
    fs.mkdirSync(path.dirname(retentionFile), { recursive: true });
    fs.writeFileSync(retentionFile, 'unknown historical retention record\n', { mode: 0o600 });
    const backup = vi.spyOn(fs, 'mkdtempSync');
    realNoopGitEnv = env;
    const trace = getHttpFixtureTrace(server)!;
    const arrivalCount = trace.arrivals.length;
    const reply = await post(endpoint, { branch: 'main', force: false, drainTimeoutMs: 0 });
    // HTTP结束不冒充业务finally完成；沿原it预算等同票清理真实终态，不增加时间预算。
    while (maintenance.observe() !== null) await nextTurn();
    expect(reply.status).toBe(200);
    expect(reply.raw).toContain('event: done');
    expect(reply.raw).toMatch(/"step"\s*:\s*"no-op"/);
    expect(reply.raw).toMatch(/"mode"\s*:\s*"noOp"/);
    expect(reply.raw).not.toContain('event: error');
    expect(trace.arrivals.slice(arrivalCount)).toEqual([expect.objectContaining({ method: 'POST',
      url: '/api/' + endpoint, localAddress: '127.0.0.1', status: 200 })]);
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
    expect(git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).toBe('main');
    expect(git(['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
    expect(git(['show', ':tracked.txt'])).toBe('committed tracked');
    expect(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8')).toBe('committed tracked\n');
    expect(gitJobs.some(job => job.command === 'git checkout -f main')).toBe(true);
    expect(gitJobs.some(job => job.command === 'git reset --hard origin/main')).toBe(endpoint === 'self-force-sync');
    for (const job of [...gitJobs, ...fileJobs]) {
      expect(job.exitCode).toBe(0); expect(job.ownerId).not.toBeNull();
      expect(job.assignment).toMatchObject({ lane: 'operation' });
      expect(Number.isSafeInteger(job.assignment?.actorPid) && job.assignment!.actorPid! > 1).toBe(true);
      expect(job.assignment?.actorPid).not.toBe(process.pid);
    }
    for (const [relative, value] of files) expect(fs.readFileSync(path.join(cds, relative), 'utf8')).toBe(value);
    expect(permitWrites).toEqual([]); expect(restartSpawn).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    expect(state.getSelfUpdateHistory(1)[0]).toMatchObject({ status: 'success', updateMode: 'noOp', noOp: true });
    // 旧b7应仅在以下工作量断言语义RED：已成功noOp却先snapshot再discard并创建过备份。
    expect.soft(fileJobs.map(job => job.action)).toEqual([]);
    expect.soft(backup.mock.calls.filter(([name]) => String(name).startsWith(backupPrefix))).toEqual([]);
    expect(fs.readFileSync(retentionFile, 'utf8')).toBe('unknown historical retention record\n');
  });

  it.each([
    ['self-update', 'fetch'], ['self-force-sync', 'fetch'],
    ['self-update', 'invalid-target'], ['self-force-sync', 'invalid-target'],
  ] as const)('%s在%s早拒绝时保留真实Git的HEAD、分支与两层未提交修改，不做备份或回滚', async (endpoint, failure) => {
    const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: '/usr/bin/false' };
    const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], {
      env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    git(['init', '--quiet', '--initial-branch=main']);
    fs.writeFileSync(path.join(root, '.gitignore'), '/state.json*\n/.cds/\n/cds/\n');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'committed tracked\n');
    fs.writeFileSync(path.join(root, 'second.txt'), 'committed second\n');
    git(['add', '--', '.gitignore', 'tracked.txt', 'second.txt']);
    git(['-c', 'user.name=本轮Git夹具', '-c', 'user.email=owned-fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', '测试夹具基线']);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'staged bytes\n'); git(['add', '--', 'tracked.txt']);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'unstaged bytes after staging\n');
    fs.writeFileSync(path.join(root, 'second.txt'), 'second unstaged bytes\n');
    const snapshot = () => ({
      head: git(['rev-parse', 'HEAD']).trim(), branch: git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim(),
      status: git(['status', '--porcelain=v1', '-z', '--untracked-files=all']), indexEntries: git(['ls-files', '--stage', '-z']),
      staged: git(['show', ':tracked.txt']), stagedDiff: git(['diff', '--cached', '--binary']), worktreeDiff: git(['diff', '--binary']),
      tracked: fs.readFileSync(path.join(root, 'tracked.txt')), second: fs.readFileSync(path.join(root, 'second.txt')),
      index: fs.readFileSync(path.join(root, '.git/index')),
    });
    const before = snapshot(); expect(before.status).toContain('MM tracked.txt');
    expect(before.staged).toBe('staged bytes\n'); expect(before.tracked.toString()).toBe('unstaged bytes after staging\n');
    const reads = new Map<string, string[]>([
      ['git rev-parse --short HEAD', ['rev-parse', '--short', 'HEAD']],
      ['git rev-parse HEAD', ['rev-parse', 'HEAD']],
      ['git symbolic-ref --quiet --short HEAD', ['symbolic-ref', '--quiet', '--short', 'HEAD']],
      ["git for-each-ref --sort=-committerdate --format='%(refname:short)%1f%(committerdate:iso8601-strict)%1f%(objectname:short)%1f%(subject)%1f%(symref)' refs/remotes/origin/",
        ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%1f%(committerdate:iso8601-strict)%1f%(objectname:short)%1f%(subject)%1f%(symref)', 'refs/remotes/origin/']],
      [`git checkout -f -B 'main' ${before.head}`, ['checkout', '-f', '-B', 'main', before.head]],
    ]);
    transport = async (cmd, options, result) => {
      expect(options?.cwd).toBe(cmd === './exec_cds.sh nginx-render' ? path.join(root, 'cds') : root);
      if (cmd === 'git fetch --all --prune') return failure === 'fetch'
        ? { ...ok(), exitCode: 1, stderr: 'fixture remote unavailable' } : ok();
      const args = reads.get(cmd);
      if (args) return ok(git(args));
      if (cmd.startsWith('git ')) throw new Error('未声明的夹具Git命令: ' + cmd);
      return result;
    };
    const backup = vi.spyOn(fs, 'mkdtempSync'), copy = vi.spyOn(fs.promises, 'cp');
    const reply = await post(endpoint, { branch: failure === 'fetch' ? 'main' : 'invalid;target', force: true });
    await nextTurn(); await Promise.allSettled(executions);
    expect(reply.raw).toContain('event: error'); expect(reply.raw).not.toContain('event: done');
    expect(reply.raw).toContain(failure === 'fetch' ? 'fixture remote unavailable' : '含不安全字符');
    expect(snapshot()).toEqual(before);
    expect(shell.commands.filter(cmd => /^git (checkout|reset)\b/.test(cmd))).toEqual([]);
    expect(shell.commands.some(cmd => /pnpm|build-dist-esbuild|nginx-render/.test(cmd))).toBe(false);
    expect(backup.mock.calls.filter(([name]) => String(name).startsWith(path.join(root, 'cds/.cds/restart-rollback-')))).toEqual([]);
    expect(copy).not.toHaveBeenCalled(); expect(restartSpawn).not.toHaveBeenCalled(); expect(process.exit).not.toHaveBeenCalled();
  });

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
    expect(maintenance.observe()).toMatchObject({ stopRequested: true, activeJobCount: 1 });
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

  function holdFinalFlush(call = 2) {
    const entered = gate(), release = gate(), flush = state.flush.bind(state); let calls = 0;
    vi.spyOn(state, 'flush').mockImplementation(async () => {
      if (++calls === call) { entered.resolve(); await release.promise; }
      return flush();
    });
    return { entered: entered.promise, release };
  }

  // 只观察原delay/剩余一秒/15000ms回调；不把手动回调冒充真实elapsed或进程退出。
  function observeRestartTimers() {
    const scheduled: Array<{ ms: number; run: () => void; handle: NodeJS.Timeout; live: boolean; exit: boolean }> = [];
    const entered = gate();
    const realSet = global.setTimeout, realClear = global.clearTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const exit = String(fn).includes('process.exit(0)');
      const delay = !exit && (ms === 0 || ms === 500);
      if (delay || exit || ms === 1000 || ms === 15_000) {
        const handle = { unref: () => handle } as unknown as NodeJS.Timeout;
        const entry = { ms: ms!, run: () => fn(...args), handle, live: true, exit };
        scheduled.push(entry);
        if (delay) {
          entered.resolve();
          const resume = () => { if (entry.live) { entry.live = false; entry.run(); } };
          pendingDelays.push(resume);
          if (tearingDown) queueMicrotask(resume);
        }
        return handle;
      }
      return realSet(fn, ms, ...args);
    }) as typeof setTimeout);
    vi.spyOn(global, 'clearTimeout').mockImplementation((handle) => {
      const entry = scheduled.find(value => value.handle === handle);
      if (entry) entry.live = false; else realClear(handle);
    });
    const fire = (ms: number) => {
      // 最终flush也有一秒race；退出必须取生产实际安排的剩余期限回调，而非误触flush。
      const entry = scheduled.slice().reverse().find(value => value.live
        && (ms === 1000 ? value.exit : !value.exit && value.ms === ms));
      expect(entry, `缺少原${ms}ms回调`).toBeDefined();
      if (!entry) throw new Error('原重启回调未安排');
      if (ms === 1000) {
        expect(entry.ms).toBeGreaterThanOrEqual(0);
        expect(entry.ms).toBeLessThanOrEqual(1000);
      }
      entry.live = false; entry.run();
    };
    return { entered: entered.promise, fire };
  }

  it.each(['self-update', 'self-force-sync', 'self-restart'] as const)('%s响应须等严格交接，child close、退出与原存活回收窗口仍占用', async endpoint => {
    fullWorkflow = true;
    const { entered, fire } = observeRestartTimers(), finalFlush = holdFinalFlush();
    const writing = gate(), acknowledge = gate(), closing = gate(), close = gate();
    permitWrite = async value => { expect(value).toBe('restart\n'); writing.resolve(); await acknowledge.promise; };
    pipeClose = async () => { closing.resolve(); await close.promise; };
    let responded = false;
    const first = post(endpoint).then(reply => { responded = true; return reply; });
    await entered;
    expect(state.getActiveSelfUpdate()).toBeNull();
    await allBusy();
    expect(responded).toBe(false);
    expect(restartSpawn).not.toHaveBeenCalled();
    fire(endpoint === 'self-force-sync' ? 0 : 500);
    await finalFlush.entered;
    expect(restartSpawn).toHaveBeenCalledWith('bash', ['-p', '-c', CDS_RESTART_PERMIT_COMMAND],
      expect.objectContaining({ cwd: path.join(root, 'cds'), detached: true,
        stdio: ['ignore', expect.any(Number), expect.any(Number), 'pipe'] }));
    expect(Number.isSafeInteger(child.pid) && child.pid! > 0).toBe(true);
    expect(permitWrites).toEqual([]);
    expect(responded).toBe(false);
    expect(process.exit).not.toHaveBeenCalled();
    await allBusy();
    finalFlush.release.resolve(); await writing.promise;
    expect(permitWrites).toEqual(['restart\n']);
    expect(responded).toBe(false);
    await allBusy();
    acknowledge.resolve(); expect((await first).raw).toContain('event: done');
    await closing.promise;
    child.emit('error', new Error('fixture asynchronous error'));
    const closed = once(child, 'close'); childExitCode = 1; close.resolve(); await closed;
    expect(child.exitCode).toBe(1);
    await allBusy();
    fire(1000); expect(process.exit).toHaveBeenCalledWith(0);
    await allBusy();
    fire(15_000);
    expect((await post('self-update-dry-run')).status).toBe(200);
  });

  it.each(['self-restart', 'self-force-sync'] as const)('%s同步spawn失败取消重启，异步保存及回滚收尾后才释放', async endpoint => {
    fullWorkflow = true;
    restartSpawn.mockImplementation(() => { throw new Error('fixture synchronous spawn failure'); });
    const { entered, fire } = observeRestartTimers(), preFlush = holdFinalFlush(1);
    const rollingBack = gate(), rollback = gate();
    if (endpoint === 'self-force-sync') transport = async (cmd, _options, result) => {
      if (cmd === `git checkout -f --detach ${sha}`) { rollingBack.resolve(); await rollback.promise; }
      return result;
    };
    let responded = false;
    const first = post(endpoint).then(reply => { responded = true; return reply; });
    await preFlush.entered;
    // 首轮保存仍held；先等终态缓存原只读refresh结束，不把后台命令误记成兄弟写入。
    while (['queued', 'running'].includes(selfStatusCache.getActiveJob()?.status ?? '')) {
      await nextTurn();
    }
    await allBusy();
    expect(responded).toBe(false);
    preFlush.release.resolve(); await entered;
    expect(permitWrites).toEqual([]);
    expect(responded).toBe(false);
    expect(process.exit).not.toHaveBeenCalled();
    await allBusy();
    fire(endpoint === 'self-force-sync' ? 0 : 500);
    if (endpoint === 'self-force-sync') {
      await rollingBack.promise;
      expect(responded).toBe(false);
      expect(process.exit).not.toHaveBeenCalled();
      await allBusy();
      rollback.resolve();
    }
    const failure = await first;
    expect(restartSpawn).toHaveBeenCalledOnce();
    expect(failure.raw).toContain('event: error');
    expect(failure.raw).not.toContain('event: done');
    expect(process.exit).not.toHaveBeenCalled();
    expect((await post('self-update-dry-run')).status).toBe(200);
  });

  it('force-sync热路径build首reject仍等待迟返esbuild，不提前放入同树维护写者', async () => {
    fullWorkflow = true;
    const entered = gate(), release = gate();
    const rollingBack = gate(), rollback = gate();
    const marker = path.join(root, 'cds/dist.next/late-build-finished');
    const build = 'node scripts/build-dist-esbuild.mjs', tsc = './node_modules/.bin/tsc --noEmit';
    const dispatched: Array<{ cmd: string; options?: ExecOptions }> = [];
    transport = async (cmd, options, result) => {
      if (cmd === `git checkout -f --detach ${sha}`) {
        rollingBack.resolve(); await rollback.promise; return result;
      }
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
    expect(maintenance.observe()).toMatchObject({ stopRequested: true, activeJobCount: 1 });
    const ownerId = maintenance.observe()!.id;
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
    expect(restartSpawn).not.toHaveBeenCalled(); expect(process.exit).not.toHaveBeenCalled();
    await rollingBack.promise;
    expect(responded).toBe(true);
    expect(maintenance.observe()).toMatchObject({ id: ownerId, source: 'self-force-sync',
      phase: 'rollback', stopRequested: true, activeJobCount: 1 });
    await allBusy();
    expect(maintenance.observe()?.id).toBe(ownerId);
    rollback.resolve();
    // HTTP error先结束，finally仍须完成真实restore/Git/nginx/discard；沿原it总预算观察，不加时限。
    while (maintenance.observe() !== null) await nextTurn();
    transport = undefined;
    expect((await post('self-update-dry-run')).status).toBe(200);
  });

  it.each(['self-update', 'self-force-sync'] as const)('%s原阶段截止后不换代，真实回滚先恢复旧产物且不发重启许可', async endpoint => {
    fullWorkflow = true; realArtifactDeletes = true;
    const cds = path.join(root, 'cds'), current = path.join(cds, 'dist');
    const originalNow = performance.now.bind(performance); let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => originalNow() + elapsed);
    let emitted = false;
    transport = async (cmd, _options, result) => {
      if (cmd === 'node scripts/build-dist-esbuild.mjs') {
        expect(fs.readFileSync(path.join(cds, 'dist.next/index.js'), 'utf8')).toBe('new backend');
        emitted = true; elapsed = 15 * 60_000;
      }
      return result;
    };
    const rename = fs.renameSync.bind(fs), activations: Array<{ from: string; to: string }> = [];
    vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
      if (String(from) === current || String(to) === current) activations.push({ from: String(from), to: String(to) });
      return rename(from, to);
    }) as typeof fs.renameSync);
    const stopping = vi.spyOn(maintenance, 'requestStop');
    const reply = await post(endpoint);
    while (maintenance.observe() !== null) await nextTurn();
    expect(emitted).toBe(true); expect(stopping).toHaveBeenCalled();
    expect(reply.status).toBe(200); expect(reply.raw).toContain('event: error');
    expect(reply.raw).not.toContain('event: done');
    expect(fs.readFileSync(path.join(current, 'index.js'), 'utf8')).toBe('old backend');
    expect(permitWrites).toEqual([]); expect(restartSpawn).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    // 构建已经真实产出且回滚完整，旧实现只在先换代后检查到期的来源谓词变红。
    expect.soft(activations).toEqual([]);
  });

  it('force-sync真实候选与孤儿清理经同票归属终态，成功换代不在Master递归删除', async () => {
    fullWorkflow = true; realArtifactDeletes = true;
    const cds = path.join(root, 'cds'), next = path.join(cds, 'dist.next'), orphan = path.join(cds, 'dist.old.fixture');
    for (const dir of [next, orphan]) {
      fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'nested/stale.js'), 'original stale artifact');
      artifactDeletePaths.add(dir);
    }
    const masterRemovals = observeMasterRecursiveRemoval(), { entered, fire } = observeRestartTimers();
    const first = post('self-force-sync');
    await entered;
    const owner = maintenance.observe()!;
    expect(owner).toMatchObject({ source: 'self-force-sync', stopRequested: false });
    expect(fs.readFileSync(path.join(cds, 'dist/index.js'), 'utf8')).toBe('new backend');
    expect(fs.readFileSync(path.join(cds, 'dist/.build-sha'), 'utf8').trim()).toBe(sha);
    expect(fs.existsSync(next)).toBe(false); expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.readdirSync(cds).filter(name => name.startsWith('dist.old.'))).toEqual([]);
    fire(0);
    const reply = await first;
    expect(reply.status).toBe(200); expect(reply.raw).toContain('event: done');
    expect(reply.raw).not.toContain('event: error');
    expect(permitWrites).toEqual(['restart\n']); expect(process.exit).not.toHaveBeenCalled();
    // 主流程和真实产物先硬确认；旧生产应只在以下来源/归属谓词语义变红。
    expect.soft(masterRemovals).toEqual([]);
    assertOwnedDeletes(owner.id, [next, orphan]);
  });

  it('self-update真实预构建失败暂存与web换代收尾经同票归属，不在Master递归删除', async () => {
    fullWorkflow = true; realArtifactDeletes = true;
    vi.stubEnv('CDS_SELFUPDATE_PREBUILT', '1');
    vi.stubEnv('CDS_SELFUPDATE_PREBUILT_REPO', 'fixture/owned-cds');
    const cds = path.join(root, 'cds'), web = path.join(cds, 'web');
    const next = path.join(web, 'dist.next'), previous = path.join(web, 'dist.previous');
    const oldHtml = '<html><script src="/assets/old.js"></script>old web</html>';
    fs.writeFileSync(path.join(web, 'package.json'), '{}');
    fs.mkdirSync(path.join(web, 'dist/assets'), { recursive: true });
    fs.writeFileSync(path.join(web, 'dist/index.html'), oldHtml);
    fs.writeFileSync(path.join(web, 'dist/assets/old.js'), 'old bundle');
    for (const dir of [next, previous]) {
      fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'nested/retired.js'), 'retired web artifact');
    }
    artifactDeletePaths.add(next);
    const cid = 'c'.repeat(64);
    let staging: string | undefined, partialCopy = false;
    transport = async (cmd, _options, result) => {
      if (cmd.startsWith('docker pull ')) {
        const names = fs.readdirSync(path.join(cds, '.cds')).filter(name => name.startsWith('prebuilt-self-update-'));
        expect(names).toHaveLength(1);
        staging = path.join(cds, '.cds', names[0]); artifactDeletePaths.add(staging);
      }
      if (cmd.startsWith('docker create ')) return ok(cid);
      if (staging && cmd === `docker cp ${cid}:/dist/. ${path.join(staging, 'dist')}`) {
        fs.mkdirSync(path.join(staging, 'dist/nested'), { recursive: true });
        fs.writeFileSync(path.join(staging, 'dist/nested/partial.js'), 'actual partial prebuilt artifact');
        partialCopy = true;
        return { ...ok(), exitCode: 1, stderr: 'fixture partial prebuilt copy' };
      }
      if (staging && cmd === `docker cp ${cid}:/web-dist/. ${path.join(staging, 'web-dist')}`) {
        fs.writeFileSync(path.join(staging, 'web-dist/partial.js'), 'actual staged web artifact');
      }
      if (staging && cmd === `docker cp ${cid}:/manifest.json ${path.join(staging, 'manifest.json')}`) {
        fs.writeFileSync(path.join(staging, 'manifest.json'), '{}');
      }
      if (cmd === WEB_DIST_BUILD_COMMAND) {
        fs.mkdirSync(path.join(next, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(next, 'index.html'), '<html><script src="/assets/new.js"></script>new web</html>');
        fs.writeFileSync(path.join(next, 'assets/new.js'), 'new bundle');
      }
      return result;
    };
    const masterRemovals = observeMasterRecursiveRemoval(), { entered, fire } = observeRestartTimers();
    const first = post('self-update', { branch: 'main', drainTimeoutMs: 0, force: false });
    await entered;
    const owner = maintenance.observe()!;
    expect(owner).toMatchObject({ source: 'self-update', stopRequested: false });
    expect(partialCopy).toBe(true); expect(staging).toBeDefined();
    if (!staging) throw new Error('真实预构建暂存前提未成立');
    expect(fs.existsSync(staging)).toBe(false); expect(fs.existsSync(next)).toBe(false);
    expect(fs.readFileSync(path.join(cds, 'dist/index.js'), 'utf8')).toBe('new backend');
    expect(fs.readFileSync(path.join(web, 'dist/index.html'), 'utf8')).toContain('new web');
    expect(fs.readFileSync(path.join(web, 'dist/assets/new.js'), 'utf8')).toBe('new bundle');
    expect(fs.readFileSync(path.join(previous, 'index.html'), 'utf8')).toBe(oldHtml);
    expect(fs.readdirSync(web).filter(name => name.startsWith('dist.previous.old.'))).toEqual([]);
    fire(500);
    const reply = await first;
    expect(reply.status).toBe(200); expect(reply.raw).toContain('event: done');
    expect(reply.raw).toContain('docker cp 解出产物失败'); expect(reply.raw).not.toContain('event: error');
    expect(permitWrites).toEqual(['restart\n']); expect(process.exit).not.toHaveBeenCalled();
    expect.soft(masterRemovals).toEqual([]);
    assertOwnedDeletes(owner.id, [next, staging]);
    expect.soft(ownedDeletes.some(receipt => receipt.removed.some(target => path.dirname(target) === web
      && path.basename(target).startsWith('dist.previous.old.')))).toBe(true);
  });
});
