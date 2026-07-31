/**
 * 定时发布（scheduled-job 的 release 动作）行为套件。
 *
 * 这条链路的危险不在「跑不起来」，而在四种**不会报错**的静默错误：
 *   1. 动作在持久化往返中被白名单静默过滤掉，任务变成零动作（见 persistence 用例）；
 *   2. 「点一下测试」变成往生产真发一次版（见 check-target 用例）；
 *   3. promote 在分支已前进时发出一个从未在源环境验证过的版本（见 expectedCommitSha 用例）；
 *   4. 目标忙 / 版本没变被记成 failed，把连续失败计数推向自动停用（见 skip 用例）。
 * 每条都配了反向断言：把判据改掉用例必须变红，否则它是空跑的绿灯。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import {
  RELEASE_JOB_FAILURE_DISABLE_THRESHOLD,
  ScheduledJobService,
  scheduledReleaseOperator,
  type ScheduledJobReleasePort,
} from '../../src/services/scheduled-job-service.js';
import type { ReleasePreflightResult, ReleaseStartInput, ReleaseTargetBusyState } from '../../src/services/release-service.js';
import type { CdsEventType } from '../../src/services/cds-events-bus.js';
import type { ReleaseRun, ReleaseRunStatus, ScheduledJob, ScheduledJobTarget } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

interface ReleaseStub extends ScheduledJobReleasePort {
  calls: {
    preflight: ReleaseStartInput[];
    startRelease: ReleaseStartInput[];
    startRollback: Array<{ releaseId: string; operator?: string }>;
    cancelRelease: string[];
  };
  busy: ReleaseTargetBusyState;
  preflightResult: ReleasePreflightResult;
  startReleaseError?: Error;
  /** 每次 getRun 返回的状态序列；用尽后停在最后一个。 */
  runStatuses: ReleaseRunStatus[];
  runOverrides: Partial<ReleaseRun>;
  startRollbackFailures: number;
}

function makeReleaseStub(): ReleaseStub {
  const stub: ReleaseStub = {
    calls: { preflight: [], startRelease: [], startRollback: [], cancelRelease: [] },
    busy: { busy: false },
    preflightResult: { ok: true, checks: [{ id: 'branch', label: '分支部署成功', status: 'pass', blocking: false }] },
    runStatuses: ['success'],
    runOverrides: {},
    startRollbackFailures: 0,
    isTargetBusy: () => stub.busy,
    preflight: async (input) => { stub.calls.preflight.push(input); return stub.preflightResult; },
    startRelease: async (input) => {
      stub.calls.startRelease.push(input);
      if (stub.startReleaseError) throw stub.startReleaseError;
      return currentRun(stub);
    },
    startRollback: async (releaseId, operator) => {
      stub.calls.startRollback.push({ releaseId, operator });
      if (stub.startRollbackFailures > 0) {
        stub.startRollbackFailures -= 1;
        throw new Error('该发布目标上一次发布（rel_x）已停止但执行体尚未退出，请稍候再发起回滚');
      }
      return { ...currentRun(stub), releaseId: 'rel_rollback' };
    },
    getRun: () => {
      if (stub.runStatuses.length > 1) stub.runStatuses.shift();
      return currentRun(stub);
    },
  };
  return stub;
}

function currentRun(stub: ReleaseStub): ReleaseRun {
  return {
    releaseId: 'rel_test',
    projectId: 'demo',
    branchId: 'b1',
    commitSha: COMMIT_A,
    artifact: { type: 'branch-preview', commitSha: COMMIT_A, branchId: 'b1', branchName: 'main', previewUrl: 'https://preview.test' },
    targetId: 'target-prod',
    planId: 'demo:ssh-script',
    status: stub.runStatuses[0],
    startedAt: '2026-07-29T00:00:00.000Z',
    logs: [],
    seq: 0,
    ...stub.runOverrides,
  };
}

