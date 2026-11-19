import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { SchedulerService } from '../../src/services/scheduler.js';
import { containerImageReferences } from '../../src/services/container-image-references.js';
import { computeImageRetentionPlan } from '../../src/services/image-retention.js';
import { JanitorService, IMAGE_HELD_PREFIX } from '../../src/services/janitor.js';
import { createBranchPin, pinExpired, mayChangePin } from '../../src/services/branch-pin.js';
import { resolveBranchProtection } from '../../src/services/branch-protection.js';
import { classifySchedulerPressure } from '../../src/services/scheduler-pressure.js';
import type { BranchEntry, SchedulerConfig } from '../../src/types.js';

const roots: string[] = [];
const schedulers: SchedulerService[] = [];
const image = (n: number) => 'owned/app:sha-' + n.toString(16).padStart(40, '0');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-reclaim-heatpool-')); roots.push(root);
  const file = path.join(root, 'state.json');
  const state = new StateService(file); state.load();
  let now = Date.parse('2026-11-16T00:00:00Z');
  const config: SchedulerConfig = { enabled: true, maxHotBranches: 25, idleTTLSeconds: 900, tickIntervalSeconds: 60, pinnedBranches: [] };
  const scheduler = new SchedulerService(state, config, { now: () => now }); schedulers.push(scheduler);
  const names = new Set<string>();
  scheduler.setRuntimePresenceProvider(() => names);
  scheduler.setResourcePressureProvider(() => 'ample');
  scheduler.setCoolFn(async id => { names.delete(id); const b = state.getBranch(id)!; b.status = 'idle'; for (const s of Object.values(b.services)) s.status = 'stopped'; });
  function add(id: string, extra: Partial<BranchEntry> = {}) {
    const branch: BranchEntry = { id, branch: id, projectId: 'owned', worktreePath: root, createdAt: new Date(now).toISOString(),
      lastAccessedAt: new Date(now).toISOString(), status: 'running', heatState: 'hot',
      services: { app: { profileId: 'app', containerName: id, hostPort: 10000, status: 'running' } }, ...extra };
    state.addBranch(branch); if (branch.status === 'running') names.add(id); return state.getBranch(id)!;
  }
  return { root, file, state, config, scheduler, names, add, now: () => now, advance: (ms: number) => { now += ms; } };
}
afterEach(async () => { schedulers.splice(0).forEach(s => s.stop()); await flushAllJsonStateStores(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('回收与热池治理不变量', () => {
  it('原生ID解析停止容器的全部标签，digest引用不保住同仓库其他版本', async () => {
    const read = vi.fn(async (args: string[]) => {
      if (args[0] === 'ps') return 'container-id';
      if (args[0] === 'container') return JSON.stringify({ Id: 'container-id', Image: 'sha256:held' });
      return JSON.stringify({ Id: 'sha256:held', RepoTags: [image(1), image(2)] });
    });
    const refs = await containerImageReferences(read);
    const plan = computeImageRetentionPlan({ ledger: [{ image: image(99), branchId: 'b', profileId: 'app', createdAt: '' }],
      hostImages: [image(1), image(2), image(3)], inUseImages: refs, keepGenerations: 1, maxRemovals: 1 });
    expect(plan.remove).toEqual([image(3)]); expect(plan.keptReasons[image(1)]).toContain('容器引用');
  });

  it.each(['partial', 'changed', 'failure'])('引用盘点%s时保留未知，不形成空引用成功', async mode => {
    let scans = 0;
    await expect(containerImageReferences(async args => {
      if (args[0] === 'ps') return ++scans === 2 && mode === 'changed' ? '' : 'c';
      if (mode === 'failure') throw new Error('read failed');
      if (args[0] === 'container') return mode === 'partial' ? '' : JSON.stringify({ Id: 'c', Image: 'i' });
      return JSON.stringify({ Id: 'i', RepoTags: [image(1)] });
    })).rejects.toThrow();
  });

  it('持续失败的前缀不阻塞尾部，游标跨重启保留，新增速度低于回收速度时积压收敛', async () => {
    const f = fixture(); const host = new Set(Array.from({ length: 14 }, (_, n) => image(n + 1)));
    const failures = new Set([image(1), image(2)]); const samples: number[] = [];
    const ledger = [{ id: 'v', projectId: 'owned', branchId: 'b', createdAt: '2026-11-16', profiles: { app: { profileId: 'app', artifactImage: image(999) } } }];
    let state = f.state;
    for (let round = 0; round < 9; round++) {
      if (round < 4) host.add(image(30 + round));
      vi.spyOn(state, 'getDeploymentVersions').mockReturnValue(ledger as any);
      const janitor = new JanitorService(state, { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80,
        sweepIntervalSeconds: 3600, dockerPrune: false, orphanWorktrees: false, imageMaxRemovalsPerSweep: 3 }, f.root,
        undefined, () => ({ totalBytes: 1000, freeBytes: 900 }), undefined,
        { listImages: async () => [...host], listInUseImages: async () => [], removeImage: async tag => {
          if (failures.has(tag)) return IMAGE_HELD_PREFIX + '不可自动处置的别名'; host.delete(tag); return null;
        } });
      const result = await janitor.sweep();
      expect(result.imageRetention!.removed.length + result.imageRetention!.held.length).toBeLessThanOrEqual(3);
      samples.push([...host].filter(tag => !failures.has(tag)).length);
      await flushAllJsonStateStores();
      state = new StateService(f.file); state.load(); expect(state.getImageRetentionCursor()).toBeTruthy();
    }
    expect(samples.at(-1)).toBe(0); expect(host).toEqual(failures);
    console.info('reclaim-backlog-samples=' + JSON.stringify(samples));
  });

  it('只有明确空闲/停止且完整盘点才不计占位；异常、查询失败和在途任务仍保留', () => {
    const f = fixture(); f.add('empty', { status: 'idle', services: {} });
    f.add('stopped', { status: 'idle', services: { app: { profileId: 'app', containerName: 'stopped', hostPort: 1, status: 'stopped' } } });
    f.add('error', { status: 'error', services: {} }); f.add('main', { branch: 'main' });
    f.add('inflight', { status: 'idle', services: {} });
    f.scheduler.setOperationProtection(id => id === 'inflight');
    const snap = f.scheduler.getSnapshot();
    expect(snap.hot.map(b => b.slug).sort()).toEqual(['error', 'inflight', 'main']);
    expect(f.state.getBranch('empty')).toBeDefined(); expect(f.state.getBranch('error')).toBeDefined();
    expect(f.scheduler.isPinned(f.state.getBranch('main')!)).toBe(true);
    f.scheduler.setRuntimePresenceProvider(() => null);
    expect(f.scheduler.getSnapshot().hot.map(b => b.slug)).toContain('empty');
  });

  it('并发唤醒去重且预约占容量；全部受保护时拒绝越过25', async () => {
    const f = fixture();
    for (let n = 0; n < 24; n++) f.add('p' + n, { pinnedByUser: true });
    f.add('a', { status: 'idle', heatState: 'cold', services: {} }); f.add('b', { status: 'idle', heatState: 'cold', services: {} });
    let finish!: () => void; const wait = new Promise<void>(r => { finish = r; });
    const wake = vi.fn(async () => { await wait; }); f.scheduler.setWakeFn(wake);
    const a = f.scheduler.wake('a'), same = f.scheduler.wake('a');
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(f.scheduler.getSnapshot().capacityUsage.current).toBe(25);
    await expect(f.scheduler.wake('b')).rejects.toThrow('热池已满');
    finish(); await Promise.all([a, same]); expect(wake).toHaveBeenCalledTimes(1);
  });

  it('临时固定到期跨重启生效，永久/旧未知/主干/配置保护保留，AI不能伪造永久授权', async () => {
    const f = fixture(), branch = f.add('acceptance');
    f.scheduler.pin(branch.id, createBranchPin({ ttlSeconds: 60, reason: '本次验收' }, {}, 'agent:fixture', f.now()));
    f.add('legacy', { pinnedByUser: true }); f.add('main', { branch: 'main' }); f.config.pinnedBranches = ['configured']; f.add('configured');
    expect(f.scheduler.isPinned(branch)).toBe(true);
    expect(() => createBranchPin({ permanent: true, reason: 'x', authorizationRef: 'owner said so' }, { cdsUser: { isSystemOwner: true } }, 'agent')).toThrow('系统所有者');
    expect(mayChangePin(true, undefined, {}, 'agent')).toBe(false);
    expect(mayChangePin(true, undefined, { _cdsBasicHumanAuth: true, cdsUser: { username: 'reader', isSystemOwner: false } }, 'reader')).toBe(false);
    f.advance(61000); await flushAllJsonStateStores();
    const restarted = new StateService(f.file); restarted.load();
    expect(resolveBranchProtection(restarted.getBranch(branch.id)!, restarted, [], f.now()).protected).toBe(false);
    for (const id of ['legacy', 'main', 'configured']) expect(f.scheduler.isPinned(f.state.getBranch(id)!)).toBe(true);
    expect(pinExpired({ ...branch.userPin!, expiresAt: 'invalid' }, f.now())).toBe(false);
    expect(pinExpired({ ...branch.userPin!, actor: ' ', reason: ' ' }, f.now())).toBe(false);
  });

  it('充裕时连续运行不反复降温；压力、内存未知和容量保护仍会生效', async () => {
    const f = fixture(); const b = f.add('active'); const cool = vi.fn(async () => { f.names.delete(b.id); b.status = 'idle'; b.services.app.status = 'stopped'; });
    f.scheduler.setCoolFn(cool);
    for (let n = 0; n < 12; n++) { f.advance(16 * 60000); await f.scheduler.tick(); }
    expect(cool).not.toHaveBeenCalled();
    f.scheduler.setResourcePressureProvider(() => 'pressure'); await f.scheduler.tick(); expect(cool).toHaveBeenCalledTimes(1);
    f.add('uncertain'); f.advance(16 * 60000); f.scheduler.setResourcePressureProvider(() => { throw new Error('sample failed'); });
    await f.scheduler.tick(); expect(cool).toHaveBeenCalledTimes(2);
  });

  it('只有新鲜的负载/预算内存/磁盘共同充裕才跳过空闲回收', () => {
    const now = Date.now(), sample = { loadRatio: 0.1, saturated: false, availableMB: 8000, totalMB: 16000, diskPercent: 60, diskFreeBytes: 16 * 1024 ** 3, diskAt: new Date(now).toISOString() };
    expect(classifySchedulerPressure(sample, now)).toBe('ample');
    for (const change of [{ availableMB: 1000 }, { saturated: true }, { loadRatio: 1 }, { diskPercent: 85 }, { diskFreeBytes: 3 * 1024 ** 3 }]) expect(classifySchedulerPressure({ ...sample, ...change }, now)).toBe('pressure');
    expect(classifySchedulerPressure({ ...sample, diskPercent: null }, now)).toBe('unknown');
    expect(classifySchedulerPressure(sample, now + 61000)).toBe('unknown');
  });

  it('旧配置保护只在所有者显式复核后按期限退出，配置变化或记录不完整仍保留', () => {
    const f = fixture(); f.config.pinnedBranches = ['temporary']; const b = f.add('temporary');
    expect(f.scheduler.isPinned(b)).toBe(true);
    const pin = createBranchPin({ ttlSeconds: 60, reason: '本次验收完结退出' }, {}, 'owner', f.now());
    f.scheduler.reviewConfigPin(b.id, { ...pin, authorizationRef: '已授权工单fixture' });
    f.advance(61000); expect(f.scheduler.isPinned(b)).toBe(false);
    expect(f.scheduler.getSnapshot().protections.find(row => row.source === 'config-pinned')).toMatchObject({ active: false, reviewRequired: false });
    f.config.pinnedBranches.push('new-config-change'); expect(f.scheduler.isPinned(b)).toBe(true);
    f.config.pinnedBranches.pop(); delete b.configPinReview!.authorizationRef; expect(f.scheduler.isPinned(b)).toBe(true);
  });

  it('运行盘点抛错仍保留既有占用，冷却期间新增保护不能被误算成已腾位', async () => {
    const f = fixture(); const b = f.add('unknown');
    f.scheduler.setRuntimePresenceProvider(() => { throw new Error('read denied'); });
    expect(f.scheduler.getSnapshot().occupancy.find(row => row.slug === b.id)?.state).toBe('unknown');
    f.config.maxHotBranches = 1;
    await expect(f.scheduler.wake('new')).rejects.toThrow('热池已满');
    expect(b.heatState).toBe('hot');
  });

  it('新唤醒等已派发的降温完成，不并发启停同一资源；停止失败不盲目启动', async () => {
    const f = fixture(); const b = f.add('race'); let finish!: () => void;
    f.scheduler.setCoolFn(async () => { await new Promise<void>(resolve => { finish = resolve; }); f.names.delete(b.id); b.status = 'idle'; b.services.app.status = 'stopped'; });
    const wake = vi.fn(async () => { f.names.add(b.id); b.status = 'running'; b.services.app.status = 'running'; });
    f.scheduler.setWakeFn(wake);
    const stop = f.scheduler.markCold(b.id), start = f.scheduler.wake(b.id);
    await Promise.resolve(); expect(wake).not.toHaveBeenCalled(); finish(); await Promise.all([stop, start]);
    expect(wake).toHaveBeenCalledTimes(1); expect(b.heatState).toBe('hot'); expect(f.scheduler.getSnapshot().capacityUsage.current).toBe(1);
  });

  it('没有执行器或停止状态未确认时，不能把返回当作已释放容量', async () => {
    const f = fixture(); const b = f.add('unconfirmed');
    const unwired = new SchedulerService(f.state, f.config); schedulers.push(unwired);
    await expect(unwired.markCold(b.id)).rejects.toThrow('执行器未接入'); expect(b.heatState).toBe('hot');
    f.scheduler.setCoolFn(async () => { f.names.delete(b.id); });
    await f.scheduler.markCold(b.id);
    expect(f.scheduler.getSnapshot().capacityUsage.current).toBe(1);
    expect(f.scheduler.getSnapshot().occupancy.find(row => row.slug === b.id)?.state).toBe('unknown');
  });
});
