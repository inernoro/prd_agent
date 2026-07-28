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
