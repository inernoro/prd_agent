import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { BranchLifecycleService, branchCompletelyStarted } from '../../src/services/branch-lifecycle.js';
import type { BranchEntry } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const DAY = 86_400_000;
const roots: string[] = [];
afterEach(async () => { await flushAllJsonStateStores(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-branch-lifecycle-')); roots.push(root);
  const state = new StateService(path.join(root, 'state.json')); state.load();
  let now = Date.parse('2026-11-09T12:00:00Z');
  const observed = new Set<string>(); let known = true;
  const active = new Set<string>(); const audit = { record: vi.fn() };
  const add = (id: string, overrides: Partial<BranchEntry> = {}) => {
    const branch = { id, projectId: 'default', branch: `feature/${id}`, worktreePath: path.join(root, id), services: {},
      status: 'idle', createdAt: new Date(now - 2 * DAY).toISOString(), ...overrides } as BranchEntry;
    fs.mkdirSync(branch.worktreePath, { recursive: true }); fs.writeFileSync(path.join(branch.worktreePath, 'data'), 'keep me');
    state.addBranch(branch); for (const service of Object.values(branch.services)) if (service.status === 'running') observed.add(service.containerName);
    return state.getBranch(id)!;
  };
  const stop = vi.fn(async (branch: BranchEntry) => {
    for (const service of Object.values(branch.services)) { observed.delete(service.containerName); service.status = 'stopped'; }
    branch.status = 'idle';
  });
  const remove = vi.fn(async (id: string) => { state.removeBranch(id); });
  const service = new BranchLifecycleService({ state, clock: () => now, observed: () => known ? observed : null,
    active: id => active.has(id), expectedProfiles: () => ['api', 'web'], stop, remove, audit, flush: () => state.flush() });
  return { root, state, service, add, stop, remove, active, audit, advance: (ms: number) => { now += ms; }, unknown: () => { known = false; } };
}
function partial(): Partial<BranchEntry> { return { services: { api: { profileId: 'api', containerName: 'owned-api', status: 'running', hostPort: 12000 } } }; }

describe('分支生命周期与归档', () => {
  it('30分钟前保留部分运行，边界到达后停止全部本分支容器并记录策略原因', async () => {
    const f = fixture(); const branch = f.add('partial', partial());
    await f.service.sweep(); expect(f.stop).not.toHaveBeenCalled();
    f.advance(30 * 60_000 - 1); await f.service.sweep(); expect(f.stop).not.toHaveBeenCalled();
    f.advance(1); await f.service.sweep(); expect(f.stop).toHaveBeenCalledTimes(1);
    expect(branch.services.api.status).toBe('stopped'); expect(branch.lastStopSource).toBe('cds');
    expect(branch.lastStopReason).toContain('整组未完全启动超过 30 分钟');
    expect(branch.archive).toBeUndefined(); expect(branch.incompleteSince).toBeNull();
    expect(fs.readFileSync(path.join(branch.worktreePath, 'data'), 'utf8')).toBe('keep me');
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'branch.lifecycle.startup-stopped' }));
  });

  it('CI失败但旧版本整组健康时，不自动停止健康服务', async () => {
    const f = fixture(); f.add('healthy', { ...partial(), status: 'running', ciImageStatus: 'failed',
      services: { ...partial().services, web: { profileId: 'web', containerName: 'owned-web', status: 'running', hostPort: 12001 } } });
    await f.service.sweep(); f.advance(DAY); await f.service.sweep(); expect(f.stop).not.toHaveBeenCalled();
  });

  it('用户重新部署使用本轮30分钟窗口，不继承前一轮未完成计时', async () => {
    const f = fixture(); const branch = f.add('retry', partial()); await f.service.sweep();
    f.advance(20 * 60_000); branch.lastDeployStartedAt = '2026-11-09T12:20:00Z'; await f.service.sweep();
    f.advance(10 * 60_000); await f.service.sweep(); expect(f.stop).not.toHaveBeenCalled();
    f.advance(20 * 60_000); await f.service.sweep(); expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it('CI等待及停止的空分支可归档，完整运行分支不在主要清理范围', async () => {
    const f = fixture(); f.add('ci', { ciImageStatus: 'waiting' }); f.add('stopped');
    f.add('healthy', { services: { api: { profileId: 'api', containerName: 'a', status: 'running', hostPort: 1 },
      web: { profileId: 'web', containerName: 'w', status: 'running', hostPort: 2 } }, status: 'running' });
    expect(f.service.preview('default', 'incomplete').candidates.map(b => b.id)).toEqual(['ci', 'stopped']);
    expect(f.service.preview('default', 'all').candidates).toHaveLength(3);
    const result = await f.service.cleanup('default', 'incomplete', 'user');
    expect(result.archivedCount).toBe(2); expect(f.stop).not.toHaveBeenCalled();
    expect(f.state.getBranch('ci')?.archive?.reason).toContain('未完全启动');
    expect(f.state.getBranch('healthy')?.archive).toBeUndefined();
  });

  it('归档只隐藏和停止；工作区、数据及服务元数据在保留期内仍存在，重载可恢复', async () => {
    const f = fixture(); const branch = f.add('partial', partial());
    await f.service.archive(branch.id, 'manual archive', 'user');
    expect(f.stop).toHaveBeenCalledTimes(1); expect(f.remove).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(branch.worktreePath, 'data'))).toBe(true);
    const reloaded = new StateService(path.join(f.root, 'state.json')); reloaded.load();
    expect(reloaded.getBranch(branch.id)?.archive?.actor).toBe('user');
    expect(reloaded.getBranch(branch.id)?.services.api.status).toBe('stopped');
    await f.service.restore(branch.id, 'user'); expect(branch.archive).toBeNull();
    await f.service.sweep(); expect(branch.archive).toBeNull(); expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it('归档30天边界之前绝不物理回收，到期才调用已有分支回收流程', async () => {
    const f = fixture(); f.add('old'); await f.service.archive('old', 'manual', 'user');
    f.advance(30 * DAY - 1); await f.service.sweep(); expect(f.remove).not.toHaveBeenCalled();
    f.advance(1); await f.service.sweep(); expect(f.remove).toHaveBeenCalledTimes(1); expect(f.remove).toHaveBeenCalledWith('old');
  });

  it('没有访问记录且闲置24小时才自动归档；记录过预览的分支不套用此规则', async () => {
    const f = fixture(); const old = f.add('never'); f.add('visited', { lastAccessedAt: new Date().toISOString() });
    f.add('recent', { createdAt: '2026-11-09T11:59:00Z' });
    await f.service.sweep(); expect(old.archive).toBeTruthy(); expect(f.state.getBranch('visited')?.archive).toBeUndefined();
    expect(f.state.getBranch('recent')?.archive).toBeUndefined();
  });

  it('主分支、固定、调试中以及忙碌分支都跳过，跨项目目标也不进入清理', async () => {
    const f = fixture(); f.add('main', { branch: 'main', ...partial() }); f.add('pinned', { pinnedByUser: true });
    f.add('debug', { isColorMarked: true }); f.add('busy'); f.active.add('busy'); f.add('other', { projectId: 'other' });
    expect(f.service.preview('default', 'all').candidates).toHaveLength(0);
    await f.service.sweep(); expect(f.stop).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });

  it('Docker状态未知或停止未确认时不归档，失败不能伪装成已经释放资源', async () => {
    const f = fixture(); const branch = f.add('partial', partial()); f.stop.mockImplementation(async () => {});
    await expect(f.service.archive(branch.id, 'manual')).rejects.toThrow('停止尚未确认');
    expect(branch.archive).toBeUndefined(); f.unknown();
    await expect(f.service.archive(branch.id, 'manual')).rejects.toThrow('状态尚未确认'); expect(branch.archive).toBeUndefined();
  });

  it('停止过程中有新push则取消归档，保留新提交在默认列表', async () => {
    const f = fixture(); const branch = f.add('raced', partial());
    f.stop.mockImplementation(async () => { branch.lastPushAt = '2026-11-09T12:01:00Z'; });
    await expect(f.service.archive(branch.id, 'manual')).rejects.toThrow('分支状态已变化'); expect(branch.archive).toBeUndefined();
  });

  it('副本没有就绪时整组不算完全启动', () => {
    const branch = { status: 'running', services: { api: { status: 'running' } }, replicaSets: {
      api: { enabled: true, members: [{ status: 'provisioning' }] },
    } } as unknown as BranchEntry;
    expect(branchCompletelyStarted(branch, ['api'])).toBe(false);
  });

  it('自动停止期间的新push不被旧策略覆盖为停止记录', async () => {
    const f = fixture(); const branch = f.add('raced-stop', { ...partial(), incompleteSince: '2026-11-09T10:00:00Z' });
    f.stop.mockImplementation(async () => { branch.lastPushAt = '2026-11-09T12:01:00Z'; });
    await f.service.sweep();
    expect(branch.lastStopReason).toBeUndefined();
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'branch.lifecycle.deferred', message: expect.stringContaining('分支状态已变化') }));
  });

  it('恢复时取得锁失败不泄漏清理标志，重试仍能恢复', async () => {
    const f = fixture(); f.add('restore'); await f.service.archive('restore', 'manual');
    const release = vi.fn(); const lock = vi.fn().mockImplementationOnce(() => { throw new Error('busy'); })
      .mockImplementation(() => ({ assertCurrent: () => {}, release }));
    const service = new BranchLifecycleService({ state: f.state, observed: () => new Set(), active: () => false,
      stop: f.stop, remove: f.remove, lock });
    await expect(service.restore('restore', 'user')).rejects.toThrow('busy');
    expect(f.state.getBranch('restore')?.archive).toBeTruthy();
    await service.restore('restore', 'user'); expect(f.state.getBranch('restore')?.archive).toBeNull();
    expect(release).toHaveBeenCalledWith(false);
  });

  it('跨过下一次定时扫描也不会丢掉正在停止的任务，关闭等待其结束', async () => {
    const f = fixture(); f.add('slow', { ...partial(), incompleteSince: '2026-11-09T10:00:00Z' });
    let finish!: () => void;
    const originalStop = f.stop.getMockImplementation()!;
    f.stop.mockImplementation(async branch => { await new Promise<void>(resolve => { finish = resolve; }); await originalStop(branch); });
    vi.useFakeTimers();
    try {
      f.service.start(); await vi.advanceTimersByTimeAsync(60_000);
      expect(f.stop).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      let closed = false; const closing = f.service.close().then(() => { closed = true; });
      await Promise.resolve(); expect(closed).toBe(false); expect(f.stop).toHaveBeenCalledTimes(1);
      finish(); await closing; expect(closed).toBe(true);
    } finally { finish?.(); vi.useRealTimers(); await f.service.close(); }
  });
});