describe('定时发布 · release 动作', () => {
  let tmpDir: string;
  let stateService: StateService;
  let release: ReleaseStub;
  let events: Array<{ type: CdsEventType; data: any }>;
  let service: ScheduledJobService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sched-release-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    stateService.addProject({ id: 'demo', slug: 'demo', name: 'Demo', kind: 'git', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as never);
    stateService.addBranch({
      id: 'b1', projectId: 'demo', branch: 'main', worktreePath: '/tmp/b1', services: {},
      status: 'running', pinnedCommit: COMMIT_A, createdAt: '2026-07-28T00:00:00.000Z',
    } as never);
    stateService.upsertReleaseTarget({
      id: 'target-prod', projectId: 'demo', name: '生产站点', type: 'ssh',
      createdAt: '2026-07-28T00:00:00.000Z', isEnabled: true,
      ssh: { host: '127.0.0.1', port: 22, user: 'deploy', privateKeyRef: 'h1', appPath: '/opt/app', deployCommand: './deploy.sh', healthcheckUrl: 'https://prod.test' },
    } as never);
    stateService.upsertReleaseTarget({
      id: 'target-staging', projectId: 'demo', name: '预发环境', type: 'ssh',
      createdAt: '2026-07-28T00:00:00.000Z', isEnabled: true,
      ssh: { host: '127.0.0.1', port: 22, user: 'deploy', privateKeyRef: 'h1', appPath: '/opt/app', deployCommand: './deploy.sh', healthcheckUrl: 'https://staging.test' },
    } as never);

    release = makeReleaseStub();
    events = [];
    service = new ScheduledJobService({
      stateService,
      shell: new MockShellExecutor(),
      config: { masterPort: 9900, repoRoot: tmpDir },
      release,
      publishEvent: (type, data) => { events.push({ type, data: data as any }); },
      releasePollIntervalMs: 1,
      rollbackRetryIntervalMs: 1,
      sleep: async () => { /* 测试里不真睡 */ },
    });
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function seedSuccessfulRun(targetId: string, commitSha: string, releaseId: string): ReleaseRun {
    return stateService.addReleaseRun({
      releaseId,
      projectId: 'demo',
      branchId: 'b1',
      commitSha,
      artifact: { type: 'branch-preview', commitSha, branchId: 'b1', branchName: 'main', previewUrl: 'https://preview.test' },
      targetId,
      planId: 'demo:ssh-script',
      status: 'success',
      startedAt: new Date(Date.parse('2026-07-29T00:00:00.000Z') + releaseId.length * 1000).toISOString(),
      logs: [],
      seq: 0,
    });
  }

  function makeJob(target: ScheduledJobTarget, overrides: Partial<ScheduledJob> = {}): ScheduledJob {
    const job = service.normalizeJob({
      id: 'job_release',
      projectId: 'demo',
      name: '每日发布',
      enabled: true,
      schedule: { type: 'daily', timeOfDay: '02:00', timezone: 'Asia/Shanghai' },
      actions: [{ ...target, id: 'action_1', name: '发布到生产' }],
      timeoutSeconds: 3600,
      retryCount: 0,
      concurrencyPolicy: 'skip',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });
    stateService.upsertScheduledJob(job);
    return job;
  }

  const branchTarget = (extra: Partial<Extract<ScheduledJobTarget, { type: 'release' }>> = {}): ScheduledJobTarget => ({
    type: 'release',
    targetId: 'target-prod',
    source: { kind: 'branch', branchId: 'b1' },
    ...extra,
  });

  describe('正常发布', () => {
    it('发起发布并等到终态，run 回写 releaseId 与发布状态', async () => {
      seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
      makeJob(branchTarget());
      const run = await service.runJob('job_release', 'manual');

      expect(release.calls.startRelease).toHaveLength(1);
      expect(release.calls.startRelease[0]).toMatchObject({ branchId: 'b1', targetId: 'target-prod' });
      // 分支来源刻意不钳制版本（语义就是「发这个分支的最新版」）。
      expect(release.calls.startRelease[0].expectedCommitSha).toBeUndefined();
      expect(release.calls.startRelease[0].operator).toBe(scheduledReleaseOperator('job_release'));
      expect(run.status).toBe('success');
      expect(run.releaseId).toBe('rel_test');
      expect(run.releaseStatus).toBe('success');
    });

    it('startRelease 抛错时任务失败并保留原文', async () => {
      seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
      release.startReleaseError = new Error('发布前检查未通过: 上线地址可访问');
      makeJob(branchTarget());
      const run = await service.runJob('job_release', 'manual');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('上线地址可访问');
    });

    it('发布终态为 failed 时任务失败', async () => {
      seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
      release.runStatuses = ['failed'];
      release.runOverrides = { errorMessage: '门禁未通过：gateway_route_self_test 401' };
      makeJob(branchTarget());
      const run = await service.runJob('job_release', 'manual');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('gateway_route_self_test');
      expect(run.releaseStatus).toBe('failed');
    });
  });

  describe('跳过语义（skipped，不是 failed）', () => {
    it('目标忙时不发布，记 skipped 并写明原因', async () => {
      seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
      release.busy = { busy: true, kind: 'in-flight', releaseId: 'rel_busy', reason: '该发布目标已有进行中的发布（rel_busy，状态 running）' };
      makeJob(branchTarget());
      const run = await service.runJob('job_release', 'manual');

      expect(release.calls.startRelease).toHaveLength(0);
      expect(run.status).toBe('skipped');
      expect(run.error).toBeUndefined();
      expect(run.log).toContain('rel_busy');
    });

    it('反向断言：判据说不忙时必须真的发布（防止用例空跑）', async () => {
      seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
      release.busy = { busy: false };
      makeJob(branchTarget());
      const run = await service.runJob('job_release', 'manual');
      expect(release.calls.startRelease).toHaveLength(1);
      expect(run.status).toBe('success');
    });

    it('skipWhenUnchanged 且目标已在该版本时零调用并 skipped', async () => {
      seedSuccessfulRun('target-prod', COMMIT_A, 'rel_seed');
      makeJob(branchTarget({ skipWhenUnchanged: true }));
      const run = await service.runJob('job_release', 'manual');

      expect(release.calls.startRelease).toHaveLength(0);
      expect(run.status).toBe('skipped');
      expect(run.log).toContain(COMMIT_A);
    });

    it('反向断言：版本不同则照常发布', async () => {
      seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
      makeJob(branchTarget({ skipWhenUnchanged: true }));
      const run = await service.runJob('job_release', 'manual');
      expect(release.calls.startRelease).toHaveLength(1);
      expect(run.status).toBe('success');
    });
  });

  describe('多动作整单语义', () => {
    it('release 被跳过时后续 http 动作零调用且整单 skipped', async () => {
      seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
      release.busy = { busy: true, reason: '目标正忙' };
      let httpCalls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => { httpCalls += 1; return new Response('ok', { status: 200 }); }) as typeof fetch;
      try {
        makeJob(branchTarget(), {
          actions: [
            { ...(branchTarget() as any), id: 'action_1', name: '发布到生产' },
            { type: 'http', method: 'POST', url: 'https://hook.test/notify', id: 'action_2', name: '通知' },
          ],
        });
        const run = await service.runJob('job_release', 'manual');
        expect(run.status).toBe('skipped');
        expect(httpCalls).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('release 失败时后续 http 动作零调用且整单 failed', async () => {
      seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
      release.runStatuses = ['failed'];
      let httpCalls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => { httpCalls += 1; return new Response('ok', { status: 200 }); }) as typeof fetch;
      try {
        makeJob(branchTarget(), {
          actions: [
            { ...(branchTarget() as any), id: 'action_1', name: '发布到生产' },
            { type: 'http', method: 'POST', url: 'https://hook.test/notify', id: 'action_2', name: '通知' },
          ],
        });
        const run = await service.runJob('job_release', 'manual');
        expect(run.status).toBe('failed');
        expect(httpCalls).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it('等待超时只记账，绝不取消别人的发布', async () => {
    seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
    release.runStatuses = ['running'];
    makeJob(branchTarget(), { timeoutSeconds: 1 });
    const run = await service.runJob('job_release', 'manual');

    expect(run.status).toBe('failed');
    expect(run.error).toContain('rel_test');
    expect(run.error).toContain('发布中心');
    expect(release.calls.cancelRelease).toHaveLength(0);
  });

  describe('试运行（安全红线）', () => {
    it('checkTarget 只跑预检，绝不发布', async () => {
      const result = await service.checkTarget(branchTarget(), 60);
      expect(release.calls.preflight).toHaveLength(1);
      expect(release.calls.startRelease).toHaveLength(0);
      expect(result.log.split('\n')[0]).toContain('未发布');
      expect(result.ok).toBe(true);
    });

    it('预检不通过时试运行如实报失败', async () => {
      release.preflightResult = {
        ok: false,
        checks: [{ id: 'healthcheck', label: '上线地址可访问', status: 'fail', blocking: true, message: '连接超时' }],
      };
      const result = await service.checkTarget(branchTarget(), 60);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('上线地址可访问');
      expect(release.calls.startRelease).toHaveLength(0);
    });
  });

  describe('promote 来源解析', () => {
    it('取源环境最新一次成功 run，并把 commit 作为 expectedCommitSha 传出', async () => {
      seedSuccessfulRun('target-staging', COMMIT_B, 'rel_old');
      seedSuccessfulRun('target-staging', COMMIT_A, 'rel_newer_one');
      makeJob({ type: 'release', targetId: 'target-prod', source: { kind: 'promote', fromTargetId: 'target-staging' } });

      const run = await service.runJob('job_release', 'manual');
      expect(run.status).toBe('success');
      expect(release.calls.startRelease).toHaveLength(1);
      // rel_newer_one 的 startedAt 更晚（种子函数按 id 长度递增），它才是「正在跑的那一版」。
      expect(release.calls.startRelease[0].expectedCommitSha).toBe(COMMIT_A);
      expect(release.calls.startRelease[0].previewUrl).toBe('https://preview.test');
    });

    it('源环境没有成功版本时直接失败，绝不退化成发分支最新', async () => {
      makeJob({ type: 'release', targetId: 'target-prod', source: { kind: 'promote', fromTargetId: 'target-staging' } });
      const run = await service.runJob('job_release', 'manual');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('尚无成功版本');
      expect(release.calls.startRelease).toHaveLength(0);
    });
  });

  describe('失败自动回滚', () => {
    beforeEach(() => {
      seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
      release.runStatuses = ['failed'];
    });

    it('rollbackOnFailure 且未自动恢复过时发起回滚', async () => {
      makeJob(branchTarget({ rollbackOnFailure: true }));
      const run = await service.runJob('job_release', 'manual');
      expect(release.calls.startRollback).toHaveLength(1);
      expect(run.log).toContain('rel_rollback');
    });

    it('发布侧已自动恢复过时不重复回滚', async () => {
      release.runOverrides = { autoRestoredAt: '2026-07-29T01:00:00.000Z' };
      makeJob(branchTarget({ rollbackOnFailure: true }));
      const run = await service.runJob('job_release', 'manual');
      expect(release.calls.startRollback).toHaveLength(0);
      expect(run.log).toContain('跳过重复回滚');
    });

    it('撞上 settling 时退避重试，最终成功', async () => {
      release.startRollbackFailures = 2;
      makeJob(branchTarget({ rollbackOnFailure: true }));
      const run = await service.runJob('job_release', 'manual');
      expect(release.calls.startRollback).toHaveLength(3);
      expect(run.log).toContain('已发起自动回滚');
    });
  });

  describe('人工确认与自动停用', () => {
    it('requireApproval 的规则永不自动发布，只跑预检并发一条待确认通知', async () => {
      seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
      makeJob(branchTarget({ requireApproval: true }));
      const run = await service.runJob('job_release', 'manual');

      expect(release.calls.startRelease).toHaveLength(0);
      expect(release.calls.preflight).toHaveLength(1);
      expect(run.status).toBe('skipped');
      expect(events.map((e) => e.type)).toContain('release.schedule.approval-required');
      const notice = events.find((e) => e.type === 'release.schedule.approval-required')!;
      expect(notice.data.targetId).toBe('target-prod');
      expect(notice.data.projectId).toBe('demo');
    });

    it('连续失败达阈值后自动停用规则并发通知', async () => {
      seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
      release.startReleaseError = new Error('SSH 连接失败');
      makeJob(branchTarget());

      for (let i = 0; i < RELEASE_JOB_FAILURE_DISABLE_THRESHOLD; i += 1) {
        const run = await service.runJob('job_release', 'manual');
        expect(run.status).toBe('failed');
      }

      const job = stateService.getScheduledJob('job_release')!;
      expect(job.enabled).toBe(false);
      expect(job.consecutiveFailureCount).toBe(RELEASE_JOB_FAILURE_DISABLE_THRESHOLD);
      expect(job.autoDisabledReason).toContain('自动停用');
      // 停用后不能还排着下一次运行，否则「自动停用」等于没停。
      expect(job.nextRunAt).toBeNull();
      expect(events.map((e) => e.type)).toContain('release.schedule.disabled');
    });

    it('中途成功会清零连续失败计数，规则不会被误关', async () => {
      seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
      release.startReleaseError = new Error('SSH 连接失败');
      makeJob(branchTarget());
      await service.runJob('job_release', 'manual');
      expect(stateService.getScheduledJob('job_release')!.consecutiveFailureCount).toBe(1);

      release.startReleaseError = undefined;
      await service.runJob('job_release', 'manual');
      const job = stateService.getScheduledJob('job_release')!;
      expect(job.consecutiveFailureCount).toBe(0);
      expect(job.enabled).toBe(true);
    });

    it('跳过不算失败，不会把规则推向自动停用', async () => {
      seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
      release.busy = { busy: true, reason: '目标正忙' };
      makeJob(branchTarget());
      for (let i = 0; i < RELEASE_JOB_FAILURE_DISABLE_THRESHOLD + 1; i += 1) {
        await service.runJob('job_release', 'manual');
      }
      const job = stateService.getScheduledJob('job_release')!;
      expect(job.enabled).toBe(true);
      expect(job.consecutiveFailureCount).toBe(0);
    });
  });

  it('release 动作经 normalizeJob → 落库 → 读回后仍在（白名单静默丢失守卫）', async () => {
    makeJob(branchTarget({ rollbackOnFailure: true, skipWhenUnchanged: true }));
    const reloaded = stateService.listScheduledJobs('demo').find((job) => job.id === 'job_release')!;
    expect(reloaded.actions).toHaveLength(1);
    const action = reloaded.actions![0];
    expect(action.type).toBe('release');
    if (action.type !== 'release') throw new Error('release 动作被静默过滤掉了');
    expect(action.targetId).toBe('target-prod');
    expect(action.source).toEqual({ kind: 'branch', branchId: 'b1' });
    expect(action.rollbackOnFailure).toBe(true);
    expect(action.skipWhenUnchanged).toBe(true);
    expect(action.name).toBe('发布到生产');
  });

  it('release 动作强制零重试（一次生产部署失败不自动重放）', async () => {
    seedSuccessfulRun('target-prod', COMMIT_B, 'rel_seed');
    release.startReleaseError = new Error('SSH 连接失败');
    makeJob(branchTarget(), { retryCount: 5 });
    await service.runJob('job_release', 'manual');
    expect(release.calls.startRelease).toHaveLength(1);
  });
});
