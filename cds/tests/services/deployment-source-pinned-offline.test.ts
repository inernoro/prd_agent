import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeService } from '../../src/services/worktree.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cds-pinned-offline-')));
  roots.push(root);
  const remote = path.join(root, 'remote'), local = path.join(root, 'local');
  await fs.mkdir(remote);
  const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(remote, 'init', '-b', 'main'); git(remote, 'config', 'user.email', 'test@example.invalid'); git(remote, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(remote, 'version.txt'), 'A'); git(remote, 'add', '.'); git(remote, 'commit', '-m', 'A');
  const a = git(remote, 'rev-parse', 'HEAD');
  git(root, 'clone', remote, local);
  await fs.writeFile(path.join(remote, 'version.txt'), 'B'); git(remote, 'commit', '-am', 'B');
  const b = git(remote, 'rev-parse', 'HEAD');
  const real = new ShellExecutor(); let offline = false; const fetches: string[] = [];
  const service = new WorktreeService({ exec: (command, options) => {
    if (command.startsWith('git fetch ')) {
      fetches.push(command);
      if (offline) return Promise.resolve({ stdout: '', stderr: 'fatal: transport unavailable', exitCode: 128 });
    }
    return real.exec(command, { ...options, timeout: 10_000, env: { ...options?.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  } });
  return { root, remote, local, a, b, git, service, fetches, setOffline: () => { offline = true; } };
}

describe('frozen full deployment commit does not require a second remote fetch', () => {
  it('resolves and prepares locally available exact B despite unavailable transport, preserving canonical A', async () => {
    const f = await fixture(); f.git(f.local, 'fetch', 'origin', 'main'); f.setOffline();
    expect((await f.service.resolveDeploymentCommit('main', f.local, f.b)).afterFull).toBe(f.b);
    const prepared = await f.service.prepareDeploymentSource('main', f.local, f.b);
    expect(await fs.readFile(path.join(prepared.sourcePath, 'version.txt'), 'utf8')).toBe('B');
    expect(f.git(f.local, 'rev-parse', 'HEAD')).toBe(f.a);
    expect(f.fetches).toEqual([]);
  });
  it('fetches missing exact B and never falls back to local A for an unavailable commit', async () => {
    const f = await fixture();
    expect((await f.service.resolveDeploymentCommit('main', f.local, f.b)).afterFull).toBe(f.b);
    expect(f.fetches.length).toBeGreaterThan(0);
    await expect(f.service.resolveDeploymentCommit('main', f.local, 'f'.repeat(40))).rejects.toThrow();
    expect(f.git(f.local, 'rev-parse', 'HEAD')).toBe(f.a);
  });
  it('unpinned requests refresh actual remote B rather than trusting stale local origin A', async () => {
    const f = await fixture(); expect(f.git(f.local, 'rev-parse', 'origin/main')).toBe(f.a);
    expect((await f.service.resolveDeploymentCommit('main', f.local)).afterFull).toBe(f.b);
    expect(f.fetches.length).toBeGreaterThan(0);
    expect(f.git(f.local, 'rev-parse', 'HEAD')).toBe(f.a);
  });
  it('short identities and unpinned requests still fail closed when fresh remote access fails', async () => {
    const f = await fixture(); f.git(f.local, 'fetch', 'origin', 'main'); f.setOffline();
    await expect(f.service.resolveDeploymentCommit('main', f.local, f.b.slice(0, 12))).rejects.toThrow('部署源码拉取失败');
    await expect(f.service.resolveDeploymentCommit('main', f.local)).rejects.toThrow('部署源码拉取失败');
    expect(f.fetches).toHaveLength(2);
  });
});
