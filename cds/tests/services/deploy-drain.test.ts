import { describe, it, expect, beforeEach } from 'vitest';
import {
  drainInFlightDeploys, isRunInFlight, isRunAlive, pendingRunsToDrain,
  beginSelfUpdateDrain, endSelfUpdateDrain, isSelfUpdateDraining, selfUpdateDrainBlockReason,
  DRAIN_STALE_HEARTBEAT_MS, resolveSelfUpdateDrainTimeoutMs, type DrainableRun,
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

  it('非终态记录都必须等待，不能按心跳猜测可中断', () => {
    const runs = [
      run('ok', 'running'),
      run('live', 'building', new Date(T0 - 5_000).toISOString()),
      run('zombie', 'building', new Date(T0 - 10 * 60_000).toISOString()),
    ];
    expect(pendingRunsToDrain(runs, T0).map((r) => r.id)).toEqual(['live', 'zombie']);
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

  it('零等待也必须拒绝打断在途部署', async () => {
    const { deps, waits } = mkDeps([[run('a', 'building')]], 0);
    const out = await drainInFlightDeploys(deps);
    expect(out).toMatchObject({ drained: false, skipped: false, remaining: ['a'] });
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

  it('静默部署从首判到每轮复核，心跳失效仍等原owner终态', async () => {
    const stale = run('waiter', 'building', new Date(T0 - 16 * 60_000).toISOString());
    const { deps, waits } = mkDeps([[stale], [stale], [{ ...stale, status: 'running' }]]);
    const observed: Array<{ ids: string[]; now: number }> = [];
    const out = await drainInFlightDeploys({ ...deps,
      onWait: pending => observed.push({ ids: pending.map(item => item.id), now: deps.now() }),
    });
    expect(out).toMatchObject({ drained: true, skipped: false, waitedMs: 2000 });
    expect(observed).toEqual([{ ids: ['waiter'], now: T0 }, { ids: ['waiter'], now: T0 + 1000 }]);
    expect(waits).toEqual([1000, 1000]);
    expect(stale.status).toBe('building');
  });

  it('持续未终态等待仍受原排空上限约束，资格未知不能生成重启许可', async () => {
    const stale = run('waiter', 'building', new Date(T0 - 16 * 60_000).toISOString());
    const { deps } = mkDeps([[stale]], 3000);
    expect(await drainInFlightDeploys(deps))
      .toMatchObject({ drained: false, skipped: false, waitedMs: 3000, remaining: ['waiter'] });
    expect(pendingRunsToDrain([stale], T0)).toEqual([stale]);
    const unknown = { ...stale, heartbeatAt: 'unknown' };
    expect(pendingRunsToDrain([unknown], T0)).toEqual([unknown]);
  });

  it('deployment终态不能复活，release运行中不能借部署终态放行', () => {
    const heartbeatAt = new Date(T0 - 16 * 60_000).toISOString();
    const terminals = [run('done', 'running', heartbeatAt), run('failed', 'failed', heartbeatAt),
      run('cancelled', 'cancelled', heartbeatAt)];
    const release = { ...run('release', 'running', heartbeatAt), kind: 'release' as const };
    expect(pendingRunsToDrain(terminals, T0)).toEqual([]);
    expect(pendingRunsToDrain([...terminals, release], T0)).toEqual([release]);
    expect(pendingRunsToDrain([{ ...release, status: 'success' }], T0)).toEqual([]);
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

describe('self-update wait limits', () => {
  it('defaults to five minutes; explicit zero means immediate cancellation if busy', () => {
    expect(resolveSelfUpdateDrainTimeoutMs({}, {})).toBe(300_000);
    expect(resolveSelfUpdateDrainTimeoutMs({ drainTimeoutMs: 0 }, {})).toBe(0);
    expect(resolveSelfUpdateDrainTimeoutMs({ drain: false }, {})).toBe(300_000);
  });
  it('uses valid request limits before environment limits', () => {
    expect(resolveSelfUpdateDrainTimeoutMs({ drainTimeoutMs: 50 }, { CDS_SELFUPDATE_DRAIN_TIMEOUT_MS: '10' })).toBe(50);
    expect(resolveSelfUpdateDrainTimeoutMs({}, { CDS_SELFUPDATE_DRAIN_TIMEOUT_MS: '0' })).toBe(0);
    expect(resolveSelfUpdateDrainTimeoutMs({ drainTimeoutMs: -1 }, { CDS_SELFUPDATE_DRAIN_TIMEOUT_MS: 'abc' })).toBe(300_000);
  });
  it('does not treat an old heartbeat as permission to interrupt a nonterminal run', () => {
    expect(pendingRunsToDrain([run('stale', 'verifying', new Date(T0 - 3_600_000).toISOString())], T0).map(r => r.id)).toEqual(['stale']);
  });
});
