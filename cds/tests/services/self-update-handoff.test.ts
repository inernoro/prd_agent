import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { CdsConfig, ExecAssignment, IShellExecutor } from '../../src/types.js';
import { createSelfUpdateCheckpoint, prepareDetachedCdsRestart } from '../../src/services/self-update-handoff.js';
import { MockShellExecutor, ShellExecutor } from '../../src/services/shell-executor.js';
import { IsolatedShellExecutor, OperationExecutionError } from '../../src/services/isolated-shell-executor.js';
import { SelfMaintenanceRuntime } from '../../src/services/self-maintenance-runtime.js';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import * as prebuiltRuntime from '../../src/services/cds-prebuilt-runtime.js';
import { endSelfUpdateDrain } from '../../src/services/deploy-drain.js';
import { setRestartWait } from '../../src/services/self-restart-wait.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';

const roots: string[] = [];
const runtimes: SelfMaintenanceRuntime[] = [], pools: IsolatedShellExecutor[] = [];
function ownedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-handoff-')); roots.push(root); return root;
}
function maintenanceRuntime(shell: IShellExecutor, root: string) {
  const runtime = new SelfMaintenanceRuntime(shell, root, () => {}); runtimes.push(runtime); return runtime;
}
function ownedPool() {
  const pool = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 1 });
  pools.push(pool); return pool;
}
function realCheckpointRuntime(root: string) {
  const pool = ownedPool();
  const dispatches: Array<{ action: string; ownerId: string; assignment: ExecAssignment }> = [];
  const shell: IShellExecutor = { exec: pool.exec.bind(pool), execOwnedOperation: (command, options) => {
    const input = /self-maintenance-files-process\.(ts|js)/.test(command)
      ? JSON.parse(options.stdin || '{}') as { action: string; ownerId: string } : undefined;
    return pool.execOwnedOperation(command, { ...options, env: { ...options.env,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, onAssigned: assignment => {
      options.onAssigned?.(assignment);
      if (input) dispatches.push({ ...input, assignment: { ...assignment } });
    } });
  } };
  return { runtime: maintenanceRuntime(shell, root), dispatches };
}
function gitFixture(hadPrevious: boolean) {
  const root = ownedRoot();
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8',
    timeout: 30_000, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'CDS test', GIT_AUTHOR_EMAIL: 'cds@example.test',
      GIT_COMMITTER_NAME: 'CDS test', GIT_COMMITTER_EMAIL: 'cds@example.test' },
  }).trim();
  git('init', '--initial-branch=before');
  fs.mkdirSync(path.join(root, 'cds'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'cds/dist/\ncds/web/dist/\ncds/web/dist.previous/\ncds/node_modules/\ncds/web/node_modules/\ncds/.cds/\ncds/.fixture-*\n');
  fs.writeFileSync(path.join(root, 'source.txt'), 'old source');
  fs.writeFileSync(path.join(root, 'cds/exec_cds.sh'), '#!/bin/sh\n[ ! -f .fixture-nginx-fail ] || exit 23\nexit 0\n', { mode: 0o755 });
  git('add', '.'); git('commit', '-m', '测试旧版');
  const sha = git('rev-parse', 'HEAD');
  const oldFiles = new Map([
    ['cds/dist/index.js', 'old backend'], ['cds/dist/.build-sha', sha],
    ['cds/web/dist/index.html', '<script src="assets/old.js"></script>'],
    ['cds/web/dist/assets/old.js', 'old chunk'], ['cds/web/dist/.build-sha', sha],
    ['cds/node_modules/fixture.js', 'old dependency'], ['cds/web/node_modules/fixture.js', 'old web dependency'],
  ]);
  if (hadPrevious) oldFiles.set('cds/web/dist.previous/previous.js', 'older chunk');
  for (const [file, contents] of oldFiles) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), contents);
  }
  return { root, git, sha, oldFiles };
}
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CDS 可撤销重启交接', () => {
  it.each(['self-update', 'self-force-sync'])('真实active-store写失败、首SHA等待及success清标记都不放入兄弟写入：%s', async endpoint => {
    const root = ownedRoot(), stateFile = path.join(root, 'state.json'), sha = 'a'.repeat(40);
    const config = { repoRoot: root, worktreeBase: path.join(root, 'worktrees'), masterPort: 9900,
      workerPort: 5500, dockerNetwork: 'test', portStart: 10001, rootDomains: ['example.test'],
      previewDomain: 'example.test', sharedEnv: {}, jwt: { secret: 'test', issuer: 'test' } } as CdsConfig;
    for (const dir of ['cds/dist', 'cds/web/dist', 'stage/dist', 'stage/web']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    const activePath = path.join(root, '.cds/active-update.json');
    fs.mkdirSync(activePath, { recursive: true }); // 真实rename拒绝覆盖目录，不伪造active getter。
    fs.writeFileSync(path.join(root, 'cds/exec_cds.sh'), 'printf daemon > invoked.txt\n');
    fs.writeFileSync(path.join(root, 'cds/web/package.json'), '{}');
    fs.writeFileSync(path.join(root, 'cds/dist/index.js'), 'old backend');
    fs.writeFileSync(path.join(root, 'cds/web/dist/index.html'), 'old web');
    fs.writeFileSync(path.join(root, 'stage/dist/index.js'), 'new backend');
    fs.writeFileSync(path.join(root, 'stage/web/index.html'), '<script src="entry.js"></script>');
    fs.writeFileSync(path.join(root, 'stage/web/entry.js'), 'new web');
    const shell = new MockShellExecutor(); let head = sha, blockWrite = false, flushes = 0;
    let enterRollback!: () => void, finishRollback!: () => void;
    const rollbackEntered = new Promise<void>(resolve => { enterRollback = resolve; });
    const rollbackRelease = new Promise<void>(resolve => { finishRollback = resolve; });
    let enterShortSha!: () => void, finishShortSha!: () => void;
    const shortShaEntered = new Promise<void>(resolve => { enterShortSha = resolve; });
    const shortShaRelease = new Promise<void>(resolve => { finishShortSha = resolve; });
    shell.addResponsePattern(/.*/, match => {
      const cmd = match[0];
      if (cmd.startsWith('git reset')) head = 'b'.repeat(40);
      if (cmd === 'node scripts/build-dist-esbuild.mjs') fs.cpSync(path.join(root, 'stage/dist'), path.join(root, 'cds/dist.next'), { recursive: true });
      if (cmd === 'pnpm build --outDir dist.next --emptyOutDir') fs.cpSync(path.join(root, 'stage/web'), path.join(root, 'cds/web/dist.next'), { recursive: true });
      const stdout = cmd === 'git rev-parse HEAD' ? head : cmd.includes('--short HEAD') ? head.slice(0, 8)
        : cmd.includes('--abbrev-ref HEAD') || cmd.includes('symbolic-ref') ? 'main'
        : cmd.startsWith('git rev-parse origin/') ? 'b'.repeat(40) : 'cds/src/index.ts';
      return { stdout, stderr: '', exitCode: 0 };
    });
    const originalExec = shell.exec.bind(shell);
    vi.spyOn(shell, 'exec').mockImplementation(async (cmd, opts) => {
      if (cmd === 'git rev-parse --short HEAD') { enterShortSha(); await shortShaRelease; }
      if (cmd.startsWith('git checkout -f -B')) { enterRollback(); await rollbackRelease; head = sha; }
      return originalExec(cmd, opts);
    });
    const filesPool = ownedPool();
    // HTTP旧Mock只证明控制流/分类；仅文件worker是真owned，Mock Git不冒充物理停止。
    const controlledShell: IShellExecutor = { exec: shell.exec.bind(shell), execOwnedOperation: async (cmd, options) => {
      if (/self-maintenance-files-process\.(ts|js)/.test(cmd)) return filesPool.execOwnedOperation(cmd, options);
      options.beforeStart();
      const result = await shell.exec(cmd, options);
      if (options.signal?.aborted) throw new OperationExecutionError('cancelled');
      return result;
    } };
    const runtime = maintenanceRuntime(controlledShell, root);
    vi.stubEnv('CDS_SELFUPDATE_PREBUILT', '1'); vi.stubEnv('CDS_SELFUPDATE_PREBUILT_REPO', 'fixture/cds');
    vi.spyOn(prebuiltRuntime, 'fetchCdsPrebuilt').mockResolvedValue({ ok: true,
      distDir: path.join(root, 'stage/dist'), webDistDir: path.join(root, 'stage/web') });
    const state = new StateService(stateFile, root); state.load();
    const originalFlush = state.flush.bind(state), originalRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(state, 'flush').mockImplementation(() => {
      if (++flushes === 2) { blockWrite = true; state.save(); }
      return originalFlush();
    });
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (blockWrite && to === stateFile) { blockWrite = false; throw new Error('final physical write failed'); }
      return originalRename(from, to);
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const app = express(); app.use(express.json());
    app.use('/api', createBranchRouter({ stateService: state, shell: controlledShell, config, selfMaintenanceRuntime: runtime,
      worktreeService: new WorktreeService(shell, root), containerService: new ContainerService(shell, config) }));
    const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const post = async (endpoint: string) => (await fetch(`${url}/${endpoint}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: 'main', drainTimeoutMs: 0 }) })).text();
    const first = post(endpoint);
    try {
      await shortShaEntered;
      expect(fs.statSync(activePath).isDirectory()).toBe(true);
      expect(JSON.parse(fs.readFileSync(activePath + '.tmp', 'utf8')).pid).toBe(process.pid);
      expect(state.getActiveSelfUpdate()).toBeNull();
      const beforeShortSha = shell.commands.length;
      for (const sibling of ['self-update', 'self-force-sync', 'self-restart']) {
        expect(await post(sibling)).toMatch(/concurrency|self_update_busy/);
      }
      expect(shell.commands).toHaveLength(beforeShortSha);
      finishShortSha();
      await rollbackEntered;
      expect(state.getActiveSelfUpdate()).toBeFalsy(); expect(state.getSelfUpdateHistory(1)[0].status).toBe('success');
      const commands = shell.commands.length;
      for (const endpoint of ['self-force-sync', 'self-restart']) expect(await post(endpoint)).toMatch(/concurrency|self_update_busy/);
      expect(shell.commands).toHaveLength(commands); expect(exit).not.toHaveBeenCalled();
      finishRollback(); const failure = await first;
      expect(failure).toContain('CDS 重启未获可靠交接许可'); expect(failure).not.toContain('event: done');
      expect(fs.readFileSync(path.join(root, 'cds/dist/index.js'), 'utf8')).toBe('old backend');
      expect(fs.readFileSync(path.join(root, 'cds/web/dist/index.html'), 'utf8')).toBe('old web');
      expect(fs.existsSync(path.join(root, 'cds/invoked.txt'))).toBe(false);
      head = 'invalid'; expect(await post('self-restart')).toContain('无法读取当前 CDS 完整提交 SHA');
      expect(shell.commands.length).toBeGreaterThan(commands); expect(exit).not.toHaveBeenCalled();
    } finally {
      finishShortSha(); finishRollback(); await first; vi.restoreAllMocks(); vi.unstubAllEnvs(); await originalFlush();
      await new Promise<void>(resolve => server.close(() => resolve()));
      endSelfUpdateDrain(); setRestartWait(null); selfStatusCache._resetForTests();
    }
  });

  it.each(['cancel', 'release', 'early-close'])('额外pipe在保存许可前不执行daemon：%s', async mode => {
    const root = ownedRoot(), marker = path.join(root, 'invoked.txt');
    fs.writeFileSync(path.join(root, 'exec_cds.sh'), 'printf "%s\\n" "$1" >> invoked.txt\n');
    fs.writeFileSync(path.join(root, 'bash'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    let child!: ChildProcess, spawned!: Promise<void>, closed!: Promise<number | null>;
    const trackedSpawn = ((...args: Parameters<typeof spawn>) => {
      child = spawn(...args);
      spawned = new Promise(resolve => child.once('spawn', () => resolve()));
      closed = new Promise(resolve => child.once('close', code => resolve(code)));
      return child;
    }) as typeof spawn;
    const permit = prepareDetachedCdsRestart(trackedSpawn, root,
      { PATH: mode === 'early-close' ? root : '/usr/bin:/bin' }, ['ignore', 'ignore', 'ignore']);
    try {
      await spawned; expect(permit.hasChildPid).toBe(true); expect(fs.existsSync(marker)).toBe(false);
      if (mode === 'early-close') { expect(await closed).toBe(2); await expect(permit.release()).rejects.toThrow(); }
      else { if (mode === 'release') await permit.release(); else await permit.cancel(); expect(await closed).toBe(mode === 'release' ? 0 : 1); }
      expect(fs.existsSync(marker)).toBe(mode === 'release');
      if (mode === 'release') expect(fs.readFileSync(marker, 'utf8')).toBe('daemon\n');
    } finally { await permit.cancel(); }
  });

  it('真实Git检查点缺少owned维护能力时改树前拒绝，不在Master复制五目录', async () => {
    const root = ownedRoot();
    const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'CDS fixture', GIT_AUTHOR_EMAIL: 'cds-fixture@example.test',
      GIT_COMMITTER_NAME: 'CDS fixture', GIT_COMMITTER_EMAIL: 'cds-fixture@example.test' };
    const git = (...args: string[]) => execFileSync('/usr/bin/git', args, {
      cwd: root, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git('init', '--quiet', '--initial-branch=before');
    fs.writeFileSync(path.join(root, '.gitignore'), 'cds/dist/\ncds/web/dist/\ncds/web/dist.previous/\ncds/node_modules/\ncds/web/node_modules/\ncds/.cds/\n');
    fs.writeFileSync(path.join(root, 'source.txt'), 'unchanged source\n');
    git('add', '.'); git('commit', '--quiet', '-m', '测试检查点能力前置');
    const head = git('rev-parse', 'HEAD');
    const files = new Map(['dist', 'web/dist', 'web/dist.previous', 'node_modules', 'web/node_modules']
      .map((relative): [string, string] => [path.join(root, 'cds', relative, 'fixture'), `old:${relative}\n`]));
    for (const [file, content] of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
    }
    const backupRoot = path.join(root, 'cds/.cds');
    expect(fs.existsSync(backupRoot)).toBe(false);
    const shell = new ShellExecutor(), exec = shell.exec.bind(shell);
    expect('execOwnedOperation' in shell).toBe(false);
    const runtime = maintenanceRuntime(shell, root);
    const owner = runtime.acquire({ source: 'self-update', actor: 'fixture-no-owned' })!;
    // 仅隔离Git配置；仍调用实际ShellExecutor/真实Git，不伪造能力或命令成功。
    const execute = vi.spyOn(shell, 'exec').mockImplementation((command, options) => exec(command, { ...options, env }));
    const copy = vi.spyOn(fs.promises, 'cp');
    const backup = vi.spyOn(fs, 'mkdtempSync');
    let checkpoint: Awaited<ReturnType<typeof createSelfUpdateCheckpoint>> | undefined;
    let rejected: unknown;
    try {
      try { checkpoint = await createSelfUpdateCheckpoint(runtime, owner, root); }
      catch (error) { rejected = error; }
      // 原六项RED断言保留；真实runtime+票据确保不能靠错参TypeError冒充缺能力拒绝。
      expect.soft(rejected).toBeInstanceOf(Error);
      expect.soft(rejected).toMatchObject({ message: expect.stringContaining('缺少受控维护') });
      expect.soft(checkpoint).toBeUndefined();
      expect.soft(fs.existsSync(backupRoot)).toBe(false);
      expect.soft(backup.mock.calls.filter(([prefix]) => String(prefix).startsWith(path.join(backupRoot, 'restart-rollback-')))).toEqual([]);
      expect.soft(copy).not.toHaveBeenCalled();
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('branch', '--show-current')).toBe('before');
      expect(git('status', '--porcelain=v1', '--untracked-files=all')).toBe('');
      expect(fs.readFileSync(path.join(root, 'source.txt'), 'utf8')).toBe('unchanged source\n');
      for (const [file, content] of files) expect(fs.readFileSync(file, 'utf8')).toBe(content);
    } finally {
      // 仅清理旧实现已产生的自有副本；不把事后清理当作改树前拒绝证据。
      try { await checkpoint?.commit(); }
      finally { runtime.finish(owner); execute.mockRestore(); copy.mockRestore(); backup.mockRestore(); }
    }
  });

  it.each([false, true])('独立副本恢复精确源码分支/HEAD及全部产物字节，原previous存在=%s', async hadPrevious => {
    const { root, git, sha, oldFiles } = gitFixture(hadPrevious);
    const { runtime, dispatches } = realCheckpointRuntime(root);
    const owner = runtime.acquire({ source: 'self-update', actor: 'fixture-restore' })!;
    const checkpoint = await createSelfUpdateCheckpoint(runtime, owner, root);
    git('checkout', '-b', 'after'); fs.writeFileSync(path.join(root, 'source.txt'), 'new source');
    git('add', 'source.txt'); git('commit', '-m', '测试新版');
    expect(git('rev-parse', 'HEAD')).not.toBe(sha);
    // 原位写会破坏硬链接备份；真正的独立副本仍必须恢复旧字节。
    for (const [file] of oldFiles) fs.writeFileSync(path.join(root, file), 'new bytes');
    fs.mkdirSync(path.join(root, 'cds/web/dist.previous'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cds/web/dist.previous/new.js'), 'new previous');
    await checkpoint.rollback(); await checkpoint.rollback();
    expect(git('rev-parse', 'HEAD')).toBe(sha); expect(git('branch', '--show-current')).toBe('before');
    expect(fs.readFileSync(path.join(root, 'source.txt'), 'utf8')).toBe('old source');
    for (const [file, contents] of oldFiles) expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe(contents);
    expect(fs.existsSync(path.join(root, 'cds/web/dist.previous'))).toBe(hadPrevious);
    expect(fs.existsSync(path.join(root, 'cds/web/dist.previous/new.js'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'cds/.cds'))).toEqual([]);
    expect(dispatches.map(job => job.action)).toEqual(['snapshot', 'restore', 'discard']);
    expect(dispatches.every(job => job.ownerId === owner.id && job.assignment.lane === 'operation'
      && (job.assignment.actorPid ?? 0) > 1)).toBe(true);
    expect(runtime.finish(owner)).toBe(true);
  });

  it('延迟产物保存保留早期Git身份，保存成功后仍恢复全部五目录', async () => {
    const { root, git, sha, oldFiles } = gitFixture(true);
    const { runtime, dispatches } = realCheckpointRuntime(root);
    const owner = runtime.acquire({ source: 'self-update', actor: 'fixture-late-capture' })!;
    const checkpoint = await createSelfUpdateCheckpoint(runtime, owner, root, { deferArtifacts: true });
    expect(dispatches).toEqual([]); expect(fs.existsSync(path.join(root, 'cds/.cds'))).toBe(false);
    expect(() => checkpoint.retainForRestart()).toThrow('尚未确认');
    git('checkout', '-b', 'after'); fs.writeFileSync(path.join(root, 'source.txt'), 'new source');
    git('add', 'source.txt'); git('commit', '-m', '测试晚期产物保护');
    expect(git('rev-parse', 'HEAD')).not.toBe(sha);
    await checkpoint.captureArtifacts(); await checkpoint.captureArtifacts();
    expect(dispatches.map(job => job.action)).toEqual(['snapshot']);
    for (const [file] of oldFiles) fs.writeFileSync(path.join(root, file), 'new bytes');
    await checkpoint.rollback(); await checkpoint.rollback();
    expect(git('rev-parse', 'HEAD')).toBe(sha); expect(git('branch', '--show-current')).toBe('before');
    expect(fs.readFileSync(path.join(root, 'source.txt'), 'utf8')).toBe('old source');
    for (const [file, content] of oldFiles) expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe(content);
    expect(dispatches.map(job => job.action)).toEqual(['snapshot', 'restore', 'discard']);
    expect(fs.readdirSync(path.join(root, 'cds/.cds'))).toEqual([]);
    expect(runtime.finish(owner)).toBe(true); expect(runtime.observe()).toBeNull();
  });

  it('晚期真实复制拒绝后丢弃局部副本不结束源码保护，也不恢复未确认的五目录', async () => {
    const { root, git, sha, oldFiles } = gitFixture(true);
    const { runtime, dispatches } = realCheckpointRuntime(root);
    const owner = runtime.acquire({ source: 'self-force-sync', actor: 'fixture-late-copy-failure' })!;
    const checkpoint = await createSelfUpdateCheckpoint(runtime, owner, root, { deferArtifacts: true });
    expect(dispatches).toEqual([]); expect(fs.existsSync(path.join(root, 'cds/.cds'))).toBe(false);
    git('checkout', '-b', 'after'); fs.writeFileSync(path.join(root, 'source.txt'), 'new source');
    git('add', 'source.txt'); git('commit', '-m', '测试晚期复制故障源码');
    expect(git('rev-parse', 'HEAD')).not.toBe(sha);
    const unreadable = path.join(root, 'cds/node_modules/fixture.js');
    const mode = fs.statSync(unreadable).mode & 0o777;
    const results: Array<{ action: string; exitCode: number; stderr: string }> = [];
    const execute = runtime.exec.bind(runtime);
    const observe = vi.spyOn(runtime, 'exec').mockImplementation(async (ticket, command, options, recovery) => {
      const result = await execute(ticket, command, options, recovery);
      if (/self-maintenance-files-process\.(ts|js)/.test(command)) {
        const input = JSON.parse(options?.stdin || '{}') as { action: string };
        results.push({ action: input.action, exitCode: result.exitCode, stderr: result.stderr });
      }
      return result;
    });
    try {
      fs.chmodSync(unreadable, 0o000);
      expect(() => fs.readFileSync(unreadable)).toThrow(expect.objectContaining({ code: 'EACCES' }));
      await expect(checkpoint.captureArtifacts()).rejects.toThrow('维护文件操作未完成');
      // worker按既有合同只输出安全文案；EACCES由上面的真实文件读取证明，不要求泄露原始异常。
      expect(results[0]).toEqual({ action: 'snapshot', exitCode: 1,
        stderr: 'CDS 维护文件操作未完成，已保留可用恢复点，请核对维护状态。' });
      expect(results[1]).toMatchObject({ action: 'discard', exitCode: 0 });
      expect(runtime.observe()).toMatchObject({ id: owner.id, stopRequested: true,
        activeJobCount: 0, unconfirmedJobCount: 0 });
      expect(git('branch', '--show-current')).toBe('after');
      fs.chmodSync(unreadable, mode);
      await checkpoint.rollback(); await checkpoint.rollback();
      expect(git('rev-parse', 'HEAD')).toBe(sha); expect(git('branch', '--show-current')).toBe('before');
      expect(fs.readFileSync(path.join(root, 'source.txt'), 'utf8')).toBe('old source');
      for (const [file, content] of oldFiles) expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe(content);
      expect(dispatches.map(job => job.action)).toEqual(['snapshot', 'discard']);
      expect(fs.readdirSync(path.join(root, 'cds/.cds'))).toEqual([]);
      expect(runtime.finish(owner)).toBe(true); expect(runtime.observe()).toBeNull();
    } finally { fs.chmodSync(unreadable, mode); observe.mockRestore(); }
  });

  it.each(['git', 'nginx'] as const)('真实%s恢复失败后仍观察同票，二次确认不重复替换已恢复目录', async failure => {
    const { root, git, sha, oldFiles } = gitFixture(true);
    const { runtime, dispatches } = realCheckpointRuntime(root);
    const owner = runtime.acquire({ source: 'self-force-sync', actor: 'fixture-retry-restore' })!;
    const checkpoint = await createSelfUpdateCheckpoint(runtime, owner, root);
    const backupRoot = path.join(root, 'cds/.cds');
    const backups = fs.readdirSync(backupRoot).filter(name => name.startsWith(`restart-rollback-${owner.id}-`));
    expect(backups).toHaveLength(1);
    const backup = path.join(backupRoot, backups[0]!);
    git('checkout', '-b', 'after'); fs.writeFileSync(path.join(root, 'source.txt'), 'new source');
    git('add', 'source.txt'); git('commit', '-m', '测试待恢复新版');
    for (const [file] of oldFiles) fs.writeFileSync(path.join(root, file), 'new bytes');
    const blocker = failure === 'git' ? path.join(root, '.git/index.lock') : path.join(root, 'cds/.fixture-nginx-fail');
    fs.writeFileSync(blocker, 'owned fixture failure', { flag: 'wx' });
    try {
      // 普通操作已停止；Git/nginx及discard必须使用本票独立recovery路径，不继承已abort信号。
      runtime.requestStop(owner);
      await expect(checkpoint.rollback()).rejects.toThrow(failure === 'git' ? '源码恢复失败' : '入口配置恢复失败');
      expect(runtime.observe()).toMatchObject({ id: owner.id, source: 'self-force-sync', phase: 'rollback',
        state: 'cancelling', stopRequested: true, activeJobCount: 0, unconfirmedJobCount: 0 });
      expect(runtime.isHealthy()).toBe(false);
      for (const source of ['self-update', 'self-force-sync', 'self-restart', 'self-update-dry-run'] as const) {
        expect(runtime.acquire({ source, actor: 'must-not-follow-incomplete-restore' })).toBeNull();
      }
      expect(fs.existsSync(backup)).toBe(true);
      for (const [file, contents] of oldFiles) expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe(contents);
      expect(dispatches.map(job => job.action)).toEqual(['snapshot', 'restore']);
      // 真实首轮FS已恢复；后续Git/nginx重试若再次换目录，这个字节会丢失或恢复点已被耗尽。
      const sentinel = path.join(root, 'cds/dist/index.js');
      fs.writeFileSync(sentinel, 'after-first-restore-sentinel');
      fs.unlinkSync(blocker);
      await checkpoint.rollback();
      expect(git('rev-parse', 'HEAD')).toBe(sha);
      expect(git('branch', '--show-current')).toBe('before');
      expect(fs.readFileSync(path.join(root, 'source.txt'), 'utf8')).toBe('old source');
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('after-first-restore-sentinel');
      for (const [file, contents] of oldFiles) {
        if (path.join(root, file) !== sentinel) expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe(contents);
      }
      expect(dispatches.map(job => job.action)).toEqual(['snapshot', 'restore', 'discard']);
      expect(dispatches.every(job => job.ownerId === owner.id && job.assignment.lane === 'operation'
        && (job.assignment.actorPid ?? 0) > 1)).toBe(true);
      expect(fs.existsSync(backup)).toBe(false);
      expect(runtime.finish(owner)).toBe(true);
      expect(runtime.observe()).toBeNull();
    } finally {
      if (fs.existsSync(blocker)) fs.unlinkSync(blocker);
    }
  });
});
