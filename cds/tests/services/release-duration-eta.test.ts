import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ReleaseService,
  isReleaseRunInFlight,
  type ReleaseSshExecRequest,
  type ReleaseSshExecutor,
} from '../../src/services/release-service.js';
import { StateService } from '../../src/services/state.js';
import type { ReleaseTarget } from '../../src/types.js';
import {
  computeReleaseEta,
  formatEtaClock,
  releaseEtaText,
} from '../../web/src/lib/releaseEta.js';

/**
 * 生产发布 ETA（发布中心「预计还需 MM:SS（近 N 次中位）」）回归。
 *
 * 病根：发布进行中只显示「已耗时」，用户面对一个往生产机器 SSH 跑好几分钟的
 * 黑盒不知道还要等多久。本套件钉三件事：耗时台账口径正确、两份台账物理隔离、
 * 无样本时不编造数字。
 */

const DEPLOY_COMMAND = "CDS_LOCAL_PROD_DIR='/opt/app-prod/current' '/opt/cds/current/scripts/local-prod-release.sh'";

function isDeployCommand(command: string): boolean {
  return command.includes('CDS_RELEASE_ID=');
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor 超时：期望的状态一直没有出现');
}

describe('生产发布耗时台账', () => {
  let stateDir: string;
  let stateService: StateService;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-eta-'));
    stateService = new StateService(path.join(stateDir, 'state.json'));
    stateService.load();
  });

  afterEach(async () => {
    await stateService.flush();
    if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('无样本时 medianMs 为 null，不返回 0', () => {
    // 事故值：返回 { medianMs: 0 } 会让发布中心渲染「预计还需 00:00」——
    // 一个凭空编造、必然落空的承诺。没有历史就该说没有历史。
    const est = stateService.getReleaseEstimate('target-prod');
    expect(est.medianMs).toBeNull();
    expect(est.sampleCount).toBe(0);
  });

  it('按 targetId 分桶：同项目两个站点的耗时互不干扰', () => {
    // 同项目的两个站点可能在不同机器跑不同脚本，合桶中位没有判别力。
    [60_000, 60_000, 60_000].forEach((ms) => stateService.recordReleaseDuration('site-a', ms, 30 * 60_000));
    [600_000, 600_000].forEach((ms) => stateService.recordReleaseDuration('site-b', ms, 30 * 60_000));
    expect(stateService.getReleaseEstimate('site-a').medianMs).toBe(60_000);
    expect(stateService.getReleaseEstimate('site-b').medianMs).toBe(600_000);
  });

  it('生产发布台账与分支部署台账物理隔离，互不污染', () => {
    // 事故值：复用 deployDurationSamples 的 mode='release' 桶。那个 release 指的是
    // 分支容器跑极速版镜像（中位 42s 量级），生产发布是 SSH 跑脚本（8 分钟量级）。
    // 合桶后发布中心会拿 42s 当预计，分支等待页会被 8 分钟拉高，两边同时失真。
    stateService.recordDeployDuration('proj', 'release', 42_000);
    stateService.recordReleaseDuration('proj', 480_000, 30 * 60_000);

    expect(stateService.getDeployEstimate('proj', 'release').medianMs).toBe(42_000);
    expect(stateService.getDeployEstimate('proj', 'release').sampleCount).toBe(1);
    expect(stateService.getReleaseEstimate('proj').medianMs).toBe(480_000);
    expect(stateService.getReleaseEstimate('proj').sampleCount).toBe(1);

    // 两份台账是两个顶层字段，键空间层面就不可能撞。
    const state = stateService.getState();
    expect(Object.keys(state.deployDurationSamples?.buckets || {})).toEqual(['proj::release']);
    expect(Object.keys(state.releaseDurationSamples?.buckets || {})).toEqual(['proj']);
  });

  it('超过合理上界的样本被丢弃，不把中位一次性抬高', () => {
    // 一条被挂到执行超时才收尾的记录足以毒化后面十几次的预计。
    stateService.recordReleaseDuration('target-prod', 300_000, 600_000);
    stateService.recordReleaseDuration('target-prod', 900_000, 600_000);
    const est = stateService.getReleaseEstimate('target-prod');
    expect(est.sampleCount).toBe(1);
    expect(est.medianMs).toBe(300_000);
  });

  it('非法值静默忽略，样本数不虚增', () => {
    [0, -1, Number.NaN, Number.POSITIVE_INFINITY].forEach((ms) => {
      stateService.recordReleaseDuration('target-prod', ms, 30 * 60_000);
    });
    expect(stateService.getReleaseEstimate('target-prod').sampleCount).toBe(0);
  });

  it('桶按 ring buffer 上限截断，估算只看最近一个窗口', () => {
    const max = StateService.DEPLOY_DURATION_SAMPLES_MAX;
    const win = StateService.DEPLOY_DURATION_ESTIMATE_WINDOW;
    for (let i = 0; i < max + 10; i += 1) stateService.recordReleaseDuration('target-prod', 1_000, 30 * 60_000);
    expect(stateService.getState().releaseDurationSamples?.buckets?.['target-prod']?.length).toBe(max);

    for (let i = 0; i < win; i += 1) stateService.recordReleaseDuration('target-prod', 300_000, 30 * 60_000);
    const est = stateService.getReleaseEstimate('target-prod');
    expect(est.sampleCount).toBe(win);
    expect(est.medianMs).toBe(300_000);
  });
});

