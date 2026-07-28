/**
 * 自更新排空覆盖生产发布（阶段一 · 止血）。
 *
 * 部署侧那次事故的代价是「PR check 变红 + 人工重触发」；发布侧同一个竞态的代价
 * 大一个量级：自更新重启杀掉在途发布的执行体后，ReleaseRun 永远停在 running，
 * 在途守卫会因此拒绝该目标的一切新发布——这个发布目标从此发不出去。所以排空
 * 必须把发布 run 一并等进来。
 *
 * 这里把三件事钉成回归：
 *   1. 发布状态逐个取值的终态判定（穷尽式表的意义就在这里）；
 *   2. `running` 在两条生命周期里语义相反，不能被同一张字符串表吞掉；
 *   3. 排空的等待源必须同时包含部署与发布，少一路就是对那条生命周期不设防。
 */
import { describe, it, expect } from 'vitest';
import {
  isRunInFlight,
  isRunAlive,
  pendingRunsToDrain,
  drainInFlightDeploys,
  toDrainableReleaseRuns,
  collectDrainableRuns,
  DRAIN_STALE_HEARTBEAT_MS,
  type DrainableRun,
} from '../../src/services/deploy-drain.js';

const T0 = Date.parse('2026-07-28T10:00:00Z');
const rel = (id: string, status: string, heartbeatAt?: string): DrainableRun =>
  ({ id, status, kind: 'release', heartbeatAt });

/**
 * 发布状态的**全量**取值 → 期望终态。新增状态时这张表和源码里的 Record 必须
 * 同时表态，漏一个就会在这里红。
 */
const RELEASE_STATUS_EXPECTATION: Array<[status: string, terminal: boolean]> = [
  ['queued', false],
  ['prechecking', false],
  ['running', false],
  ['healthchecking', false],
  ['rollback_running', false],
  ['success', true],
  ['failed', true],
  ['rollback_success', true],
  ['rollback_failed', true],
  ['cancelled', true],
];

describe('发布 run 的在途判定', () => {
  for (const [status, terminal] of RELEASE_STATUS_EXPECTATION) {
    it(`${status} → ${terminal ? '终态，不等' : '在途，必须等'}`, () => {
      expect(isRunInFlight(rel('rel_1', status))).toBe(!terminal);
    });
  }

  it('running 在两条生命周期里语义相反：部署=成功终态，发布=正在执行', () => {
    // 这一条是本次改动的核心风险点：单张按字符串取值的表会把在途发布判成终态，
    // 排空又变回半开的门。
    expect(isRunInFlight({ id: 'dep_1', status: 'running' })).toBe(false);
    expect(isRunInFlight({ id: 'dep_1', status: 'running', kind: 'deployment' })).toBe(false);
    expect(isRunInFlight(rel('rel_1', 'running'))).toBe(true);
  });

  it('success / rollback_success 是发布侧终态，但在部署侧不认识 → 按在途处理', () => {
    expect(isRunInFlight(rel('rel_1', 'success'))).toBe(false);
    expect(isRunInFlight({ id: 'dep_1', status: 'success' })).toBe(true);
  });

  it('不带 kind 的历史调用方仍按部署语义解释（向后兼容）', () => {
    for (const status of ['pending', 'queued', 'preparing', 'building', 'starting', 'verifying']) {
      expect(isRunInFlight({ id: 'dep_1', status }), status).toBe(true);
    }
    expect(isRunInFlight({ id: 'dep_1', status: 'cancelled' })).toBe(false);
  });

  it('发布侧不认识的状态同样按在途处理（漏登记的代价落在多等一会儿这侧）', () => {
    expect(isRunInFlight(rel('rel_1', 'some-future-status'))).toBe(true);
    expect(isRunInFlight(rel('rel_1', ''))).toBe(false);
  });

  it('大小写不敏感（状态字段来自 DB，别指望恒为小写）', () => {
    expect(isRunInFlight(rel('rel_1', 'RUNNING'))).toBe(true);
    expect(isRunInFlight(rel('rel_1', 'Success'))).toBe(false);
  });

  it('心跳过期的僵尸发布不再等——否则它能把自更新拖满整个超时窗口', () => {
    const stale = new Date(T0 - DRAIN_STALE_HEARTBEAT_MS - 1_000).toISOString();
    const fresh = new Date(T0 - 10_000).toISOString();
    expect(isRunAlive(rel('rel_1', 'running', stale), T0)).toBe(false);
    expect(isRunAlive(rel('rel_1', 'running', fresh), T0)).toBe(true);
  });
});

describe('排空等待源：部署 + 发布', () => {
  it('toDrainableReleaseRuns 用 releaseId 当 id 并打上 kind', () => {
    const mapped = toDrainableReleaseRuns([
      { releaseId: 'rel_1', status: 'running', branchId: 'b1', startedAt: '2026-07-28T09:59:00Z' },
    ]);
    expect(mapped).toEqual([
      {
        id: 'rel_1',
        status: 'running',
        kind: 'release',
        branchId: 'b1',
        heartbeatAt: undefined,
        startedAt: '2026-07-28T09:59:00Z',
      },
    ]);
  });

  it('collectDrainableRuns 两路都收，且不改变部署侧既有语义', () => {
    const merged = collectDrainableRuns({
      deploymentRuns: [{ id: 'dep_ok', status: 'running' }, { id: 'dep_busy', status: 'building' }],
      releaseRuns: [{ releaseId: 'rel_busy', status: 'running' }, { releaseId: 'rel_done', status: 'success' }],
    });
    expect(merged.map((r) => r.id)).toEqual(['dep_ok', 'dep_busy', 'rel_busy', 'rel_done']);
    expect(pendingRunsToDrain(merged, T0).map((r) => r.id)).toEqual(['dep_busy', 'rel_busy']);
  });

  it('只传一路时另一路按空处理（不炸）', () => {
    expect(collectDrainableRuns({}).length).toBe(0);
    expect(collectDrainableRuns({ releaseRuns: [{ releaseId: 'rel_1', status: 'queued' }] })).toHaveLength(1);
  });

  it('在途发布会真的把重启拦住，直到它落地', async () => {
    let now = T0;
    let frame = 0;
    const frames: DrainableRun[][] = [
      collectDrainableRuns({ releaseRuns: [{ releaseId: 'rel_1', status: 'running' }] }),
      collectDrainableRuns({ releaseRuns: [{ releaseId: 'rel_1', status: 'healthchecking' }] }),
      collectDrainableRuns({ releaseRuns: [{ releaseId: 'rel_1', status: 'success' }] }),
    ];
    const out = await drainInFlightDeploys({
      listRuns: () => frames[Math.min(frame, frames.length - 1)],
      now: () => now,
      sleep: async (ms) => { now += ms; frame += 1; },
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
    });
    expect(out.drained).toBe(true);
    expect(out.skipped).toBe(false);
    expect(out.waitedMs).toBeGreaterThan(0);
  });

  it('发布卡住时超时放弃并如实带出 releaseId（自更新不许被永久堵死）', async () => {
    const stuck = collectDrainableRuns({ releaseRuns: [{ releaseId: 'rel_stuck', status: 'running' }] });
    let now = T0;
    const out = await drainInFlightDeploys({
      listRuns: () => stuck,
      now: () => now,
      sleep: async (ms) => { now += ms; },
      timeoutMs: 3_000,
      pollIntervalMs: 1_000,
    });
    expect(out.drained).toBe(false);
    expect(out.remaining).toEqual(['rel_stuck']);
  });
});
