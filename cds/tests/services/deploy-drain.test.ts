import { describe, it, expect } from 'vitest';
import {
  drainInFlightDeploys, isRunInFlight, isRunAlive, pendingRunsToDrain,
  DRAIN_STALE_HEARTBEAT_MS, type DrainableRun,
} from '../../src/services/deploy-drain.js';

/**
 * 自更新重启前排空在途部署（debt.cds.selfupdate-prebuilt #1）。
 *
 * 本 PR 期间该竞态复现 6 次以上：自更新重启杀掉在途部署 → 心跳过期 → 看门狗
 * 收敛为 failed → PR check 变红 → 人工重触发。这里把「等什么、等多久、什么时候
 * 该放弃」钉成回归，尤其是**放弃条件**：等待绝不能把自更新永久堵死。
 */
const run = (id: string, status: string, heartbeatAt?: string): DrainableRun => ({ id, status, heartbeatAt });
const T0 = Date.parse('2026-07-27T10:00:00Z');

describe('在途判定', () => {
  it('running 是成功终态（CDS 历史语义），不算在途', () => {
    expect(isRunInFlight(run('a', 'running'))).toBe(false);
    expect(isRunInFlight(run('a', 'failed'))).toBe(false);
    expect(isRunInFlight(run('a', 'cancelled'))).toBe(false);
  });

  it('queued / building / deploying 算在途', () => {
    for (const s of ['queued', 'building', 'deploying', 'pending', 'starting']) {
      expect(isRunInFlight(run('a', s)), s).toBe(true);
    }
  });

  it('心跳早已过期的僵尸 run 不再等——否则它能把自更新拖满整个超时窗口', () => {
    const stale = new Date(T0 - DRAIN_STALE_HEARTBEAT_MS - 1000).toISOString();
    expect(isRunAlive(run('a', 'building', stale), T0)).toBe(false);
    const fresh = new Date(T0 - 10_000).toISOString();
    expect(isRunAlive(run('a', 'building', fresh), T0)).toBe(true);
  });

  it('没有时间信息时保守当作活着（宁可多等一会儿也不误杀在途部署）', () => {
    expect(isRunAlive(run('a', 'building'), T0)).toBe(true);
  });

  it('pendingRunsToDrain 只留下值得等的', () => {
    const runs = [
      run('ok', 'running'),
      run('live', 'building', new Date(T0 - 5_000).toISOString()),
      run('zombie', 'building', new Date(T0 - 10 * 60_000).toISOString()),
    ];
    expect(pendingRunsToDrain(runs, T0).map((r) => r.id)).toEqual(['live']);
  });
});

describe('排空流程', () => {
  const mkDeps = (frames: DrainableRun[][], timeoutMs = 60_000) => {
    let now = T0;
    let i = 0;
    const waits: number[] = [];
    return {
      deps: {
        listRuns: () => frames[Math.min(i, frames.length - 1)],
        now: () => now,
        sleep: async (ms: number) => { now += ms; i += 1; waits.push(ms); },
        timeoutMs,
        pollIntervalMs: 1_000,
      },
      waits,
    };
  };

  it('没有在途部署时直接放行，不浪费一秒', async () => {
    const { deps, waits } = mkDeps([[run('a', 'running')]]);
    const out = await drainInFlightDeploys(deps);
    expect(out).toMatchObject({ drained: true, skipped: true, waitedMs: 0, remaining: [] });
    expect(waits).toHaveLength(0);
  });

  it('等到在途部署落地就立刻返回', async () => {
    const { deps } = mkDeps([
      [run('a', 'building', new Date(T0).toISOString())],
      [run('a', 'building', new Date(T0).toISOString())],
      [run('a', 'running')],
    ]);
    const out = await drainInFlightDeploys(deps);
    expect(out.drained).toBe(true);
    expect(out.skipped).toBe(false);
    expect(out.remaining).toEqual([]);
    expect(out.waitedMs).toBeGreaterThan(0);
  });

  it('超时后放弃并如实带出仍在途的 run——自更新往往正是去修那个卡住的 bug', async () => {
    const stuck = [run('stuck', 'building')];
    const { deps } = mkDeps([stuck], 3_000);
    const out = await drainInFlightDeploys(deps);
    expect(out.drained).toBe(false);
    expect(out.remaining).toEqual(['stuck']);
    expect(out.waitedMs).toBeGreaterThanOrEqual(3_000);
  });

  it('超时设为 0 = 关闭排空，行为回到旧版（立即重启）', async () => {
    const { deps, waits } = mkDeps([[run('a', 'building')]], 0);
    const out = await drainInFlightDeploys(deps);
    expect(out).toMatchObject({ drained: true, skipped: true });
    expect(waits).toHaveLength(0);
  });

  it('等待期间会回调进度，便于把「在等谁」写进事件日志', async () => {
    const seen: string[][] = [];
    const { deps } = mkDeps([
      [run('a', 'building')],
      [run('a', 'running')],
    ]);
    await drainInFlightDeploys({ ...deps, onWait: (p) => seen.push(p.map((r) => r.id)) });
    expect(seen[0]).toEqual(['a']);
  });
});