describe('ReleaseService 采样口径', () => {
  let stateDir: string;
  let stateService: StateService;
  let healthServer: http.Server;
  let healthUrl: string;
  const services: ReleaseService[] = [];

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-eta-svc-'));
    stateService = new StateService(path.join(stateDir, 'state.json'));
    stateService.load();
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as never);
    stateService.addBranch({
      id: 'b1',
      projectId: 'p1',
      branch: 'main',
      worktreePath: '/tmp/b1',
      services: {},
      status: 'running',
      pinnedCommit: 'a'.repeat(40),
      createdAt: '2026-07-28T00:00:00.000Z',
    } as never);
    stateService.addRemoteHost({
      id: 'host-prod',
      name: '生产主机',
      host: '127.0.0.1',
      sshPort: 22,
      sshUser: 'deploy',
      sshPrivateKeyEncrypted: 'PLAINTEXT-TEST-KEY',
      sshPrivateKeyFingerprint: 'deadbeefdeadbeef',
      tags: [],
      isEnabled: true,
      createdAt: '2026-07-28T00:00:00.000Z',
    } as never);

    healthServer = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise<void>((resolve) => healthServer.listen(0, '127.0.0.1', resolve));
    healthUrl = `http://127.0.0.1:${(healthServer.address() as AddressInfo).port}/healthz`;
    const target: ReleaseTarget = {
      id: 'target-prod',
      projectId: 'p1',
      name: '生产站点',
      type: 'ssh',
      createdAt: '2026-07-28T00:00:00.000Z',
      isEnabled: true,
      ssh: {
        host: '127.0.0.1',
        port: 22,
        user: 'deploy',
        privateKeyRef: 'host-prod',
        appPath: '/opt/app-prod/current',
        deployCommand: DEPLOY_COMMAND,
        healthcheckUrl: healthUrl,
      },
    };
    stateService.upsertReleaseTarget(target);
  });

  afterEach(async () => {
    for (const service of services.splice(0)) {
      for (const run of stateService.getReleaseRuns()) {
        if (isReleaseRunInFlight(run)) service.cancelRelease(run.releaseId, 'test-teardown');
      }
    }
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await stateService.flush();
    if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function createService(deployHandler: (req: ReleaseSshExecRequest) => Promise<string>): ReleaseService {
    const sshExecutor: ReleaseSshExecutor = async (req) => {
      if (!isDeployCommand(req.command)) return 'cds-release-connect-ok';
      return deployHandler(req);
    };
    const service = new ReleaseService(stateService, { sshExecutor });
    services.push(service);
    return service;
  }

  function start(service: ReleaseService): Promise<{ releaseId: string }> {
    return service.startRelease({
      branchId: 'b1',
      targetId: 'target-prod',
      operator: 'tester',
      previewUrl: 'https://preview.example.test',
    });
  }

  it('发布成功后耗时进台账，失败的 run 不进', async () => {
    const service = createService(async () => 'deployed');
    const ok = await start(service);
    await waitFor(() => stateService.getReleaseRun(ok.releaseId)!.status === 'success');
    expect(stateService.getReleaseEstimate('target-prod').sampleCount).toBe(1);

    const failing = createService(async () => { throw new Error('deploy exploded'); });
    const bad = await start(failing);
    await waitFor(() => stateService.getReleaseRun(bad.releaseId)!.status === 'failed');
    // 失败的耗时进台账会把中位拉向「跑到一半就炸」的短时长，预计值系统性偏低。
    expect(stateService.getReleaseEstimate('target-prod').sampleCount).toBe(1);
  });

  it('回滚成功不进台账（口径与正向发布不同）', async () => {
    const service = createService(async () => 'deployed');
    const first = await start(service);
    await waitFor(() => stateService.getReleaseRun(first.releaseId)!.status === 'success');
    const second = await start(service);
    await waitFor(() => stateService.getReleaseRun(second.releaseId)!.status === 'success');
    expect(stateService.getReleaseEstimate('target-prod').sampleCount).toBe(2);

    const rollback = await service.startRollback(second.releaseId, 'alice', first.releaseId);
    await waitFor(() => stateService.getReleaseRun(rollback.releaseId)!.status === 'rollback_success');

    // 事故值：把 rollback_success（或 rollbackOf 非空的 run）也计入，回滚往往只是
    // 重放上一版本、耗时口径与正向发布不同，混进去会把「预计还需」整体带偏。
    expect(stateService.getReleaseEstimate('target-prod').sampleCount).toBe(2);
    expect(stateService.getReleaseRun(rollback.releaseId)!.rollbackOf).toBe(second.releaseId);
  });
});

