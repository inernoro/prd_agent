import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { StuckDeployRuntimeDiff } from '../../src/services/stuck-deploy-runtime-diff.js';
import type { BranchEntry, ExecResult, IShellExecutor } from '../../src/types.js';

const branch = (id = 'one', from = 'a'.repeat(40)): BranchEntry => ({
  id, projectId: 'owned', branch: id, worktreePath: `/owned/${id}`,
  ciTargetSha: from, githubCommitSha: 'b'.repeat(40), status: 'running', services: {}, createdAt: '',
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const result = (stdout: string, exitCode = 0): ExecResult => ({ stdout, stderr: '', exitCode });

describe('stuck deploy runtime diff IO budget', () => {
  it('returns immediately, deduplicates held work, then uses the actual successful result', async () => {
    let finish!: (result: ExecResult) => void;
    const exec = vi.fn(() => new Promise<ExecResult>(resolve => { finish = resolve; }));
    const cache = new StuckDeployRuntimeDiff({ exec } as IShellExecutor);
    for (let i = 0; i < 20; i++) expect(cache.hasRuntimeChanges(branch())).toBe(false);
    await tick();
    expect(exec).toHaveBeenCalledTimes(1);
    finish(result('src/api.ts\n')); await tick();
    expect(cache.hasRuntimeChanges(branch())).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(expect.stringMatching(/^git diff --name-only /), expect.objectContaining({
      cwd: '/owned/one', timeout: 5000, priority: 'diagnostic', schedulingGroup: 'stuck-diff:owned',
    }));
  });
  it('does not memoize failed or rejected IO, and caches a successful docs-only result', async () => {
    const exec = vi.fn().mockResolvedValueOnce(result('', 1)).mockRejectedValueOnce(new Error('owned unavailable'))
      .mockResolvedValueOnce(result('doc/guide.md\n'));
    const cache = new StuckDeployRuntimeDiff({ exec } as IShellExecutor);
    cache.hasRuntimeChanges(branch()); await tick();
    cache.hasRuntimeChanges(branch()); await tick();
    cache.hasRuntimeChanges(branch()); await tick();
    expect(cache.hasRuntimeChanges(branch())).toBe(false);
    expect(exec).toHaveBeenCalledTimes(3);
  });
  it('rejects incomplete commit identities without shell work', () => {
    const exec = vi.fn(); const cache = new StuckDeployRuntimeDiff({ exec } as IShellExecutor);
    expect(cache.hasRuntimeChanges(branch('one', 'a'.repeat(7)))).toBe(false);
    expect(cache.hasRuntimeChanges({ ...branch(), githubCommitSha: '$(touch /owned/unsafe)' })).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
  it('limits queued work, expires old waiting targets and retries them next tick', async () => {
    let finish!: (result: ExecResult) => void;
    const exec = vi.fn().mockImplementationOnce(() => new Promise<ExecResult>(resolve => { finish = resolve; }))
      .mockResolvedValue(result('src/api.ts\n'));
    let now = 0; const cache = new StuckDeployRuntimeDiff({ exec } as IShellExecutor, () => now);
    for (let i = 0; i < 100; i++) cache.hasRuntimeChanges(branch(String(i)));
    await tick();
    expect(exec).toHaveBeenCalledTimes(1);
    now = 5001; finish(result('src/api.ts\n')); await tick();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(cache.hasRuntimeChanges(branch('99'))).toBe(false); await tick();
    expect(cache.hasRuntimeChanges(branch('99'))).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('rotates admission after a timeout under fixed enumeration without querying a preferred branch', async () => {
    let now = 0;
    let failFirst!: (value: ExecResult) => void;
    const attempted: string[] = [];
    const exec = vi.fn((_command: string, options: { cwd: string }) => {
      const id = options.cwd.split('/').at(-1)!;
      attempted.push(id);
      return id === '0' ? new Promise<ExecResult>(resolve => { failFirst = resolve; })
        : Promise.resolve(result('src/api.ts\n'));
    });
    const cache = new StuckDeployRuntimeDiff({ exec } as IShellExecutor, () => now);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 100; i++) cache.hasRuntimeChanges(branch(String(i)));
      await tick();
      if (attempted.at(-1) === '0') { now += 5001; failFirst(result('', 1)); }
      await tick();
    }
    expect(attempted).toContain('1');
    expect(attempted).toContain('99');
    expect(attempted.filter(id => id === '0').length).toBeLessThan(3);
  });

  it('does not let changing commits on the failed first branch reset its scheduling position', async () => {
    let now = 0;
    let failFirst!: (value: ExecResult) => void;
    const attempted: string[] = [];
    const exec = vi.fn((_command: string, options: { cwd: string }) => {
      const id = options.cwd.split('/').at(-1)!;
      attempted.push(id);
      return id === '0' ? new Promise<ExecResult>(resolve => { failFirst = resolve; })
        : Promise.resolve(result('src/api.ts\n'));
    });
    const cache = new StuckDeployRuntimeDiff({ exec } as IShellExecutor, () => now);
    for (let round = 1; round <= 3; round++) {
      for (let i = 0; i < 100; i++) cache.hasRuntimeChanges(i === 0
        ? { ...branch('0'), githubCommitSha: String(round).repeat(40) } : branch(String(i)));
      await tick();
      if (attempted.at(-1) === '0') { now += 5001; failFirst(result('', 1)); }
      await tick();
    }
    expect(attempted).toContain('1');
    expect(attempted).toContain('99');
  });

  it('attempts every identity before wrapping when all 100 targets keep timing out', async () => {
    let now = 0;
    let finish!: (value: ExecResult) => void;
    const attempted: string[] = [];
    const exec = vi.fn((_command: string, options: { cwd: string }) => {
      attempted.push(options.cwd.split('/').at(-1)!);
      return new Promise<ExecResult>(resolve => { finish = resolve; });
    });
    const cache = new StuckDeployRuntimeDiff({ exec } as IShellExecutor, () => now);
    for (let round = 0; round < 100; round++) {
      for (let i = 0; i < 100; i++) cache.hasRuntimeChanges(branch(String(i)));
      await tick();
      expect(attempted).toHaveLength(round + 1);
      now += 5001; finish(result('', 1)); await tick();
    }
    expect(new Set(attempted).size).toBe(100);
  });

  it('queries real immutable git commits through the execution worker with a literal shell-looking cwd', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-owned-diff-'));
    const cwd = path.join(root, 'worktree $(touch unintended)');
    fs.mkdirSync(cwd); fs.mkdirSync(path.join(root, 'bin'));
    fs.symlinkSync('/usr/bin/git', path.join(root, 'bin', 'git'));
    const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim();
    git('init', '--quiet'); git('config', 'user.email', 'owned-test@example.test'); git('config', 'user.name', 'Owned Test');
    fs.writeFileSync(path.join(cwd, 'README.md'), 'first'); git('add', '.'); git('commit', '--quiet', '-m', 'owned initial');
    const from = git('rev-parse', 'HEAD');
    fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src', 'api.ts'), 'export const owned = 1;');
    git('add', '.'); git('commit', '--quiet', '-m', 'owned runtime');
    const to = git('rev-parse', 'HEAD');
    const worker = new ShellExecutor({ maxConcurrent: 1 });
    let completed!: () => void;
    const done = new Promise<void>(resolve => { completed = resolve; });
    const shell: IShellExecutor = { exec: async (command, options) => {
      const result = await worker.exec(command, { ...options, env: { ...process.env, PATH: `${root}/bin:/usr/bin:/bin` } });
      completed(); return result;
    } };
    try {
      const cache = new StuckDeployRuntimeDiff(shell);
      const target = { ...branch(), worktreePath: cwd, ciTargetSha: from, githubCommitSha: to };
      expect(cache.hasRuntimeChanges(target)).toBe(false);
      await done; await tick();
      expect(cache.hasRuntimeChanges(target)).toBe(true);
      expect(fs.existsSync(path.join(cwd, 'unintended'))).toBe(false);
    } finally { await worker.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

});
