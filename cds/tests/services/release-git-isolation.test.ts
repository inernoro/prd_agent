import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cp from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReleaseCommitClock } from '../../src/services/release-commit-clock.js';
import { ReleaseCommitRailReader } from '../../src/services/release-commit-rail.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { createReleaseGitRunner } from '../../src/services/release-git-reader.js';
import type { IShellExecutor } from '../../src/types.js';
vi.mock('node:child_process', async original => { const actual = await original<typeof import('node:child_process')>(); return { ...actual, execFileSync: vi.fn(actual.execFileSync), spawn: vi.fn(actual.spawn) }; });
const pools: IsolatedShellExecutor[] = []; const dirs: string[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map(p => p.close())); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); vi.restoreAllMocks(); });
describe('发布Git读取隔离', () => {
  it('缺执行器保持未知，不能回退到Master创建命令或把未知计数变成零', async () => {
    vi.mocked(cp.execFileSync).mockClear();
    vi.mocked(cp.spawn).mockClear();
    const sha = 'a'.repeat(40);
    const clock = new ReleaseCommitClock();
    const rail = new ReleaseCommitRailReader({ repoRootResolver: () => '/owned' });
    expect(await clock.remember('owned', sha, '/owned')).toBeUndefined();
    const result = await rail.read({ projectId: 'owned', branch: 'main', targets: [{ targetId: 't', commitSha: sha }] });
    expect(result.rail.unavailableReason).toBeTruthy();
    expect(result.positions.t.behindCount).toBeNull();
    expect(cp.execFileSync).not.toHaveBeenCalled();
    expect(cp.spawn).not.toHaveBeenCalled();
  });
  it('超过输出预算明确失败，不返回截断的提交元信息；随后有限读取仍可成功', async () => {
    let overflow = true;
    const shell = { exec: async (_command, options) => {
      options?.onData?.(overflow ? 'x'.repeat(256 * 1024) : 'owned', 'stdout');
      if (overflow) options?.onData?.('extra', 'stderr');
      return { exitCode: 0, stdout: '', stderr: '' };
    } } as IShellExecutor;
    const read = createReleaseGitRunner(shell);
    await expect(read(['status'])).rejects.toThrow('output capacity exceeded');
    overflow = false;
    await expect(read(['status'])).resolves.toBe('owned');
  });
  it('真实提交台账和流水轴不从Master同步创建Git命令', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cds-release-git-owned-')); dirs.push(dir);
    const git = (...args: string[]) => cp.execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q'); git('config', 'user.name', 'Owned Test'); git('config', 'user.email', 'owned@example.test');
    await writeFile(path.join(dir, 'owned.txt'), 'owned'); git('add', '.'); git('commit', '-qm', '自有提交');
    const sha = git('rev-parse', 'HEAD').trim(); git('update-ref', 'refs/remotes/origin/main', sha);
    const shell = new IsolatedShellExecutor(new ShellExecutor()); pools.push(shell); await shell.start();
    vi.mocked(cp.execFileSync).mockClear(); vi.mocked(cp.spawn).mockClear();
    const clock = new ReleaseCommitClock({ shell });
    const rail = new ReleaseCommitRailReader({ shell, repoRootResolver: () => dir });
    expect(await clock.remember('owned', sha, dir)).toBeTruthy();
    const result = await rail.read({ projectId: 'owned', branch: 'main', targets: [{ targetId: 'owned-target', commitSha: sha }] });
    expect(result.rail.nodes[0].sha).toBe(sha); expect(result.positions['owned-target'].behindCount).toBe(0);
    expect(cp.execFileSync).not.toHaveBeenCalled(); expect(cp.spawn).not.toHaveBeenCalled();
    expect(shell.getStats().active).toBe(0);
  });
  it('并发相同查询共用读取且固定已解析提交，ref移动不混入后续计数', async () => {
    const sha = 'a'.repeat(40); const target = 'b'.repeat(40); let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; }); const calls: string[][] = [];
    const reader = new ReleaseCommitRailReader({ repoRootResolver: () => '/owned', runner: async args => {
      calls.push([...args]);
      if (args.includes('rev-parse')) { await ready; return sha; }
      if (args.includes('log') && args.some(a => a.startsWith('--format=%H'))) return `${sha}\x1f2026-10-01T00:00:00Z\x1f自有提交`;
      if (args.includes('rev-list')) return args.at(-1) === `${target}..${sha}` ? '1' : '0';
      return '2026-10-01T00:00:00Z';
    } });
    const input = { projectId: 'owned', branch: 'main', targets: [{ targetId: 't', commitSha: target }] };
    const first = reader.read(input); const second = reader.read(input); input.targets[0].commitSha = 'c'.repeat(40);
    release(); const [a,b] = await Promise.all([first, second]);
    expect(a).toEqual(b); expect(a.positions.t.commitSha).toBe(target); expect(a.positions.t.behindCount).toBe(1);
    expect(calls.filter(a => a.includes('rev-parse'))).toHaveLength(1);
    expect(calls.filter(a => a.includes('log') || a.includes('rev-list')).every(a => !a.at(-1)?.includes('origin/main'))).toBe(true);
  });
});