describe('发布 ETA 文案（前端纯函数）', () => {
  const startedAt = '2026-07-28T10:00:00.000Z';
  const startedAtMs = Date.parse(startedAt);

  it('有样本时给出预计还需 + 近 N 次中位', () => {
    const text = releaseEtaText(startedAt, { medianMs: 480_000, sampleCount: 8 }, startedAtMs + 72_000);
    expect(text).toBe('已耗时 01:12 · 预计还需 06:48（近 8 次中位）');
  });

  it('无样本时给诚实文案，绝不出现预计数字', () => {
    // 事故值：sampleCount=0 却渲染「预计还需 00:00」。
    const text = releaseEtaText(startedAt, { medianMs: null, sampleCount: 0 }, startedAtMs + 5_000);
    expect(text).toBe('已耗时 00:05 · 正在积累历史耗时数据，暂无预计');
    expect(text).not.toContain('预计还需');
  });

  it('后端未下发 estimate 字段时同样退化成诚实文案，不白屏', () => {
    expect(releaseEtaText(startedAt, undefined, startedAtMs + 5_000))
      .toBe('已耗时 00:05 · 正在积累历史耗时数据，暂无预计');
  });

  it('已耗时超过中位时说「慢了多少」，而不是永远挂在 00:00', () => {
    const text = releaseEtaText(startedAt, { medianMs: 60_000, sampleCount: 5 }, startedAtMs + 90_000);
    expect(text).toBe('已耗时 01:30 · 已比近 5 次中位慢 00:30');
  });

  it('computeReleaseEta：无样本一律 null，超时给 overdueMs', () => {
    expect(computeReleaseEta(startedAt, { medianMs: null, sampleCount: 0 }, startedAtMs + 1_000))
      .toEqual({ elapsedMs: 1_000, remainingMs: null, overdueMs: null, sampleCount: 0 });
    expect(computeReleaseEta(startedAt, { medianMs: 10_000, sampleCount: 3 }, startedAtMs + 25_000))
      .toEqual({ elapsedMs: 25_000, remainingMs: 0, overdueMs: 15_000, sampleCount: 3 });
  });

  it('startedAt 缺失或不可解析时返回空串（宁可不显示，也不显示 00:00 假象）', () => {
    expect(releaseEtaText(undefined, { medianMs: 60_000, sampleCount: 3 }, startedAtMs)).toBe('');
    expect(releaseEtaText('not-a-date', { medianMs: 60_000, sampleCount: 3 }, startedAtMs)).toBe('');
  });

  it('formatEtaClock 超过一小时给 H:MM:SS', () => {
    expect(formatEtaClock(3_723_000)).toBe('1:02:03');
    expect(formatEtaClock(0)).toBe('00:00');
  });
});
