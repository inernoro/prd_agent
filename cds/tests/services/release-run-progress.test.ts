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
import { releaseScriptPhase } from '../../src/services/release-steps.js';
import { StateService } from '../../src/services/state.js';
import type { ReleaseRun, ReleaseTarget } from '../../src/types.js';

/**
 * 后端一等公民步骤模型的执行期回归。
 *
 * 事故值：执行器只发 emitLog 的 phase 字面量、不写任何结构化步骤，run.planId 写进去之后
 * 再没人拿它查过 plan，ReleasePlan.steps 端到端零消费；前端只能把日志 phase 收成 Set、
 * 倒着找最后一条 error 反推失败步——而 SSH 的 stderr 是逐行进日志的，最后一条 error
 * 经常来自上一步噪声，失败格常年点错位置。本套件要求：run 一入库就有完整步骤表，
 * 执行推进它，失败精确落在当前那一步。
 */

const DEPLOY_COMMAND = './fast.sh && ./exec_dep.sh';

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

describe('ReleaseRun 步骤快照', () => {
  let stateDir: string;
  let stateService: StateService;
  let healthServer: http.Server;
  let healthUrl: string;
  let healthStatus = 200;
  const services: ReleaseService[] = [];

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-progress-'));
    stateService = new StateService(path.join(stateDir, 'state.json'));
    stateService.load();
    // 绑定仓库：existing-script 模式的预检要求远端目录能证明属于本项目。
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1', githubRepoFullName: 'acme/app' } as never);
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

    healthStatus = 200;
    healthServer = http.createServer((_req, res) => { res.writeHead(healthStatus); res.end('ok'); });
    await new Promise<void>((resolve) => healthServer.listen(0, '127.0.0.1', resolve));
    healthUrl = `http://127.0.0.1:${(healthServer.address() as AddressInfo).port}/healthz`;
    stateService.upsertReleaseTarget(releaseTarget(healthUrl));
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

  function releaseTarget(healthcheckUrl: string): ReleaseTarget {
    return {
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
        appPath: '/opt/app-prod',
        deployCommand: DEPLOY_COMMAND,
        healthcheckUrl,
      },
    };
  }

  function createService(deployHandler: (req: ReleaseSshExecRequest) => Promise<string>): ReleaseService {
    const sshExecutor: ReleaseSshExecutor = async (req) => {
      if (req.command.includes('CDS_REPO_ORIGIN')) return 'CDS_REPO_ORIGIN=git@github.com:acme/app.git\n';
      if (!isDeployCommand(req.command)) return 'cds-release-connect-ok';
      return deployHandler(req);
    };
    const service = new ReleaseService(stateService, { sshExecutor });
    services.push(service);
    return service;
  }

  function start(service: ReleaseService): Promise<ReleaseRun> {
    return service.startRelease({
      branchId: 'b1',
      targetId: 'target-prod',
      operator: 'tester',
      previewUrl: 'https://preview.example.test',
    });
  }

  function stepState(releaseId: string, stepId: string): string | undefined {
    return stateService.getReleaseRun(releaseId)?.progress?.steps.find((step) => step.id === stepId)?.state;
  }

  it('run 一入库就带完整步骤表，UI 不必等第一条日志才知道共几步', async () => {
    const service = createService(async () => 'deployed');
    const run = await start(service);

    // queued 时刻就要拿得到「共 M 步」；此前这里什么都没有，前端只能靠日志现猜。
    expect(run.progress?.planId).toBe('p1:ssh-script');
    expect(run.progress?.steps.map((step) => step.id)).toEqual([
      'connect',
      'prepare',
      'plan',
      releaseScriptPhase('./fast.sh'),
      releaseScriptPhase('./exec_dep.sh'),
      'healthcheck',
      'record',
    ]);
  });

  it('计划模板的 step.id 与执行器真实 emit 的 phase 逐一对得上', async () => {
    const service = createService(async () => 'deployed');
    const run = await start(service);
    await waitFor(() => stateService.getReleaseRun(run.releaseId)?.status === 'success');

    const finished = stateService.getReleaseRun(run.releaseId)!;
    const loggedPhases = new Set(finished.logs.map((log) => log.phase).filter(Boolean));
    for (const step of finished.progress!.steps) {
      // 事故值：模板写 4 步、执行器发 6 个 phase，两边对不上号，plan.steps 因此没人敢读。
      expect(loggedPhases.has(step.id)).toBe(true);
    }
  });

  it('发布成功后所有步骤都是 done，且当前步落在最后一步', async () => {
    const service = createService(async () => 'deployed');
    const run = await start(service);
    await waitFor(() => stateService.getReleaseRun(run.releaseId)?.status === 'success');

    const finished = stateService.getReleaseRun(run.releaseId)!;
    expect(finished.progress?.steps.every((step) => step.state === 'done')).toBe(true);
    expect(finished.progress?.currentStepId).toBe('record');
  });

  it('第二条脚本失败时只有那一步 failed，后续步骤保持 pending', async () => {
    let call = 0;
    const service = createService(async () => {
      call += 1;
      if (call === 1) return 'fast ok';
      throw new Error('ssh exec exit=1 stderr=deploy blew up');
    });
    const run = await start(service);
    await waitFor(() => stateService.getReleaseRun(run.releaseId)?.status === 'failed');

    const failedPhase = releaseScriptPhase('./exec_dep.sh');
    expect(stepState(run.releaseId, releaseScriptPhase('./fast.sh'))).toBe('done');
    expect(stepState(run.releaseId, failedPhase)).toBe('failed');
    expect(stepState(run.releaseId, 'healthcheck')).toBe('pending');
    expect(stepState(run.releaseId, 'record')).toBe('pending');
    // 失败归因跟着结构化步骤走，不再取「最后一条日志的 phase」——SSH 的 stderr 逐行进日志，
    // 那条最后的 error 常常是别的阶段的噪声。
    expect(stateService.getReleaseRun(run.releaseId)?.failure?.phase).toBe(failedPhase);
  });

  it('健康检查失败时失败格落在 healthcheck，不会误标到 deploy', async () => {
    // 预检阶段上线地址必须是通的，发布命令跑完之后才把它打挂 —— 模拟「发上去反而挂了」。
    const service = createService(async () => { healthStatus = 503; return 'deployed'; });
    const run = await start(service);
    await waitFor(() => stateService.getReleaseRun(run.releaseId)?.status === 'failed');

    expect(stepState(run.releaseId, releaseScriptPhase('./exec_dep.sh'))).toBe('done');
    expect(stepState(run.releaseId, 'healthcheck')).toBe('failed');
    expect(stepState(run.releaseId, 'record')).toBe('pending');
  });

  it('存量 run 没有 progress 时不会崩，也不会被凭空补出一份步骤表', () => {
    const service = createService(async () => 'deployed');
    const legacy = stateService.addReleaseRun({
      releaseId: 'rel_legacy',
      projectId: 'p1',
      branchId: 'b1',
      commitSha: 'a'.repeat(40),
      artifact: { type: 'branch-preview', commitSha: 'a'.repeat(40), branchId: 'b1', branchName: 'main' },
      targetId: 'target-prod',
      planId: 'p1:ssh-script',
      status: 'running',
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      logs: [],
      seq: 0,
    });

    expect(legacy.progress).toBeUndefined();
    expect(() => service.reconcileInterruptedReleases()).not.toThrow();
    const reconciled = stateService.getReleaseRun('rel_legacy')!;
    expect(reconciled.status).toBe('failed');
    expect(reconciled.progress).toBeUndefined();
  });

  it('存量项目残缺的计划模板会被就地补齐（plan 没有任何编辑入口，不补就永远残缺）', () => {
    stateService.upsertReleasePlan({
      id: 'p1:ssh-script',
      projectId: 'p1',
      name: '项目现有脚本发布',
      template: 'ssh-script',
      targetType: 'ssh',
      steps: [
        { id: 'connect', title: '连接目标', kind: 'ssh' },
        { id: 'deploy', title: '执行项目发布命令', kind: 'ssh' },
        { id: 'healthcheck', title: '验证最终入口', kind: 'healthcheck' },
        { id: 'record', title: '记录版本与脚本哈希', kind: 'record' },
      ],
      failureStrategy: 'stop',
      rollbackStrategy: 'command',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const service = createService(async () => 'deployed');
    const plans = service.ensureDefaultPlans('p1');
    const sshScript = plans.find((item) => item.id === 'p1:ssh-script')!;

    expect(sshScript.steps.map((step) => step.id)).toEqual([
      'connect', 'prepare', 'plan', 'deploy', 'healthcheck', 'record',
    ]);
    // 补步骤不等于伪造成新计划，createdAt 保留。
    expect(sshScript.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
