/**
 * 全局回收互斥（2026-07-27 宕机复盘 P2）。
 *
 * 事故当天人工清盘一执行 docker prune 就撞 "a prune operation is already running"。
 * 这里钉的是 CDS 侧的纪律：拿不到锁**跳过本轮**（不排队堆积，否则几轮回收压在
 * 一起，在磁盘最紧张时制造更大的 IO 尖峰），以及漏放锁不能让回收永久停摆。
 */
import { describe, it, expect } from 'vitest';
import { ReclaimLock, isReclaimSkip, RECLAIM_LOCK_STALE_MS } from '../../src/services/reclaim-lock.js';

describe('ReclaimLock', () => {
  it('空闲时正常执行并返回结果', async () => {
    const lock = new ReclaimLock();
    const r = await lock.run('janitor', async () => 42);
    expect(r).toBe(42);
    expect(lock.getState().holder).toBeNull();
  });

  it('被占用时跳过而不是排队，并带出「被谁挡了」', async () => {
    const lock = new ReclaimLock();
    let release!: () => void;
    const held = lock.run('janitor', () => new Promise<void>((res) => { release = res; }));
    const second = await lock.run('manual-api', async () => 'ran');
    expect(isReclaimSkip(second)).toBe(true);
    if (isReclaimSkip(second)) expect(second.heldBy).toBe('janitor');
    release();
    await held;
  });

  it('抛错也要释放锁——漏放一次就等于回收永久停摆', async () => {
    const lock = new ReclaimLock();
    await expect(lock.run('janitor', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(lock.getState().holder).toBeNull();
    await expect(lock.run('janitor', async () => 'ok')).resolves.toBe('ok');
  });

  it('持有超过阈值视为泄漏，下一次直接抢走（停摆比并发更危险）', async () => {
    let now = 1_000;
    const lock = new ReclaimLock(() => now);
    let release!: () => void;
    const held = lock.run('leaked', () => new Promise<void>((res) => { release = res; }));
    now += RECLAIM_LOCK_STALE_MS + 1;
    const r = await lock.run('janitor', async () => 'taken');
    expect(r).toBe('taken');
    release();
    await held;
  });

  it('释放后可以再次获取', async () => {
    const lock = new ReclaimLock();
    await lock.run('a', async () => undefined);
    const r = await lock.run('b', async () => 'second');
    expect(r).toBe('second');
  });
});

/**
 * 被接管的旧持有者不许释放后继者的锁（Codex PR #1275 五轮 P2）。
 *
 * 超时接管本身是有意的（漏放一次锁就永久停摆），但接管之后旧持有者**仍在跑**，
 * 它跑完时的 finally 若无条件清空状态，清掉的就是后继者的持有 —— 第三次回收因此
 * 进得来，与仍在跑的后继者并发执行 docker / worktree 的破坏性清理。
 */
describe('超时接管后的释放归属', () => {
  it('旧持有者完成时不清后继者的锁，第三方仍被挡在外面', async () => {
    let now = 0;
    const lock = new ReclaimLock(() => now);
    let releaseOld: () => void = () => undefined;
    const oldPass = lock.run('old', () => new Promise<string>((res) => { releaseOld = () => res('old-done'); }));

    // 越过泄漏阈值 → 后继者接管
    now += 31 * 60_000;
    let releaseNew: () => void = () => undefined;
    const newPass = lock.run('new', () => new Promise<string>((res) => { releaseNew = () => res('new-done'); }));
    expect(lock.getState().holder).toBe('new');

    // 旧持有者此刻才跑完：不得清掉 new 的持有
    releaseOld();
    expect(await oldPass).toBe('old-done');
    expect(lock.getState().holder).toBe('new');

    // 于是第三方仍然被挡（旧实现里这里会被放进来，与 new 并发跑破坏性清理）
    const third = await lock.run('third', async () => 'third-ran');
    expect(isReclaimSkip(third)).toBe(true);
    expect((third as { heldBy: string }).heldBy).toBe('new');

    releaseNew();
    expect(await newPass).toBe('new-done');
    expect(lock.getState().holder).toBeNull();
  });

  it('后继者跑完后锁正常释放，下一轮照常进入', async () => {
    let now = 0;
    const lock = new ReclaimLock(() => now);
    let releaseOld: () => void = () => undefined;
    const oldPass = lock.run('old', () => new Promise<string>((res) => { releaseOld = () => res('old-done'); }));
    now += 31 * 60_000;
    await lock.run('new', async () => 'new-done');
    releaseOld();
    await oldPass;
    expect(lock.getState().holder).toBeNull();
    expect(await lock.run('next', async () => 'next-ran')).toBe('next-ran');
  });
});

describe('保护标记（cds.protected=true）', () => {
  // 事故当天 cds-infra-cds-state-mongo 被人工 docker container prune 连带删除，
  // CDS 状态库随之消失。名单式保护只护得住写死的名字，标记式对所有 infra 生效。
  it('带标记的容器一律不收割', async () => {
    const { isProtectedByLabel } = await import('../../src/services/orphan-container-reaper.js');
    expect(isProtectedByLabel('cds.managed=true,cds.protected=true,cds.type=infra')).toBe(true);
    expect(isProtectedByLabel('cds.protected=true')).toBe(true);
  });

  it('没有标记 / 标记为 false / 只是名字里带 protected 的一律不豁免', async () => {
    const { isProtectedByLabel } = await import('../../src/services/orphan-container-reaper.js');
    expect(isProtectedByLabel('cds.managed=true,cds.type=app')).toBe(false);
    expect(isProtectedByLabel('cds.protected=false')).toBe(false);
    expect(isProtectedByLabel('cds.protected.hint=true')).toBe(false);
    expect(isProtectedByLabel('')).toBe(false);
  });
});
