import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import {
  selectReleaseRunsToPrune,
  KEEP_SUCCESSFUL_RELEASE_RUNS,
  MAX_RELEASE_RUNS_PER_TARGET,
  RELEASE_RUN_RETENTION_MS,
} from '../../src/services/release-retention.js';
import type { ReleaseRun, ReleaseRunStatus } from '../../src/types.js';

/**
 * 发布 run 保留策略回归（阶段三记账）。
 *
 * 事故值一（无界）：`state.releaseRuns` 一条保留策略都没有 —— `addReleaseRun` 不像
 * 分支侧 `addDeploymentRun` 那样调 prune，内存里永远全量。造 200 条 run 就留 200 条，
 * 每条还挂着整轮 SSH 日志，最终把 global 文档撑到写不进去。
 *
 * 事故值二（裸淘汰会砍掉回滚能力）：照抄分支侧 pruneDeploymentRuns 的裸淘汰
 * （只看状态是不是终态）会把发布中心版本下拉里的成功 run、以及回滚链上被
 * `previousReleaseId` 指向的那一条删掉 —— UI 上还看得到版本，点下去 `startRollback`
 * 直接抛「没有可回滚的上一版本」。所以保留策略必须抄 pruneDeploymentVersions 的
 * protectedIds 模式，本套件正是守这一点。
 */

const DAY_MS = 24 * 3600 * 1000;

function makeRun(overrides: Partial<ReleaseRun> & { releaseId: string; status: ReleaseRunStatus; startedAt: string }): ReleaseRun {
  return {
    projectId: 'p1',
    branchId: 'b1',
    commitSha: 'a'.repeat(40),
    artifact: { type: 'branch-preview', commitSha: 'a'.repeat(40), branchId: 'b1', branchName: 'main' },
    targetId: 'target-prod',
    planId: 'p1:ssh-script',
    logs: [],
    seq: 0,
    ...overrides,
  };
}

function isoAt(index: number): string {
  return new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 3600_000).toISOString();
}

describe('selectReleaseRunsToPrune 保护集', () => {
  const nowMs = Date.parse('2026-07-28T00:00:00.000Z');

  function buildHistory(total: number): ReleaseRun[] {
    const runs: ReleaseRun[] = [];
    for (let i = 0; i < total; i += 1) {
      const status: ReleaseRunStatus = i % 3 === 0 ? 'success' : 'failed';
      runs.push(makeRun({
        releaseId: `rel_${String(i).padStart(3, '0')}`,
        status,
        startedAt: isoAt(i),
        previousReleaseId: i > 0 ? `rel_${String(i - 1).padStart(3, '0')}` : undefined,
      }));
    }
    return runs;
  }

  it('200 条 run 收敛到上限，但最近的成功版本一条不少', () => {
    const runs = buildHistory(200);
    const doomed = new Set(selectReleaseRunsToPrune({ runs, nowMs }));

    // 事故值：修复前 doomed 为空（压根没有保留策略），200 条全留。
    expect(runs.length - doomed.size).toBeLessThanOrEqual(MAX_RELEASE_RUNS_PER_TARGET);

    const survivingSuccess = runs
      .filter((run) => run.status === 'success' && !doomed.has(run.releaseId))
      .length;
    expect(survivingSuccess).toBeGreaterThanOrEqual(KEEP_SUCCESSFUL_RELEASE_RUNS);
  });

  it('在途 run 绝不淘汰，哪怕它是最老的那条', () => {
    const runs = buildHistory(200);
    runs[0] = makeRun({ releaseId: 'rel_000', status: 'running', startedAt: isoAt(0) });
    const doomed = new Set(selectReleaseRunsToPrune({ runs, nowMs }));
    expect(doomed.has('rel_000')).toBe(false);
  });

  it('被保留 run 指向的回滚目标一并留住，回滚链不断', () => {
    const runs = buildHistory(200);
    const byId = new Map(runs.map((run) => [run.releaseId, run]));
    const doomed = new Set(selectReleaseRunsToPrune({ runs, nowMs }));

    // 保护集 = 最新一条 + 最近 20 条成功；它们的上一版本必须一并留住，
    // 否则 UI 上还看得到版本、点回滚却抛「没有可回滚的上一版本」。
    const newestFirst = runs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const mustKeep = [
      newestFirst[0],
      ...newestFirst.filter((run) => run.status === 'success').slice(0, KEEP_SUCCESSFUL_RELEASE_RUNS),
    ];
    for (const run of mustKeep) {
      expect(doomed.has(run.releaseId), `${run.releaseId} 属于保护集却被淘汰`).toBe(false);
      const previous = run.previousReleaseId;
      if (!previous || !byId.has(previous)) continue;
      expect(doomed.has(previous), `${run.releaseId} 的回滚目标 ${previous} 被淘汰，回滚链断了`).toBe(false);
    }
  });

  it('未超条数上限时，只淘汰超出时间窗且不在保护集的 run', () => {
    const ancient = isoAt(0);
    const runs = [
      makeRun({ releaseId: 'rel_ancient_failed', status: 'failed', startedAt: ancient }),
      makeRun({ releaseId: 'rel_ancient_success', status: 'success', startedAt: ancient }),
      makeRun({ releaseId: 'rel_recent', status: 'success', startedAt: '2026-07-27T00:00:00.000Z' }),
    ];
    const farFuture = Date.parse(ancient) + RELEASE_RUN_RETENTION_MS + DAY_MS;
    const doomed = selectReleaseRunsToPrune({ runs, nowMs: farFuture });

    expect(doomed).toContain('rel_ancient_failed');
    // 成功 run 在最近 20 条成功之内，超时也不许删 —— 它还挂在发布中心的版本下拉里。
    expect(doomed).not.toContain('rel_ancient_success');
    expect(doomed).not.toContain('rel_recent');
  });
});

