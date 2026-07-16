import { describe, it, expect } from 'vitest';
import { evaluateBuildGateHealth, type BuildGateSnapshot } from '../../src/services/build-gate-health.js';

/**
 * 2026-07-16 构建队列堵死事故（active=3/queued=54/幽灵 building run 24h+）的
 * 回归门禁：健康判定纯函数覆盖四类退化 + 阈值边界 + 健康路径。
 * 消费方：GET /api/cluster/build-gate/health（定时回归任务探测目标）与
 * startBuildGateWatchdog（进程内 60s 采样告警）。
 */

const NOW = new Date('2026-07-16T12:00:00.000Z');

const minutesAgo = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();

const gate = (overrides: Partial<BuildGateSnapshot> = {}): BuildGateSnapshot => ({
  active: 1,
  queued: 0,
  max: 3,
  holders: [{ branchId: 'b1', profileId: 'api', acquiredAt: minutesAgo(5) }],
  waiters: [],
  ...overrides,
});

type RunLike = { id: string; status: string; branchId: string; heartbeatAt?: string; updatedAt?: string; startedAt: string };
const run = (overrides: Partial<RunLike> = {}): RunLike => ({
  id: 'dr_1',
  status: 'building',
  branchId: 'b1',
  startedAt: minutesAgo(10),
  heartbeatAt: minutesAgo(1),
  ...overrides,
});

describe('evaluateBuildGateHealth 构建队列健康判定', () => {
  it('健康状态：正常构建 + 新鲜心跳 → ok，无 reasons', () => {
    const result = evaluateBuildGateHealth(gate(), [run()], NOW);
    expect(result.ok).toBe(true);
    expect(result.reasons).toHaveLength(0);
    expect(result.summary).toMatchObject({ active: 1, queued: 0, max: 3, staleRunCount: 0 });
  });

  it('queue-backlog：排队达到阈值告 warn，双倍阈值升 error（事故值 54 必红）', () => {
    const warn = evaluateBuildGateHealth(gate({ queued: 15 }), [], NOW);
    expect(warn.ok).toBe(false);
    expect(warn.reasons[0]).toMatchObject({ kind: 'queue-backlog', severity: 'warn' });

    const incident = evaluateBuildGateHealth(gate({ queued: 54 }), [], NOW);
    expect(incident.ok).toBe(false);
    expect(incident.reasons[0]).toMatchObject({ kind: 'queue-backlog', severity: 'error' });

    const under = evaluateBuildGateHealth(gate({ queued: 14 }), [], NOW);
    expect(under.reasons.find((r) => r.kind === 'queue-backlog')).toBeUndefined();
  });

  it('stuck-holder：持槽超过 45 分钟判 error，44 分钟不判', () => {
    const stuck = evaluateBuildGateHealth(
      gate({ holders: [{ branchId: 'b1', profileId: 'api', runId: 'dr_x', acquiredAt: minutesAgo(46) }] }),
      [],
      NOW,
    );
    expect(stuck.ok).toBe(false);
    expect(stuck.reasons[0]).toMatchObject({ kind: 'stuck-holder', severity: 'error' });
    expect(stuck.summary.oldestHolderAgeMin).toBe(46);

    const fine = evaluateBuildGateHealth(
      gate({ holders: [{ branchId: 'b1', acquiredAt: minutesAgo(44) }] }),
      [],
      NOW,
    );
    expect(fine.reasons.find((r) => r.kind === 'stuck-holder')).toBeUndefined();
  });

  it('stale-runs：非终结 run 心跳停跳 30 分钟判 warn，终结 run 不参与', () => {
    const stale = evaluateBuildGateHealth(gate(), [
      run({ id: 'dr_ghost', heartbeatAt: minutesAgo(31) }),
      run({ id: 'dr_done', status: 'failed', heartbeatAt: minutesAgo(300) }),
      run({ id: 'dr_ok', status: 'running', heartbeatAt: minutesAgo(500) }),
    ], NOW);
    expect(stale.ok).toBe(false);
    const reason = stale.reasons.find((r) => r.kind === 'stale-runs');
    expect(reason).toMatchObject({ severity: 'warn' });
    expect(stale.summary.staleRunCount).toBe(1);

    const fresh = evaluateBuildGateHealth(gate(), [run({ heartbeatAt: minutesAgo(29) })], NOW);
    expect(fresh.reasons.find((r) => r.kind === 'stale-runs')).toBeUndefined();
  });

  it('invariant：active 超上限 / 有排队却零活跃 → error（闸门账目坏了）', () => {
    const over = evaluateBuildGateHealth(gate({ active: 4, max: 3 }), [], NOW);
    expect(over.reasons.find((r) => r.kind === 'invariant')).toMatchObject({ severity: 'error' });

    const stalled = evaluateBuildGateHealth(gate({ active: 0, queued: 3, holders: [] }), [], NOW);
    expect(stalled.reasons.find((r) => r.kind === 'invariant')).toMatchObject({ severity: 'error' });

    // active=0 且 queued=0 是正常空闲，不是账目问题
    const idle = evaluateBuildGateHealth(gate({ active: 0, queued: 0, holders: [] }), [], NOW);
    expect(idle.ok).toBe(true);
  });

  it('多退化并存时 reasons 全部列出（不吞并）', () => {
    const result = evaluateBuildGateHealth(
      gate({
        queued: 54,
        holders: [{ branchId: 'b1', acquiredAt: minutesAgo(60) }],
      }),
      [run({ heartbeatAt: minutesAgo(40) })],
      NOW,
    );
    expect(result.ok).toBe(false);
    const kinds = result.reasons.map((r) => r.kind).sort();
    expect(kinds).toEqual(['queue-backlog', 'stale-runs', 'stuck-holder']);
  });

  it('阈值可配：自定义阈值覆盖默认', () => {
    const result = evaluateBuildGateHealth(gate({ queued: 5 }), [], NOW, { queueBacklogThreshold: 5 });
    expect(result.reasons.find((r) => r.kind === 'queue-backlog')).toBeTruthy();
  });

  it('坏时间戳容错：acquiredAt/heartbeatAt 不可解析时跳过而非误判', () => {
    const result = evaluateBuildGateHealth(
      gate({ holders: [{ branchId: 'b1', acquiredAt: 'not-a-date' }] }),
      [run({ heartbeatAt: undefined, updatedAt: undefined, startedAt: 'garbage' })],
      NOW,
    );
    expect(result.reasons.find((r) => r.kind === 'stuck-holder')).toBeUndefined();
    expect(result.reasons.find((r) => r.kind === 'stale-runs')).toBeUndefined();
  });
});
