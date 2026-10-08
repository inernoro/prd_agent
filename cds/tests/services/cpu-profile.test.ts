import { describe, expect, it } from 'vitest';

import {
  CPU_PROFILE_DEFAULT_SECONDS,
  CPU_PROFILE_MAX_SECONDS,
  CPU_PROFILE_MIN_SECONDS,
  CpuProfileBusyError,
  captureCpuProfile,
  clampProfileSeconds,
  summarizeCpuProfile,
  type CpuProfile,
} from '../../src/services/cpu-profile.js';

describe('CPU profile 摘要', () => {
  const profile: CpuProfile = {
    startTime: 0,
    endTime: 10_000_000,
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 } },
      { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
      { id: 3, callFrame: { functionName: 'takeSnapshot', url: 'file:///opt/prd_agent/cds/dist/infra/state-store/mongo-split-store.js', lineNumber: 799 } },
      { id: 4, callFrame: { functionName: 'stableJson', url: 'file:///opt/prd_agent/cds/dist/infra/state-store/mongo-split-store.js', lineNumber: 120 } },
      { id: 5, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 } },
      { id: 6, callFrame: { functionName: '(program)', url: '', lineNumber: -1 } },
    ],
    // 每个采样间隔 1000µs；idle 4 次、takeSnapshot 3 次、stableJson 2 次、GC 1 次、program 1 次
    samples: [2, 2, 2, 2, 3, 3, 3, 4, 4, 5, 6],
    timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
  };

  it('按函数聚合自身耗时，空闲 / GC / 原生单列，排行只算非空闲时间', () => {
    const summary = summarizeCpuProfile(profile);
    expect(summary).toMatchObject({ durationMs: 10_000, sampleCount: 11, idleMs: 4, gcMs: 1, programMs: 1 });
    expect(summary.top.map((r) => r.functionName)).toEqual(['takeSnapshot', 'stableJson']);
    expect(summary.top[0]).toMatchObject({
      location: 'dist/infra/state-store/mongo-split-store.js:800',
      selfMs: 3,
      // 非空闲 7ms 里占 3ms
      selfPercent: 42.9,
    });
  });

  it('采样秒数夹在上下限之间，非法值取默认', () => {
    expect(clampProfileSeconds(undefined)).toBe(CPU_PROFILE_DEFAULT_SECONDS);
    expect(clampProfileSeconds('abc')).toBe(CPU_PROFILE_DEFAULT_SECONDS);
    expect(clampProfileSeconds(1)).toBe(CPU_PROFILE_MIN_SECONDS);
    expect(clampProfileSeconds(999)).toBe(CPU_PROFILE_MAX_SECONDS);
    expect(clampProfileSeconds('12')).toBe(12);
  });
});

describe('CPU profile 真实采样', () => {
  it('能在本进程采到样本；采样进行中再次调用直接拒绝', async () => {
    const first = captureCpuProfile(0.3);
    await expect(captureCpuProfile(0.3)).rejects.toBeInstanceOf(CpuProfileBusyError);
    // 采样期间让主线程忙一会儿，确保有非空闲样本
    const until = Date.now() + 150;
    let x = 0;
    while (Date.now() < until) x += Math.sqrt(x + 1);
    const profile = await first;
    expect(profile.nodes.length).toBeGreaterThan(1);
    expect((profile.samples || []).length).toBeGreaterThan(10);
    const summary = summarizeCpuProfile(profile);
    expect(summary.durationMs).toBeGreaterThanOrEqual(250);
    // 结束后可以再采
    const again = await captureCpuProfile(0.05);
    expect(again.nodes.length).toBeGreaterThan(0);
  });
});