describe('StateService 发布 run 保留策略', () => {
  let stateDir: string;
  let stateService: StateService;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-retention-'));
    stateService = new StateService(path.join(stateDir, 'state.json'));
    stateService.load();
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as never);
  });

  afterEach(async () => {
    await stateService.flush();
    if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('连续入库 200 条：总量收敛，在途 / 最近成功 / 回滚链全都还在', () => {
    stateService.addReleaseRun(makeRun({
      releaseId: 'rel_inflight',
      status: 'running',
      startedAt: isoAt(0),
    }));
    for (let i = 1; i < 200; i += 1) {
      stateService.addReleaseRun(makeRun({
        releaseId: `rel_${String(i).padStart(3, '0')}`,
        status: i % 3 === 0 ? 'success' : 'failed',
        startedAt: isoAt(i),
        previousReleaseId: `rel_${String(i - 1).padStart(3, '0')}`,
      }));
    }

    const remaining = stateService.getReleaseRuns({ targetId: 'target-prod' });
    // 事故值：修复前是 200（零保留策略）。
    expect(remaining.length).toBeLessThanOrEqual(MAX_RELEASE_RUNS_PER_TARGET);
    expect(stateService.getReleaseRun('rel_inflight')).toBeTruthy();

    const successes = remaining.filter((run) => run.status === 'success');
    expect(successes.length).toBeGreaterThanOrEqual(KEEP_SUCCESSFUL_RELEASE_RUNS);

    // 回滚默认目标必须还能解析出来，否则「保留了版本却回滚不了」。
    expect(stateService.getLatestSuccessfulReleaseRun('target-prod')).toBeTruthy();
    const newest = remaining[0];
    expect(stateService.getReleaseRun(newest.previousReleaseId!)).toBeTruthy();
  });

  it('保留策略按目标隔离，不会误伤别的发布目标', () => {
    for (let i = 0; i < 150; i += 1) {
      stateService.addReleaseRun(makeRun({
        releaseId: `rel_a_${String(i).padStart(3, '0')}`,
        status: 'failed',
        startedAt: isoAt(i),
      }));
    }
    stateService.addReleaseRun(makeRun({
      releaseId: 'rel_b_only',
      status: 'success',
      startedAt: isoAt(1),
      targetId: 'target-staging',
    }));

    expect(stateService.getReleaseRun('rel_b_only')).toBeTruthy();
    expect(stateService.getReleaseRuns({ targetId: 'target-prod' }).length)
      .toBeLessThanOrEqual(MAX_RELEASE_RUNS_PER_TARGET);
  });
});
