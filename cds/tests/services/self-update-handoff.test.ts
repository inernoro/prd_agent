import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { CdsConfig } from '../../src/types.js';
import { createSelfUpdateCheckpoint, prepareDetachedCdsRestart } from '../../src/services/self-update-handoff.js';
import { MockShellExecutor, ShellExecutor } from '../../src/services/shell-executor.js';
import { createBranchRouter, replaceDirectoriesAtomically } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import * as prebuiltRuntime from '../../src/services/cds-prebuilt-runtime.js';
import { endSelfUpdateDrain } from '../../src/services/deploy-drain.js';
import { setRestartWait } from '../../src/services/self-restart-wait.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';

const roots: string[] = [];
function ownedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-handoff-')); roots.push(root); return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

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
    app.use('/api', createBranchRouter({ stateService: state, shell, config,
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

  it.each([false, true])('独立副本恢复精确源码分支/HEAD及全部产物字节，原previous存在=%s', async hadPrevious => {
    const root = ownedRoot();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
      PATH: process.env.PATH, GIT_AUTHOR_NAME: 'CDS test', GIT_AUTHOR_EMAIL: 'cds@example.test',
      GIT_COMMITTER_NAME: 'CDS test', GIT_COMMITTER_EMAIL: 'cds@example.test',
    } }).trim();
    git('init', '--initial-branch=before');
    fs.mkdirSync(path.join(root, 'cds'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), 'cds/dist/\ncds/web/dist/\ncds/web/dist.previous/\ncds/.cds/\n');
    fs.writeFileSync(path.join(root, 'source.txt'), 'old source');
    fs.writeFileSync(path.join(root, 'cds/exec_cds.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), contents);
    }
    const checkpoint = await createSelfUpdateCheckpoint(new ShellExecutor(), root, replaceDirectoriesAtomically);
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
  });
});
