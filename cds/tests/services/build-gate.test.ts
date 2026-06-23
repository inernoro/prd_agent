import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  acquireBuildSlot,
  buildGateStatus,
  maxConcurrentBuilds,
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
});
