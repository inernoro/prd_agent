import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveArtifactCommitIdentity } from '../../src/services/artifact-commit-identity.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import type { IShellExecutor } from '../../src/types.js';

const full = 'abcdef1234567890abcdef1234567890abcdef12';
const request = { branchId: 'owned', projectId: 'p', profileId: 'api', kind: 'deploy-profile' as const,
  trigger: 'manual' as const, commitSha: full.slice(0, 7), commitPinned: true };
const dirs: string[] = [], pools: IsolatedShellExecutor[] = [];
afterEach(async () => { await Promise.all(pools.splice(0).map(pool => pool.close())); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fakeGit(result: string) {
  const calls: string[] = [];
  const shell = { execBackgroundObservation: async (command, options) => {
    options?.beforeStart?.(); calls.push(command); options?.onData?.(result, 'stdout');
    return { exitCode: 0, stdout: '', stderr: '' };
  } } as IShellExecutor;
  return { shell, calls };
}

describe('短提交的实际完整身份与受理前资格', () => {
  it('真实本地Git通过已有非紧急隔离池解析唯一完整commit，源码HEAD与工作目录不变', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cds-artifact-identity-')); dirs.push(dir);
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.name', 'Owned'); git('config', 'user.email', 'owned@example.test');
    await writeFile(path.join(dir, 'owned.txt'), 'first'); git('add', '.'); git('commit', '-qm', '自有第一版'); const first = git('rev-parse', 'HEAD');
    await writeFile(path.join(dir, 'owned.txt'), 'second'); git('commit', '-qam', '自有第二版'); const latest = git('rev-parse', 'HEAD');
    const operation = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 2 });
    const shell = new IsolatedShellExecutor(operation); pools.push(shell, operation); await Promise.all([shell.start(), operation.start()]);
    expect(await resolveArtifactCommitIdentity(shell, dir, first.slice(0, 7).toUpperCase(), () => {})).toBe(first);
    expect(git('rev-parse', 'HEAD')).toBe(latest); expect(git('status', '--porcelain')).toBe('');
    expect(shell.getStats().active).toBe(0); expect(operation.getStats().active).toBe(0);
    await expect(resolveArtifactCommitIdentity(shell, dir, 'f'.repeat(39), () => {})).rejects.toThrow();
  });
  it('完整目标不做Git，未知、非法或不匹配输出不能借HEAD或旧CI目标冒充', async () => {
    const { shell, calls } = fakeGit('a'.repeat(40));
    expect(await resolveArtifactCommitIdentity(shell, '/owned', full.toUpperCase(), () => {})).toBe(full);
    expect(calls).toEqual([]);
    await expect(resolveArtifactCommitIdentity(shell, '/owned', 'HEAD', () => {})).rejects.toThrow('格式');
    await expect(resolveArtifactCommitIdentity(shell, '/owned', full.slice(0, 7), () => {})).rejects.toThrow('唯一完整');
    await expect(resolveArtifactCommitIdentity({} as IShellExecutor, '/owned', full.slice(0, 7), () => {})).rejects.toThrow('unavailable');
  });
  it('同短目标并行解析可保持资格，不同服务和项目互不取代；最后读取释放容量', () => {
    const c = new BranchOperationCoordinator(); const first = c.beginArtifactTargetRead(request), joined = c.beginArtifactTargetRead(request);
    const web = c.beginArtifactTargetRead({ ...request, profileId: 'web', commitSha: 'b'.repeat(7) });
    const other = c.beginArtifactTargetRead({ ...request, projectId: 'other', commitSha: 'c'.repeat(7) });
    first.release(); expect(() => joined.assertCurrent()).not.toThrow(); expect(() => web.assertCurrent()).not.toThrow(); expect(() => other.assertCurrent()).not.toThrow();
    joined.release(); web.release(); other.release(); expect(c.getActiveOperations()).toEqual([]);
    const reads = Array.from({ length: 64 }, () => c.beginArtifactTargetRead(request));
    expect(() => c.beginArtifactTargetRead(request)).toThrow('容量'); reads.forEach(read => read.release());
    expect(() => c.beginArtifactTargetRead(request).release()).not.toThrow();
  });
  it('较新同范围短目标或完整目标及终止操作撤销旧解析，等价完整提交允许原解析并入', () => {
    const c = new BranchOperationCoordinator(); const old = c.beginArtifactTargetRead(request);
    const newer = c.beginArtifactTargetRead({ ...request, commitSha: 'b'.repeat(7) });
    expect(() => old.assertCurrent()).toThrow(); newer.release(); old.release();
    const same = c.beginArtifactTargetRead(request); const accepted = c.begin({ ...request, commitSha: full });
    expect(accepted.status).toBe('started'); expect(() => same.assertCurrent()).not.toThrow(); same.release(); c.completeAll(accepted.lease!, 'completed');
    const late = c.beginArtifactTargetRead(request); c.begin({ ...request, commitSha: 'b'.repeat(40) }); expect(() => late.assertCurrent()).toThrow(); late.release();
    c.clearForTest(); const stop = c.beginArtifactTargetRead(request); c.cancelBranch(request.branchId, '停止'); expect(() => stop.assertCurrent()).toThrow(); stop.release();
    const shutdown = c.beginArtifactTargetRead(request); c.interruptAll('重启', 'test'); expect(() => shutdown.assertCurrent()).toThrow(); shutdown.release();
  });
  it('解析期间保留手动优先级，低优先级请求被拒不能撤销原读取', () => {
    const c = new BranchOperationCoordinator(); const manual = c.beginArtifactTargetRead(request);
    expect(() => c.beginArtifactTargetRead({ ...request, trigger: 'webhook', commitSha: 'b'.repeat(7) })).toThrow();
    expect(c.begin({ ...request, trigger: 'webhook', commitSha: 'b'.repeat(40) }).status).toBe('rejected');
    expect(() => manual.assertCurrent()).not.toThrow(); manual.release();
  });
  it('排队的Git读取在开始前重新确认资格，已经失效的请求不会启动读取', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const starts: string[] = [];
    const shell = { execBackgroundObservation: async (command, options) => {
      options?.beforeStart?.(); starts.push(command); if (command.includes('first')) await held;
      options?.onData?.(full, 'stdout'); return { exitCode: 0, stdout: '', stderr: '' };
    } } as IShellExecutor;
    const { createReleaseGitRunner } = await import('../../src/services/release-git-reader.js');
    const blocker = createReleaseGitRunner(shell)(['first']); let current = true;
    const queued = resolveArtifactCommitIdentity(shell, '/owned', full.slice(0, 7), () => { if (!current) throw new Error('已取代'); });
    const assertion = expect(queued).rejects.toThrow('已取代'); current = false; release(); await blocker; await assertion;
    expect(starts).toHaveLength(1);
  });
});
