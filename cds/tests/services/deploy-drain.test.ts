import { describe, it, expect, beforeEach } from 'vitest';
import {
  drainInFlightDeploys, isRunInFlight, isRunAlive, pendingRunsToDrain,
  beginSelfUpdateDrain, endSelfUpdateDrain, isSelfUpdateDraining, selfUpdateDrainBlockReason,
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

  it('全部非终态都算在途——preparing / verifying 曾被漏掉（第三十六轮 P1）', () => {
    // 初版按字面量枚举在途状态，漏了 preparing 与 verifying：恰好停在这两步的
    // 部署照样被重启杀掉，排空等于半开的门。现在按「终态表取反」推导。
    for (const s of ['pending', 'queued', 'preparing', 'building', 'starting', 'verifying']) {
      expect(isRunInFlight(run('a', s)), s).toBe(true);
    }
  });

  it('不认识的状态按在途处理（漏登记的代价必须落在多等一会儿这一侧）', () => {
    expect(isRunInFlight(run('a', 'some-future-status'))).toBe(true);
    expect(isRunInFlight(run('a', ''))).toBe(false); // 连状态都没有的记录没什么可等
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

describe('排空窗口闸门（第三十六轮 P1）', () => {
  beforeEach(() => { endSelfUpdateDrain(); });

  it('未排空时不拦任何部署', () => {
    expect(isSelfUpdateDraining(T0)).toBe(false);
    expect(selfUpdateDrainBlockReason(T0)).toBeNull();
  });

  it('排空一开始就关闸——否则最后一次轮询之后到达的部署照样被重启腰斩', () => {
    beginSelfUpdateDrain(T0, 60_000);
    expect(isSelfUpdateDraining(T0 + 1_000)).toBe(true);
    const reason = selfUpdateDrainBlockReason(T0 + 1_000);
    expect(reason).toContain('自更新');
    expect(reason).toContain('重试');
  });

  it('闸门自动过期（fail-open）：重启万一没发生，也绝不把部署永久锁死', () => {
    beginSelfUpdateDrain(T0, 60_000);
    expect(isSelfUpdateDraining(T0 + 59_000)).toBe(true);
    expect(isSelfUpdateDraining(T0 + 60_000)).toBe(false);
    expect(selfUpdateDrainBlockReason(T0 + 60_000)).toBeNull();
  });

  it('放弃重启时可显式开闸', () => {
    beginSelfUpdateDrain(T0, 60_000);
    endSelfUpdateDrain();
    expect(isSelfUpdateDraining(T0 + 1_000)).toBe(false);
  });
});

describe('排空超时的环境变量解析（第三十七轮 P2）', () => {
  // 判定与 routes/branches.ts 的 drainDeploysBeforeSelfUpdateRestart 同源：
  // 文档明写「设 0 关闭」，而 parseInt('0') || 默认值 会把 0 吞掉换成 5 分钟。
  const resolve = (raw: string | undefined): number => {
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 5 * 60_000;
  };

  it('显式 0 就是 0（关闭排空），不被默认值吞掉', () => {
    expect(resolve('0')).toBe(0);
  });

  it('未设置 / 非数字才落默认值', () => {
    expect(resolve(undefined)).toBe(5 * 60_000);
    expect(resolve('')).toBe(5 * 60_000);
    expect(resolve('abc')).toBe(5 * 60_000);
  });

  it('负值按 0 处理，正常值原样生效', () => {
    expect(resolve('-1')).toBe(0);
    expect(resolve('90000')).toBe(90_000);
  });
});
