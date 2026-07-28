/**
 * 生产故障归因到发布（uptime 侧接线回归）。
 *
 * 事故值：状态页只会说「生产站点宕了」，答不出「是哪次发布引入的」——
 * 而这是排障时第一个要问的问题。归因必须发生在 incident **创建那一刻**：
 * 读时反推会随 run 被回收（pruneReleaseRuns）而漂移，同一条故障今天有归因
 * 明天变无归因。
 */

import { describe, it, expect } from 'vitest';
import type { ReleaseRun, ReleaseTarget } from '../../src/types.js';
import {
  UptimeMonitorService,
  type ProbeFn,
  type ReleaseLinkedIncident,
  type UptimeMonitorConfig,
} from '../../src/services/uptime-monitor.js';
import { MAX_SAMPLES_PER_TARGET } from '../../src/services/uptime-metrics.js';
import { releaseProbeTargetId } from '../../src/services/release-probe-target.js';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const MIN = 60_000;

function releaseTarget(): ReleaseTarget {
  return {
    id: 'tgt-prod',
    projectId: 'proj',
    name: '官网',
    type: 'ssh',
    createdAt: '2026-07-01T00:00:00.000Z',
    isEnabled: true,
    ssh: {
      host: '10.0.0.1',
      port: 22,
      user: 'deploy',
      privateKeyRef: 'host-prod',
      appPath: '/opt/app',
      deployCommand: './deploy.sh',
      healthcheckUrl: 'https://prod.example.test/health',
    },
  } as ReleaseTarget;
}

function releaseRun(overrides: Partial<ReleaseRun> & { releaseId: string }): ReleaseRun {
  return {
    projectId: 'proj',
    branchId: 'proj-main',
    commitSha: 'abcdef1',
    artifact: {} as ReleaseRun['artifact'],
    targetId: 'tgt-prod',
    planId: 'plan-1',
    status: 'success',
    startedAt: new Date(NOW - 20 * MIN).toISOString(),
    logs: [],
    seq: 0,
    ...overrides,
  } as ReleaseRun;
}

function testConfig(overrides: Partial<UptimeMonitorConfig> = {}): UptimeMonitorConfig {
  return {
    enabled: true,
    intervalMs: 60_000,
    timeoutMs: 5_000,
    failureThreshold: 3,
    recoveryThreshold: 1,
    maxSamples: MAX_SAMPLES_PER_TARGET,
    excludePatterns: [],
    scope: 'trunk',
    storePath: '', // 只在内存跑，测试不落盘
    ...overrides,
  };
}

/** 恒失败探测：连续 failureThreshold 次即判 down，开出一条 incident。 */
const alwaysDown: ProbeFn = async () => ({ up: false, ms: 0, err: 'connect ECONNREFUSED' });

function makeMonitor(getReleaseRuns?: (targetId: string) => ReleaseRun[]): UptimeMonitorService {
  return new UptimeMonitorService({
    state: {
      getAllBranches: () => [],
      getReleaseTargets: () => [releaseTarget()],
      ...(getReleaseRuns ? { getReleaseRuns } : {}),
    },
    config: testConfig(),
    probe: alwaysDown,
    now: () => NOW,
  });
}

async function runUntilDown(monitor: UptimeMonitorService): Promise<ReleaseLinkedIncident[]> {
  for (let i = 0; i < 3; i++) await monitor.runCycle();
  const record = monitor.getRecord(releaseProbeTargetId(releaseTarget()));
  expect(record?.status).toBe('down');
  return (record!.incidents as ReleaseLinkedIncident[]);
}

describe('生产故障归因到发布', () => {
  it('故障开出来时挂上最近一次发布的 releaseId 与间隔', async () => {
    const monitor = makeMonitor(() => [
      releaseRun({ releaseId: 'rel-1', finishedAt: new Date(NOW - 8 * MIN).toISOString() }),
    ]);
    const incidents = await runUntilDown(monitor);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].releaseId).toBe('rel-1');
    expect(incidents[0].releaseAgeMs).toBe(8 * MIN);
  });

  it('归因随 incident 一起出现在对外视图里', async () => {
    const monitor = makeMonitor(() => [
      releaseRun({ releaseId: 'rel-1', finishedAt: new Date(NOW - 2 * MIN).toISOString() }),
    ]);
    await runUntilDown(monitor);
    const view = monitor.getIncidents().find((row) => row.targetName.includes('官网'));
    expect(view?.releaseId).toBe('rel-1');
  });

  it('超出时间窗的发布不归因，故障本身照常记录', async () => {
    const monitor = makeMonitor(() => [
      releaseRun({ releaseId: 'rel-old', finishedAt: new Date(NOW - 3 * 24 * 3600 * 1000).toISOString() }),
    ]);
    const incidents = await runUntilDown(monitor);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].releaseId).toBeUndefined();
  });

  it('getReleaseRuns 没接线时退化成无归因，不抛也不漏掉故障', async () => {
    // 事故值：把可选接线写成必需，任何没接线的部署（含全部既有单测的 state 桩）
    // 都会在第一次故障时抛异常，把整轮探测带塌 —— 监控本身比归因重要得多。
    const monitor = makeMonitor();
    const incidents = await runUntilDown(monitor);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].releaseId).toBeUndefined();
  });

  it('读发布记录抛异常时保留无归因故障，不把探测轮次带塌', async () => {
    const monitor = makeMonitor(() => { throw new Error('state 挂了'); });
    const incidents = await runUntilDown(monitor);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].releaseId).toBeUndefined();
  });
});
