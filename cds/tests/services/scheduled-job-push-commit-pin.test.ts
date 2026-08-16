/**
 * 事件驱动发布必须发**触发它的那个 commit**。
 *
 * 背景（Codex review P1，2026-08-16）：push 规则的路径过滤是拿这次 push 的改动清单
 * 判的，但发布动作解析来源时读的是分支的**当前** commit。两次 push 挨得近时，
 * 第一个事件会把第二个 commit 发出去——而后者的改动清单从没被这条规则评估过。
 * 一条 `docs/** → docs-site` 的规则，可以就这样把一个只改了 `src/` 的 commit 发上线，
 * 日志里还写着「命中 docs/**」。
 *
 * 两道闸，各自独立可红：
 *   1. runPushRules 发现分支已前进 → 本次不发，交给新 commit 自己的事件；
 *   2. 真发时把 commit 钉进 expectedCommitSha，让 ReleaseService 做 fail-closed 钳制
 *      （竞态兜底：检查与发布之间分支又动了）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { ScheduledJobService, type ScheduledJobReleasePort } from '../../src/services/scheduled-job-service.js';
import type { ReleasePreflightResult, ReleaseStartInput, ReleaseTargetBusyState } from '../../src/services/release-service.js';
import type { ReleaseRun, ScheduledJob } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const COMMIT_PUSHED = 'a'.repeat(40);
const COMMIT_NEWER = 'b'.repeat(40);

interface ReleaseStub extends ScheduledJobReleasePort {
  startRelease: (input: ReleaseStartInput) => Promise<ReleaseRun>;
  started: ReleaseStartInput[];
}

function makeReleaseStub(): ReleaseStub {
  const started: ReleaseStartInput[] = [];
  const run = (): ReleaseRun => ({
    releaseId: 'rel_test',
    projectId: 'demo',
    branchId: 'b1',
    commitSha: COMMIT_PUSHED,
    artifact: {
      type: 'branch-preview', commitSha: COMMIT_PUSHED, branchId: 'b1',
      branchName: 'main', previewUrl: 'https://preview.test',
    },
    targetId: 'target-prod',
    planId: 'demo:ssh-script',
    status: 'success',
    startedAt: '2026-08-16T00:00:00.000Z',
    logs: [],
    seq: 0,
  });
  const preflightResult: ReleasePreflightResult = {
    ok: true,
    checks: [{ id: 'branch', label: '分支部署成功', status: 'pass', blocking: false }],
  };
  return {
    started,
    isTargetBusy: (): ReleaseTargetBusyState => ({ busy: false }),
    preflight: async () => preflightResult,
    startRelease: async (input) => { started.push(input); return run(); },
    startRollback: async () => run(),
    getRun: () => run(),
  };
}

describe('push 规则发布钉住触发它的 commit', () => {
  let tmpDir: string;
  let stateService: StateService;
  let release: ReleaseStub;
  let service: ScheduledJobService;

  /** 分支记录当前停在哪个 commit。默认 = 本次 push 的那个（正常情况）。 */
  function seedBranch(pinnedCommit: string): void {
    stateService.addBranch({
      id: 'b1', projectId: 'demo', branch: 'main', worktreePath: '/tmp/b1', services: {},
      status: 'running', pinnedCommit, createdAt: '2026-08-16T00:00:00.000Z',
    } as never);
  }

  function seedPushJob(): ScheduledJob {
    const job = service.normalizeJob({
      id: 'job_push',
      projectId: 'demo',
      name: 'main 推送即发布',
      enabled: true,
      schedule: { type: 'push', branchPattern: 'main', event: 'push' },
      actions: [{
        id: 'action_1',
        name: '发布到生产',
        type: 'release',
        targetId: 'target-prod',
        source: { kind: 'branch', branchId: 'b1' },
      }],
      timeoutSeconds: 3600,
      retryCount: 0,
      concurrencyPolicy: 'skip',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    } as never);
    stateService.upsertScheduledJob(job);
    return job;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-push-pin-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    stateService.addProject({
      id: 'demo', slug: 'demo', name: 'Demo', kind: 'git',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as never);
    stateService.upsertReleaseTarget({
      id: 'target-prod', projectId: 'demo', name: '生产站点', type: 'ssh',
      createdAt: '2026-08-16T00:00:00.000Z', isEnabled: true,
      ssh: {
        host: '127.0.0.1', port: 22, user: 'deploy', privateKeyRef: 'h1',
        appPath: '/opt/app', deployCommand: './deploy.sh', healthcheckUrl: 'https://prod.test',
      },
    } as never);
    release = makeReleaseStub();
    service = new ScheduledJobService({
      stateService,
      shell: new MockShellExecutor(),
      config: { masterPort: 9900, repoRoot: tmpDir },
      release,
      releasePollIntervalMs: 1,
      rollbackRetryIntervalMs: 1,
      sleep: async () => { /* 测试里不真睡 */ },
    });
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('把事件带来的 commit 钉进 expectedCommitSha', async () => {
    seedBranch(COMMIT_PUSHED);
    seedPushJob();
    const started = await service.runPushRules({
      projectId: 'demo', branch: 'main', event: 'push',
      changedPaths: ['src/index.ts'], commitSha: COMMIT_PUSHED,
    });
    expect(started).toBe(1);
    expect(release.started).toHaveLength(1);
    expect(release.started[0].expectedCommitSha).toBe(COMMIT_PUSHED);
  });

  it('分支已前进到别的 commit 时，本次事件不发', async () => {
    // 这是被举报的那个场景：事件说的是 A，分支上已经是 B。
    // 发 B 等于用 A 的路径过滤结论授权了一个没被评估过的版本。
    seedBranch(COMMIT_NEWER);
    seedPushJob();
    const started = await service.runPushRules({
      projectId: 'demo', branch: 'main', event: 'push',
      changedPaths: ['src/index.ts'], commitSha: COMMIT_PUSHED,
    });
    expect(started).toBe(0);
    expect(release.started).toHaveLength(0);
  });

  /**
   * 「不发」必须是**跳过**，不能记成失败：连续两次 failed 会自动停用这条规则，
   * 那等于一次正常的连推就能把一条好规则关掉。
   */
  it('过期事件不留下失败记录，也不会把规则推向自动停用', async () => {
    seedBranch(COMMIT_NEWER);
    const job = seedPushJob();
    await service.runPushRules({
      projectId: 'demo', branch: 'main', event: 'push',
      changedPaths: ['src/index.ts'], commitSha: COMMIT_PUSHED,
    });
    const runs = stateService.listScheduledJobRuns({ jobId: job.id });
    expect(runs.filter((r) => r.status === 'failed')).toHaveLength(0);
    expect(stateService.getScheduledJob(job.id)?.enabled).toBe(true);
  });

  /**
   * 发的必须是**被推的**那个分支，不是建规则时存进去的占位值。
   *
   * `release/*` 这类 glob 规则存不下具体分支（哪个分支被推只有事件发生时才知道），
   * 占位值赢了就等于「不管推哪个 release 分支，发的永远是同一个」——发错分支，
   * 而且日志里看着一切正常。这一条原先只由源码里的一行字面量守着，改个调用写法
   * 就会误红；现在真跑一遍。
   */
  it('发的是被推的那个分支，不是规则里的占位值', async () => {
    seedBranch(COMMIT_PUSHED);
    stateService.addBranch({
      id: 'b-placeholder', projectId: 'demo', branch: 'release/old', worktreePath: '/tmp/b2',
      services: {}, status: 'running', pinnedCommit: COMMIT_NEWER, createdAt: '2026-08-16T00:00:00.000Z',
    } as never);
    const job = service.normalizeJob({
      id: 'job_glob',
      projectId: 'demo',
      name: 'release 分支推送即发布',
      enabled: true,
      schedule: { type: 'push', branchPattern: '*', event: 'push' },
      actions: [{
        id: 'action_1', name: '发布到生产', type: 'release', targetId: 'target-prod',
        source: { kind: 'branch', branchId: 'b-placeholder' },
      }],
      timeoutSeconds: 3600,
      retryCount: 0,
      concurrencyPolicy: 'skip',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    } as never);
    stateService.upsertScheduledJob(job);

    await service.runPushRules({
      projectId: 'demo', branch: 'main', event: 'push',
      changedPaths: ['src/index.ts'], commitSha: COMMIT_PUSHED,
    });
    expect(release.started).toHaveLength(1);
    expect(release.started[0].branchId).toBe('b1');
  });

  /**
   * 没有 commitSha 的调用方（pr-open、老调用方）行为不变：仍是「发这个分支的最新版」，
   * 不要因为新增钳制把它们全都变成拒发。
   */
  it('事件没带 commit 时不钳制，维持原语义', async () => {
    seedBranch(COMMIT_PUSHED);
    seedPushJob();
    const started = await service.runPushRules({
      projectId: 'demo', branch: 'main', event: 'push', changedPaths: ['src/index.ts'],
    });
    expect(started).toBe(1);
    expect(release.started[0].expectedCommitSha).toBeUndefined();
  });
});
