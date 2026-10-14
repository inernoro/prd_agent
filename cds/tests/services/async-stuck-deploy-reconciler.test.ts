import { describe, it, expect, vi } from 'vitest';
import { AsyncStuckDeployReconciler } from '../../src/services/async-stuck-deploy-reconciler.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';
const first = 'a'.repeat(40), second = 'b'.repeat(40);
const profiles = [{ id: 'web', activeDeployMode: 'express', deployModes: { express: { prebuilt: true } } }] as unknown as BuildProfile[];
const branch = (id = 'owned'): BranchEntry => ({ id, projectId: 'owned', branch: id, worktreePath: '/owned/' + id, services: {}, status: 'running', createdAt: new Date().toISOString(), ciImageStatus: 'ready', ciTargetSha: first, githubCommitSha: second });
function deferred() { let resolve!: (value: string) => void; const promise = new Promise<string>(r => { resolve = r; }); return { promise, resolve }; }
describe('异步卡死巡检', () => {
  it('Git未完成时生命周期已收敛，同轮重复调用共享读取', async () => {
    const b = branch(); const life = { ...branch('life'), ciImageStatus: undefined, status: 'starting', lastDeployStartedAt: '2026-06-27T00:18:00.000Z', lastReadyAt: '2026-06-27T01:01:00.000Z' } as BranchEntry;
    const pending = deferred(); const git = vi.fn(() => pending.promise); const saved = vi.fn();
    const runner = new AsyncStuckDeployReconciler({ getBranches: () => [b, life], getOptions: () => ({ getBuildProfiles: () => profiles }), git, onReconciled: saved });
    const run = runner.run(); expect(runner.run()).toBe(run); expect(life.status).toBe('running'); expect(saved).toHaveBeenCalledOnce(); expect(b.ciImageError).toBeUndefined();
    pending.resolve('prd-admin/src/App.tsx'); await run; expect(git).toHaveBeenCalledOnce(); expect(b.ciImageError).toContain('镜像落后');
  });
  it.each(['new-head', 'deleted', 'new-lease', 'profile-changed', 'ci-waiting'])('读取期间%s不回写旧证据', async change => {
    const old = branch(); let branches = [old]; let lease = false; let activeProfiles = profiles;
    const pending = deferred(); const getBranches = vi.fn(() => branches);
    const runner = new AsyncStuckDeployReconciler({ getBranches, getOptions: () => ({ getBuildProfiles: () => activeProfiles, hasActiveOperation: () => lease }), git: () => pending.promise });
    const run = runner.run();
    const current = { ...old, services: {} }; branches = [current];
    if (change === 'new-head') current.githubCommitSha = 'c'.repeat(40);
    if (change === 'deleted') branches = [];
    if (change === 'new-lease') lease = true;
    if (change === 'profile-changed') activeProfiles = [];
    if (change === 'ci-waiting') current.ciImageStatus = 'pending';
    pending.resolve('prd-admin/src/App.tsx'); await run;
    expect(getBranches).toHaveBeenCalledTimes(2); expect(old.ciImageError).toBeUndefined(); expect(current.ciImageError).toBeUndefined();
  });
  it('结束后告警只写当前权威对象，旧对象不再改动', async () => {
    const old = branch(); let current = old; const pending = deferred(); const emit = vi.fn();
    const runner = new AsyncStuckDeployReconciler({ getBranches: () => [current], getOptions: () => ({ getBuildProfiles: () => profiles, emitBranchUpdated: emit }), git: () => pending.promise });
    const run = runner.run(); current = { ...old, services: {} }; pending.resolve('prd-admin/src/App.tsx'); await run;
    expect(old.ciImageError).toBeUndefined(); expect(current.ciImageError).toContain('镜像落后'); expect(emit).toHaveBeenCalledWith(current);
  });
  it('失败未知不缓存，下一轮恢复；已告警提交对不再查询', async () => {
    const b = branch(); const git = vi.fn().mockRejectedValueOnce(new Error('owned unavailable')).mockResolvedValue('prd-admin/src/App.tsx');
    const runner = new AsyncStuckDeployReconciler({ getBranches: () => [b], getOptions: () => ({ getBuildProfiles: () => profiles }), git });
    await runner.run(); expect(b.ciImageError).toBeUndefined(); await runner.run(); expect(b.ciImageError).toContain('镜像落后'); await runner.run(); expect(git).toHaveBeenCalledTimes(2);
  });
  it('成功文档证据可缓存，目标变化重新查询', async () => {
    const b = branch(); const git = vi.fn().mockResolvedValueOnce('README.md').mockResolvedValue('prd-admin/src/App.tsx');
    const runner = new AsyncStuckDeployReconciler({ getBranches: () => [b], getOptions: () => ({ getBuildProfiles: () => profiles }), git });
    await runner.run(); await runner.run(); expect(git).toHaveBeenCalledOnce(); expect(b.ciImageError).toBeUndefined();
    b.githubCommitSha = 'c'.repeat(40); await runner.run(); expect(git).toHaveBeenCalledTimes(2); expect(b.ciImageError).toContain('镜像落后');
  });
  it('多个分支相同本地提交对共享读取，各自依据新状态告警', async () => {
    const branches = [branch('one'), branch('two')]; branches[1].worktreePath = branches[0].worktreePath;
    const git = vi.fn(async () => 'prd-admin/src/App.tsx');
    await new AsyncStuckDeployReconciler({ getBranches: () => branches, getOptions: () => ({ getBuildProfiles: () => profiles }), git }).run();
    expect(git).toHaveBeenCalledOnce(); expect(branches.every(b => b.ciImageError?.includes('镜像落后'))).toBe(true);
  });
  it('每轮最多16组，持续未知的35组均能轮转到，不无限展开', async () => {
    const branches = Array.from({ length: 35 }, (_, i) => branch('owned-' + i)); const seen: string[] = [];
    const git = vi.fn(async (args: readonly string[]) => { seen.push(args[1]); throw new Error('owned unavailable'); });
    const runner = new AsyncStuckDeployReconciler({ getBranches: () => branches, getOptions: () => ({ getBuildProfiles: () => profiles }), git });
    await runner.run(); expect(git).toHaveBeenCalledTimes(16); await runner.run(); expect(git).toHaveBeenCalledTimes(32); await runner.run(); expect(new Set(seen).size).toBe(35);
    expect(branches.every(b => b.ciImageError === undefined)).toBe(true);
  });
  it('短SHA保留当轮读取，但文档结论不永久缓存缩写', async () => {
    const b = branch(); b.ciTargetSha = 'a'.repeat(7); b.githubCommitSha = 'b'.repeat(7); const git = vi.fn(async () => 'README.md');
    const runner = new AsyncStuckDeployReconciler({ getBranches: () => [b], getOptions: () => ({ getBuildProfiles: () => profiles }), git });
    await runner.run(); await runner.run(); expect(git).toHaveBeenCalledTimes(2); expect(b.ciImageError).toBeUndefined();
  });
  it('非法SHA和超额描述符未知，合法其他分支仍可推进', async () => {
    const bad = branch('bad'); bad.ciTargetSha = '--owned'; const large = branch('large'); large.worktreePath = '/owned/' + 'x'.repeat(20 * 1024); const good = branch('good');
    const git = vi.fn(async () => 'prd-admin/src/App.tsx');
    await new AsyncStuckDeployReconciler({ getBranches: () => [bad, large, good], getOptions: () => ({ getBuildProfiles: () => profiles }), git }).run();
    expect(git).toHaveBeenCalledOnce(); expect(bad.ciImageError).toBeUndefined(); expect(large.ciImageError).toBeUndefined(); expect(good.ciImageError).toContain('镜像落后');
  });
});
