import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  acquireBuildSlot,
  buildGateStatus,
  buildLoadFactor,
  maxConcurrentBuilds,
  pumpWaiters,
  setBuildGateHostLoadProvider,
  setMaxConcurrentBuildsProvider,
  BuildSlotCancelledError,
  __resetBuildGateForTest,
} from '../../src/services/build-gate.js';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('build-gate 全局构建并发闸', () => {
  const savedEnv = process.env.CDS_MAX_CONCURRENT_BUILDS;

  beforeEach(() => {
    __resetBuildGateForTest();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CDS_MAX_CONCURRENT_BUILDS;
    else process.env.CDS_MAX_CONCURRENT_BUILDS = savedEnv;
    __resetBuildGateForTest();
  });

  it('默认上限为 3，非法值回退默认', () => {
    delete process.env.CDS_MAX_CONCURRENT_BUILDS;
    expect(maxConcurrentBuilds()).toBe(3);
    process.env.CDS_MAX_CONCURRENT_BUILDS = '0';
    expect(maxConcurrentBuilds()).toBe(3);
    process.env.CDS_MAX_CONCURRENT_BUILDS = 'abc';
    expect(maxConcurrentBuilds()).toBe(3);
    process.env.CDS_MAX_CONCURRENT_BUILDS = '5';
    expect(maxConcurrentBuilds()).toBe(5);
  });

  it('槽位充足时立即授予，不触发排队回调', async () => {
    process.env.CDS_MAX_CONCURRENT_BUILDS = '2';
    let queuedCalled = false;
    const slot = await acquireBuildSlot({ onQueued: () => { queuedCalled = true; } });
    expect(queuedCalled).toBe(false);
    expect(buildGateStatus().active).toBe(1);
    slot.release();
    expect(buildGateStatus().active).toBe(0);
  });

  it('超过上限时排队，并报告正确的 ahead 位置', async () => {
    process.env.CDS_MAX_CONCURRENT_BUILDS = '2';
    const s1 = await acquireBuildSlot();
    const s2 = await acquireBuildSlot();
    expect(buildGateStatus().active).toBe(2);

    const queuedInfos: Array<{ ahead: number; active: number; max: number }> = [];
    const p3 = acquireBuildSlot({ onQueued: (i) => queuedInfos.push(i) });
    const p4 = acquireBuildSlot({ onQueued: (i) => queuedInfos.push(i) });
    await tick();

    expect(buildGateStatus().queued).toBe(2);
    expect(queuedInfos[0]).toEqual({ ahead: 0, active: 2, max: 2 });
    expect(queuedInfos[1]).toEqual({ ahead: 1, active: 2, max: 2 });

    // 释放一个 → 唤醒队首（FIFO），active 仍不超过上限
    s1.release();
    const s3 = await p3;
    await tick();
    expect(buildGateStatus().active).toBe(2);
    expect(buildGateStatus().queued).toBe(1);

    s2.release();
    const s4 = await p4;
    await tick();
    expect(buildGateStatus().active).toBe(2);
    expect(buildGateStatus().queued).toBe(0);

    s3.release();
    s4.release();
    expect(buildGateStatus().active).toBe(0);
  });

  it('FIFO 顺序：先排队先拿到槽位', async () => {
    process.env.CDS_MAX_CONCURRENT_BUILDS = '1';
    const order: number[] = [];
    const s0 = await acquireBuildSlot();

    const p1 = acquireBuildSlot().then((s) => { order.push(1); return s; });
    await tick();
    const p2 = acquireBuildSlot().then((s) => { order.push(2); return s; });
    await tick();
    const p3 = acquireBuildSlot().then((s) => { order.push(3); return s; });
    await tick();

    s0.release();
    const s1 = await p1; s1.release();
    const s2 = await p2; s2.release();
    const s3 = await p3; s3.release();
    expect(order).toEqual([1, 2, 3]);
  });

  it('永不超额（over-subscription）：release 唤醒与新 acquire 交错时 active ≤ max', async () => {
    process.env.CDS_MAX_CONCURRENT_BUILDS = '1';
    const s0 = await acquireBuildSlot();
    const p1 = acquireBuildSlot();
    await tick();
    expect(buildGateStatus().active).toBe(1);

    // release 把槽位转移给等待者；紧接着同步发起一个快路径 acquire
    s0.release();
    const fast = acquireBuildSlot(); // 此刻槽位已被 p1 预定，fast 必须排队
    const s1 = await p1;
    await tick();
    expect(buildGateStatus().active).toBe(1); // 绝不能变成 2
    expect(buildGateStatus().queued).toBe(1); // fast 在排队

    s1.release();
    const sFast = await fast;
    expect(buildGateStatus().active).toBe(1);
    sFast.release();
    expect(buildGateStatus().active).toBe(0);
  });

  it('release 幂等：重复调用不会把 active 减成负数', async () => {
    process.env.CDS_MAX_CONCURRENT_BUILDS = '2';
    const s = await acquireBuildSlot();
    s.release();
    s.release();
    s.release();
    expect(buildGateStatus().active).toBe(0);
  });

  // ── 2026-07-16 队列堵死复盘扩展：取消 / 身份 / 动态上限 ──

  it('排队中 abort → 立即出队并以 BuildSlotCancelledError 拒绝，幸存者 FIFO 不变', async () => {
    process.env.CDS_MAX_CONCURRENT_BUILDS = '1';
    const s0 = await acquireBuildSlot();
    const ac = new AbortController();
    const order: number[] = [];
    const pCancelled = acquireBuildSlot({ signal: ac.signal });
    await tick();
    const p2 = acquireBuildSlot().then((s) => { order.push(2); return s; });
    await tick();
    expect(buildGateStatus().queued).toBe(2);

    ac.abort();
    await expect(pCancelled).rejects.toBeInstanceOf(BuildSlotCancelledError);
    expect(buildGateStatus().queued).toBe(1);

    s0.release();
    const s2 = await p2;
    expect(order).toEqual([2]);
    expect(buildGateStatus().active).toBe(1);
    s2.release();
    expect(buildGateStatus().active).toBe(0);
  });

  it('进入排队前已 abort / isCancelled 判真 → 直接拒绝，不占队列', async () => {
    process.env.CDS_MAX_CONCURRENT_BUILDS = '1';
    const s0 = await acquireBuildSlot();
    const ac = new AbortController();
    ac.abort();
    await expect(acquireBuildSlot({ signal: ac.signal })).rejects.toBeInstanceOf(BuildSlotCancelledError);
    await expect(acquireBuildSlot({ isCancelled: () => true })).rejects.toBeInstanceOf(BuildSlotCancelledError);
    expect(buildGateStatus().queued).toBe(0);
    s0.release();
  });

  it('槽位转移跳过 isCancelled 判真的等待者并逐个拒绝，active 永不超上限', async () => {
    process.env.CDS_MAX_CONCURRENT_BUILDS = '1';
    const s0 = await acquireBuildSlot();
    let cancelled = false;
    const pZombie = acquireBuildSlot({ isCancelled: () => cancelled });
    await tick();
    const pLive = acquireBuildSlot();
    await tick();
    expect(buildGateStatus().queued).toBe(2);

    cancelled = true;
    const zombieRejected = expect(pZombie).rejects.toBeInstanceOf(BuildSlotCancelledError);
    s0.release();
    await zombieRejected;
    const sLive = await pLive;
    expect(buildGateStatus().active).toBe(1);
    expect(buildGateStatus().queued).toBe(0);
    sLive.release();
    expect(buildGateStatus().active).toBe(0);
  });

  it('全部等待者都已取消时 release 把 active 归零（不留假占位）', async () => {
    process.env.CDS_MAX_CONCURRENT_BUILDS = '1';
    const s0 = await acquireBuildSlot();
    // 入队时仍存活（绕过入队前置取消检查），排队后才取消 → 走「槽位转移跳过」路径
    let cancelled = false;
    const pZombie1 = acquireBuildSlot({ isCancelled: () => cancelled });
    await tick();
    const pZombie2 = acquireBuildSlot({ isCancelled: () => cancelled });
    await tick();
    expect(buildGateStatus().queued).toBe(2);

    cancelled = true;
    const zombie1Rejected = expect(pZombie1).rejects.toBeInstanceOf(BuildSlotCancelledError);
    const zombie2Rejected = expect(pZombie2).rejects.toBeInstanceOf(BuildSlotCancelledError);
    s0.release();
    await zombie1Rejected;
    await zombie2Rejected;
    expect(buildGateStatus().active).toBe(0);
    expect(buildGateStatus().queued).toBe(0);
  });

  it('holders / waiters 透出持有者身份，释放后移除', async () => {
    process.env.CDS_MAX_CONCURRENT_BUILDS = '1';
    const s0 = await acquireBuildSlot({ holder: { branchId: 'b1', profileId: 'api', runId: 'dr_1' } });
    const pQueued = acquireBuildSlot({ holder: { branchId: 'b2', profileId: 'web' } });
    await tick();

    const status = buildGateStatus();
    expect(status.holders).toHaveLength(1);
    expect(status.holders[0]).toMatchObject({ branchId: 'b1', profileId: 'api', runId: 'dr_1' });
    expect(status.holders[0].acquiredAt).toBeTruthy();
    expect(status.waiters).toHaveLength(1);
    expect(status.waiters[0]).toMatchObject({ branchId: 'b2', profileId: 'web' });

    s0.release();
    const s1 = await pQueued;
    const after = buildGateStatus();
    expect(after.holders).toHaveLength(1);
    expect(after.holders[0]).toMatchObject({ branchId: 'b2' });
    expect(after.waiters).toHaveLength(0);
    s1.release();
    expect(buildGateStatus().holders).toHaveLength(0);
  });

  it('拿到槽位后 abort 是 no-op，槽位仍可正常释放', async () => {
    process.env.CDS_MAX_CONCURRENT_BUILDS = '2';
    const ac = new AbortController();
    const s = await acquireBuildSlot({ signal: ac.signal });
    ac.abort();
    expect(buildGateStatus().active).toBe(1);
    s.release();
    expect(buildGateStatus().active).toBe(0);
  });

  it('pumpWaiters：上限上调后立即唤醒排队者（FIFO），并跳过已取消者', async () => {
    process.env.CDS_MAX_CONCURRENT_BUILDS = '1';
    const s0 = await acquireBuildSlot();
    const order: number[] = [];
    let zombieCancelled = false;
    const pZombie = acquireBuildSlot({ isCancelled: () => zombieCancelled });
    await tick();
    const p1 = acquireBuildSlot().then((s) => { order.push(1); return s; });
    await tick();
    const p2 = acquireBuildSlot().then((s) => { order.push(2); return s; });
    await tick();
    expect(buildGateStatus().queued).toBe(3);

    zombieCancelled = true;
    process.env.CDS_MAX_CONCURRENT_BUILDS = '3';
    const zombieRejected = expect(pZombie).rejects.toBeInstanceOf(BuildSlotCancelledError);
    const woken = pumpWaiters();
    expect(woken).toBe(2);
    await zombieRejected;
    const s1 = await p1;
    const s2 = await p2;
    expect(order).toEqual([1, 2]);
    expect(buildGateStatus().active).toBe(3);
    expect(buildGateStatus().queued).toBe(0);
    s0.release();
    s1.release();
    s2.release();
    expect(buildGateStatus().active).toBe(0);
  });

  it('上限下调后 release 不再转移槽位，active 逐步缩到新上限（Codex P1）', async () => {
    process.env.CDS_MAX_CONCURRENT_BUILDS = '3';
    const s1 = await acquireBuildSlot();
    const s2 = await acquireBuildSlot();
    const s3 = await acquireBuildSlot();
    const order: number[] = [];
    const p4 = acquireBuildSlot().then((s) => { order.push(4); return s; });
    await tick();
    expect(buildGateStatus()).toMatchObject({ active: 3, queued: 1 });

    // 紧急节流：上限下调到 1。此后每次 release 都应缩减 active 而不是唤醒排队者，
    // 直到 active 降到新上限才恢复槽位转移。
    process.env.CDS_MAX_CONCURRENT_BUILDS = '1';
    s1.release();
    await tick();
    expect(buildGateStatus()).toMatchObject({ active: 2, queued: 1 });
    expect(order).toEqual([]); // 排队者未被过早唤醒

    s2.release();
    await tick();
    expect(buildGateStatus()).toMatchObject({ active: 1, queued: 1 });
    expect(order).toEqual([]);

    // active 已到新上限：最后一次 release 恢复正常槽位转移
    s3.release();
    const s4 = await p4;
    expect(order).toEqual([4]);
    expect(buildGateStatus()).toMatchObject({ active: 1, queued: 0 });
    s4.release();
    expect(buildGateStatus().active).toBe(0);
  });

  it('运行时供给器生效且 env 优先于供给器', () => {
    delete process.env.CDS_MAX_CONCURRENT_BUILDS;
    setMaxConcurrentBuildsProvider(() => 6);
    expect(maxConcurrentBuilds()).toBe(6);
    process.env.CDS_MAX_CONCURRENT_BUILDS = '2';
    expect(maxConcurrentBuilds()).toBe(2);
    setMaxConcurrentBuildsProvider(null);
    delete process.env.CDS_MAX_CONCURRENT_BUILDS;
    expect(maxConcurrentBuilds()).toBe(3);
  });

  // 2026-09-08 宿主过载复盘：上限不动，宿主过载时准入收紧为 1 并发，负载降下来再按 FIFO 放行。
  describe('负载自适应准入', () => {
    const savedFactor = process.env.CDS_BUILD_LOAD_FACTOR;
    afterEach(() => {
      if (savedFactor === undefined) delete process.env.CDS_BUILD_LOAD_FACTOR;
      else process.env.CDS_BUILD_LOAD_FACTOR = savedFactor;
    });

    it('系数默认 1.2；0/off 关闭；env 可覆盖', () => {
      delete process.env.CDS_BUILD_LOAD_FACTOR;
      expect(buildLoadFactor()).toBe(1.2);
      expect(buildLoadFactor({ CDS_BUILD_LOAD_FACTOR: '0' })).toBe(0);
      expect(buildLoadFactor({ CDS_BUILD_LOAD_FACTOR: 'off' })).toBe(0);
      expect(buildLoadFactor({ CDS_BUILD_LOAD_FACTOR: '2' })).toBe(2);
      expect(buildLoadFactor({ CDS_BUILD_LOAD_FACTOR: 'abc' })).toBe(1.2);
    });

    it('过载时只放行 1 个构建，其余排队并标注 throttledByLoad；负载降下来后 pump 放行', async () => {
      process.env.CDS_MAX_CONCURRENT_BUILDS = '3';
      delete process.env.CDS_BUILD_LOAD_FACTOR;
      let load1 = 26; // 18 核 load 26 = 1.44 倍
      setBuildGateHostLoadProvider(() => ({ load1, cores: 18 }));
      expect(buildGateStatus().load).toMatchObject({ cores: 18, ratio: 1.44, saturated: true });

      const s1 = await acquireBuildSlot();
      expect(buildGateStatus().active).toBe(1);

      const infos: Array<Record<string, unknown>> = [];
      const p2 = acquireBuildSlot({ onQueued: (i) => infos.push(i as Record<string, unknown>) });
      await tick();
      expect(buildGateStatus()).toMatchObject({ active: 1, queued: 1 });
      expect(infos[0]).toMatchObject({ ahead: 0, active: 1, max: 3, throttledByLoad: true });
      expect((infos[0].load as { saturated: boolean }).saturated).toBe(true);

      // 负载降下来：pump 立即按 FIFO 放行
      load1 = 6;
      expect(pumpWaiters()).toBe(1);
      const s2 = await p2;
      expect(buildGateStatus()).toMatchObject({ active: 2, queued: 0 });
      s1.release();
      s2.release();
      expect(buildGateStatus().active).toBe(0);
    });

    it('过载时 release 不转移槽位（并发先缩），active 归零后仍能放行队首、队列不饿死', async () => {
      process.env.CDS_MAX_CONCURRENT_BUILDS = '3';
      delete process.env.CDS_BUILD_LOAD_FACTOR;
      let load1 = 2;
      setBuildGateHostLoadProvider(() => ({ load1, cores: 4 }));
      const s1 = await acquireBuildSlot();
      const s2 = await acquireBuildSlot();
      expect(buildGateStatus().active).toBe(2);

      load1 = 10; // 突然过载
      const p3 = acquireBuildSlot();
      await tick();
      expect(buildGateStatus().queued).toBe(1);

      s1.release(); // 过载中：不转移，active 2 → 1，等待者留队
      await tick();
      expect(buildGateStatus()).toMatchObject({ active: 1, queued: 1 });

      s2.release(); // active 1 → 转移给队首（至少保证 1 个在跑）
      const s3 = await p3;
      await tick();
      expect(buildGateStatus()).toMatchObject({ active: 1, queued: 0 });
      s3.release();
      expect(buildGateStatus().active).toBe(0);
    });

    /**
     * Codex 五轮 P2：waiter 当初因 active === max 入队，那条路径不开负载定时器。
     * 运维随后调高上限并 pumpWaiters()，此刻宿主饱和放不出人——若这里不补开定时器，
     * 队列就只能等下一次 release 才被重新考虑，新腾出来的容量白白空转几分钟。
     */
    it('上限上调时宿主仍饱和：定时器接手，负载回落即放行，不必等有构建 release', async () => {
      vi.useFakeTimers();
      try {
        process.env.CDS_MAX_CONCURRENT_BUILDS = '1';
        delete process.env.CDS_BUILD_LOAD_FACTOR;
        let load1 = 2; // 4 核 load 2 = 0.5 倍，不饱和
        setBuildGateHostLoadProvider(() => ({ load1, cores: 4 }));

        const s1 = await acquireBuildSlot();
        const p2 = acquireBuildSlot(); // 被上限挡住入队（非负载），这条路径不开定时器
        await vi.advanceTimersByTimeAsync(0);
        expect(buildGateStatus()).toMatchObject({ active: 1, queued: 1 });

        load1 = 10; // 宿主转为饱和
        process.env.CDS_MAX_CONCURRENT_BUILDS = '3'; // 运维调高上限
        expect(pumpWaiters()).toBe(0); // 这一轮被负载挡住，放不出人

        load1 = 2; // 负载回落——注意全程没有任何构建 release
        await vi.advanceTimersByTimeAsync(20_000);
        const s2 = await p2;
        expect(buildGateStatus()).toMatchObject({ active: 2, queued: 0 });
        s1.release();
        s2.release();
      } finally {
        vi.useRealTimers();
      }
    });

    it('系数关闭时退回纯上限准入', async () => {
      process.env.CDS_MAX_CONCURRENT_BUILDS = '2';
      process.env.CDS_BUILD_LOAD_FACTOR = 'off';
      setBuildGateHostLoadProvider(() => ({ load1: 99, cores: 1 }));
      const a = await acquireBuildSlot();
      const b = await acquireBuildSlot();
      expect(buildGateStatus()).toMatchObject({ active: 2, queued: 0 });
      expect(buildGateStatus().load.saturated).toBe(false);
      a.release();
      b.release();
    });
  });
});
