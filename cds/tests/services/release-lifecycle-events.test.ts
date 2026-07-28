import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  cdsEventsBus,
  isAlertCdsEvent,
  type CdsEventEnvelope,
  type CdsEventType,
} from '../../src/services/cds-events-bus.js';
import { releaseEvents, releaseEventTypeForStatus } from '../../src/services/release-events.js';
import type { DeploymentFailure, ReleaseRun, ReleaseRunStatus } from '../../src/types.js';

/**
 * 发布生命周期事件上 cds-events-bus。
 *
 * 事故值：发布事件此前只跑在 release-events 这条私有 EventEmitter 上，只有「正开着
 * 发布中心那一屏」的人看得见。关掉页面之后一次生产发布失败**没有任何外发**——不进
 * Activity Monitor、不进系统日志、没有告警。用户第二天才从别的渠道发现线上是坏的。
 */

const ALL_STATUSES: ReleaseRunStatus[] = [
  'queued',
  'running',
  'healthchecking',
  'success',
  'failed',
  'rollback_running',
  'rollback_success',
  'rollback_failed',
];

function makeRun(releaseId: string, status: ReleaseRunStatus, extra: Partial<ReleaseRun> = {}): ReleaseRun {
  const now = '2026-07-28T00:00:00.000Z';
  return {
    releaseId,
    projectId: 'proj-a',
    branchId: 'branch-a',
    commitSha: 'abc1234',
    artifact: {
      type: 'branch-preview',
      commitSha: 'abc1234',
      branchId: 'branch-a',
      branchName: 'main',
      previewUrl: 'https://preview.example.test',
    },
    targetId: 'target-a',
    planId: 'proj-a:ssh-script',
    status,
    startedAt: now,
    operator: 'tester',
    logs: [],
    seq: 0,
    ...extra,
  } as ReleaseRun;
}

describe('发布生命周期事件上 cds-events-bus', () => {
  let captured: CdsEventEnvelope[];
  let unsubscribe: () => void;

  beforeEach(() => {
    releaseEvents.resetLifecycleDedupeForTest();
    captured = [];
    unsubscribe = cdsEventsBus.subscribe((envelope) => {
      if (envelope.type.startsWith('release.')) captured.push(envelope);
    });
  });

  afterEach(() => {
    unsubscribe();
    releaseEvents.resetLifecycleDedupeForTest();
  });

  function emitStatus(run: ReleaseRun): void {
    releaseEvents.emitEvent({ type: 'release.status', payload: { releaseId: run.releaseId, run } });
  }

  function typesOf(): CdsEventType[] {
    return captured.map((envelope) => envelope.type);
  }

  it('正向发布走完 started → succeeded，中间态不外发', () => {
    emitStatus(makeRun('rel-1', 'queued'));
    emitStatus(makeRun('rel-1', 'running'));
    emitStatus(makeRun('rel-1', 'healthchecking'));
    emitStatus(makeRun('rel-1', 'success', { finishedAt: '2026-07-28T00:05:00.000Z' }));

    expect(typesOf()).toEqual(['release.started', 'release.succeeded']);
  });

  it('步骤推进复用 release.status，重复的同一状态只外发一次开始事件', () => {
    // 事故值：不去重的话，一次 5 步的发布跑到第 3 步就已经外发了 3 条「发布开始」——
    // patchProgress 刻意复用 release.status 事件推进步骤条，状态原地不动也会连发。
    emitStatus(makeRun('rel-2', 'running'));
    emitStatus(makeRun('rel-2', 'running'));
    emitStatus(makeRun('rel-2', 'running'));

    expect(typesOf()).toEqual(['release.started']);
  });

  it('失败事件带结构化失败事实，够告警分发直接用', () => {
    const failure: DeploymentFailure = {
      code: 'release.ssh_unreachable',
      owner: 'config',
      retryable: true,
      summary: 'SSH 连接被拒绝',
      evidenceRefs: ['rel-3'],
      suggestedAction: '检查目标主机是否可达',
    };
    emitStatus(makeRun('rel-3', 'running'));
    emitStatus(makeRun('rel-3', 'failed', { errorMessage: 'SSH 连接被拒绝', failure }));

    const failed = captured.find((envelope) => envelope.type === 'release.failed');
    expect(failed).toBeDefined();
    expect(failed!.data).toMatchObject({
      releaseId: 'rel-3',
      status: 'failed',
      errorMessage: 'SSH 连接被拒绝',
      failure: { code: 'release.ssh_unreachable', owner: 'config', retryable: true },
    });
  });

  it('回滚是独立 run：rollback_running 算开始，rollback_success 才是回滚事件', () => {
    emitStatus(makeRun('rel-4-rb', 'rollback_running', { rollbackOf: 'rel-4' }));
    emitStatus(makeRun('rel-4-rb', 'rollback_success', { rollbackOf: 'rel-4' }));

    expect(typesOf()).toEqual(['release.started', 'release.rolled-back']);
    expect(captured[1].data).toMatchObject({ releaseId: 'rel-4-rb', rollbackOf: 'rel-4' });
  });

  it('回滚失败与正向失败归同一个 failed 事件，告警侧不必分两套', () => {
    emitStatus(makeRun('rel-5', 'rollback_running'));
    emitStatus(makeRun('rel-5', 'rollback_failed', { errorMessage: '回滚脚本非零退出' }));

    expect(typesOf()).toEqual(['release.started', 'release.failed']);
  });

  it('载荷必须带 projectId，否则项目级 key 在 /api/cds-events 一条都收不到', () => {
    // 事故形状：cds-events 的 envelopeAllowed 对 project-scoped key 只放行
    // data.projectId 命中的事件。漏掉这个字段不会报错，只会静默失效。
    emitStatus(makeRun('rel-6', 'running'));

    expect(captured[0].data).toMatchObject({
      projectId: 'proj-a',
      targetId: 'target-a',
      branchId: 'branch-a',
      commitSha: 'abc1234',
    });
  });

  it('每个 ReleaseRunStatus 都在映射表里有明确答案，没有状态被静默吞掉', () => {
    const mapped = ALL_STATUSES.map((status) => [status, releaseEventTypeForStatus(status)] as const);
    for (const [status, type] of mapped) {
      // null 只允许出现在中间态；其余状态必须有事件，否则就是「发布失败没人知道」。
      if (status === 'healthchecking') expect(type).toBeNull();
      else expect(type, status).not.toBeNull();
    }
  });
});

describe('告警级事件白名单（与存活监控共用的那一条通道）', () => {
  it('发布失败与生产回退跟既有存活类告警同级', () => {
    // 这条断言是「不要给发布单造一条告警通道」的锚：release.failed 与
    // preview.canary.alert 必须由同一个判定源回答，将来接分发器时只接一次。
    expect(isAlertCdsEvent('release.failed')).toBe(true);
    expect(isAlertCdsEvent('release.rolled-back')).toBe(true);
    expect(isAlertCdsEvent('preview.canary.alert')).toBe(true);
    expect(isAlertCdsEvent('infra.flap.circuit-breaker')).toBe(true);
  });

  it('过程类发布事件不叫醒人', () => {
    // 每次发布都告警等于没有告警：人会先学会忽略，再忽略掉真正的失败。
    expect(isAlertCdsEvent('release.started')).toBe(false);
    expect(isAlertCdsEvent('release.succeeded')).toBe(false);
    expect(isAlertCdsEvent('heartbeat')).toBe(false);
  });
});
