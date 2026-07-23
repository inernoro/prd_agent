import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckRunRunner } from '../../src/services/check-run-runner.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { StateService } from '../../src/services/state.js';
import type { BranchEntry, CdsConfig } from '../../src/types.js';

describe('CheckRunRunner DeploymentRun projection', () => {
  let tmpDir: string;
  let stateService: StateService;
  let branch: BranchEntry;
  let createdPayload: any;
  let updatedPayload: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-check-run-ledger-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'));
    stateService.load();
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as any);
    branch = {
      id: 'b1',
      projectId: 'p1',
      branch: 'feat/run-ledger',
      worktreePath: '/tmp/b1',
      services: {},
      status: 'building',
      createdAt: '2026-07-10T00:00:00.000Z',
      githubRepoFullName: 'owner/repo',
      githubCommitSha: '1234567890abcdef',
      githubInstallationId: 42,
    };
    stateService.addBranch(branch);
  });

  afterEach(async () => {
    await stateService.flush();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses runId for check correlation and projects structured failure events', async () => {
    const runs = new DeploymentRunService(stateService, { idFactory: () => 'dr_check' });
    await runs.begin({ projectId: 'p1', branchId: 'b1', trigger: 'webhook' });

    const githubApp = {
      async createCheckRun(_installationId: number, _owner: string, _repo: string, payload: any) {
        createdPayload = payload;
        return { id: 99, url: 'https://api.github.test/checks/99' };
      },
      async updateCheckRun(_installationId: number, _owner: string, _repo: string, _id: number, payload: any) {
        updatedPayload = payload;
        return { id: 99, url: 'https://api.github.test/checks/99' };
      },
    };
    const config = {
      masterPort: 9900,
      publicBaseUrl: 'https://cds.example.test',
      previewDomain: 'example.test',
      rootDomains: ['example.test'],
    } as CdsConfig;
    const runner = new CheckRunRunner({ stateService, githubApp: githubApp as any, config });

    await runner.ensureOpen(branch);

    expect(createdPayload.externalId).toBe('dr_check');
    expect(createdPayload.detailsUrl).toContain('runId=dr_check');
    expect(createdPayload.output.summary).toContain('DeploymentRun: `dr_check`');

    runs.fail('dr_check', {
      code: 'cds.ready.timeout',
      owner: 'code',
      retryable: false,
      summary: '应用端口未在期限内就绪',
      phase: 'ready',
      evidenceRefs: ['container:api'],
      suggestedAction: '检查监听地址与启动日志',
    });
    await runner.finalize(branch, {
      conclusion: 'failure',
      summary: '部署失败',
      logTail: '旧 OperationLog 不应覆盖 run 事件',
    });

    expect(updatedPayload.detailsUrl).toContain('runId=dr_check');
    expect(updatedPayload.output.summary).toContain('dr_check` · failed · ready');
    expect(updatedPayload.output.text).toContain('cds.ready.timeout');
    expect(updatedPayload.output.text).toContain('owner: `code`');
    expect(updatedPayload.output.text).toContain('[2] [failed] ready: 应用端口未在期限内就绪');
    expect(updatedPayload.output.text).not.toContain('旧 OperationLog 不应覆盖');
  });
});

describe('CheckRunRunner.reconcileStale (周期收敛滞留 in_progress 的 check run)', () => {
  let tmpDir: string;
  let stateService: StateService;
  let branch: BranchEntry;
  let updates: any[];
  let githubApp: any;
  let runner: CheckRunRunner;
  let runs: DeploymentRunService;

  const config = {
    masterPort: 9900,
    publicBaseUrl: 'https://cds.example.test',
    previewDomain: 'example.test',
    rootDomains: ['example.test'],
  } as CdsConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-check-run-stale-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'));
    stateService.load();
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as any);
    branch = {
      id: 'b1',
      projectId: 'p1',
      branch: 'feat/stale-check',
      worktreePath: '/tmp/b1',
      services: {},
      status: 'building',
      createdAt: '2026-07-10T00:00:00.000Z',
      githubRepoFullName: 'owner/repo',
      githubCommitSha: '1234567890abcdef',
      githubInstallationId: 42,
    };
    stateService.addBranch(branch);
    updates = [];
    githubApp = {
      async createCheckRun() {
        return { id: 7, url: 'https://api.github.test/checks/7' };
      },
      async updateCheckRun(_inst: number, _owner: string, _repo: string, id: number, payload: any) {
        updates.push({ id, payload });
        return { id, url: `https://api.github.test/checks/${id}` };
      },
    };
    runner = new CheckRunRunner({ stateService, githubApp, config });
    runs = new DeploymentRunService(stateService, { idFactory: () => 'dr_stale' });
  });

  afterEach(async () => {
    await stateService.flush();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function afterGrace(): Date {
    return new Date(Date.now() + 4 * 60_000);
  }

  it('run 已 failed 且超过宽限期 → 补收尾为 failure（截图场景：CDS 已失败但 GitHub 一直黄灯）', async () => {
    await runs.begin({ projectId: 'p1', branchId: 'b1', trigger: 'webhook' });
    await runner.ensureOpen(branch);
    runs.fail('dr_stale', {
      code: 'cds.run.interrupted',
      owner: 'cds',
      retryable: true,
      summary: '部署执行心跳已过期，CDS 已将本次运行收敛为失败',
      phase: 'build',
      evidenceRefs: [],
    });

    const n = await runner.reconcileStale({ now: afterGrace() });
    expect(n).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.conclusion).toBe('failure');
    expect(updates[0].payload.status).toBe('completed');
    expect(updates[0].payload.output.summary).toContain('心跳已过期');
    expect(updates[0].payload.output.text).toContain('cds.run.interrupted');
    // 收尾后清掉 id，下一轮部署创建新 check run，重启 reconcileOrphans 也不会再碰它
    expect(stateService.getBranch('b1')?.githubCheckRunId).toBeUndefined();
  });

  it('run 仍在途（building，心跳新鲜）→ 不触碰', async () => {
    await runs.begin({ projectId: 'p1', branchId: 'b1', trigger: 'webhook' });
    await runner.ensureOpen(branch);
    const n = await runner.reconcileStale({ now: afterGrace() });
    expect(n).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('run 已终结但仍在宽限期内 → 不触碰（不与部署路由自己的 finalize 抢跑）', async () => {
    await runs.begin({ projectId: 'p1', branchId: 'b1', trigger: 'webhook' });
    await runner.ensureOpen(branch);
    runs.fail('dr_stale', {
      code: 'cds.ready.timeout', owner: 'code', retryable: false,
      summary: '就绪超时', phase: 'ready', evidenceRefs: [],
    });
    const n = await runner.reconcileStale({ now: new Date(Date.now() + 60_000) });
    expect(n).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('run 已 running（部署成功但 finalize PATCH 丢失）→ 补收尾为 success', async () => {
    await runs.begin({ projectId: 'p1', branchId: 'b1', trigger: 'webhook' });
    await runner.ensureOpen(branch);
    runs.transition('dr_stale', 'preparing', { phase: 'prepare', message: 'prepare' });
    runs.transition('dr_stale', 'building', { phase: 'build', message: 'build' });
    runs.transition('dr_stale', 'starting', { phase: 'start', message: 'start' });
    runs.transition('dr_stale', 'verifying', { phase: 'verify', message: 'verify' });
    runs.transition('dr_stale', 'running', { phase: 'complete', message: '部署完成' });

    const n = await runner.reconcileStale({ now: afterGrace() });
    expect(n).toBe(1);
    expect(updates[0].payload.conclusion).toBe('success');
    expect(updates[0].payload.output.summary).toContain('回写丢失');
  });

  it('finalize(checkRunId 覆盖): 被取代部署收尾自己的旧 run，不误清新部署盖上的 id（Codex P2）', async () => {
    const run = await runs.begin({ projectId: 'p1', branchId: 'b1', trigger: 'webhook' });
    // 旧部署打开 check run 7（ensureOpen mock 返回 id=7 并落 state）
    await runner.ensureOpen(branch);
    expect(stateService.getBranch('b1')?.githubCheckRunId).toBe(7);
    // 竞态：新部署的 ensureOpen 抢先把 state 上的 id 盖成 8
    stateService.updateBranchGithubMeta('b1', { githubCheckRunId: 8 });
    // 旧部署按显式 id=7 收尾自己的 run
    const latest = stateService.getBranch('b1')!;
    await runner.finalize(latest, {
      conclusion: 'cancelled',
      summary: '部署被更高优先级操作取代',
      checkRunId: 7,
      runId: run.id,
    });
    // PATCH 打在旧 run 7 上，而不是 state 里的新 id 8
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(7);
    expect(updates[0].payload.conclusion).toBe('cancelled');
    // CAS：state 上的 id 是 8（≠7），不得被清——新部署还要用它 finalize
    expect(stateService.getBranch('b1')?.githubCheckRunId).toBe(8);
  });

  it('concludeWithoutDeploy: 部署未启动的失败直接创建已完结的 failure check run，不落 id', async () => {
    let created: any;
    githubApp.createCheckRun = async (_inst: number, _o: string, _r: string, payload: any) => {
      created = payload;
      return { id: 55, url: 'https://api.github.test/checks/55' };
    };
    await runner.concludeWithoutDeploy(branch, {
      conclusion: 'failure',
      title: 'Deploy dispatch failed',
      summary: 'Webhook 部署未启动: 内部部署端点 503',
    });
    expect(created.status).toBe('completed');
    expect(created.conclusion).toBe('failure');
    expect(created.headSha).toBe('1234567890abcdef');
    expect(created.output.summary).toContain('内部部署端点 503');
    // 已完结的 run 不落 id：不需要 finalize，也不能覆盖在途部署的 id
    expect(stateService.getBranch('b1')?.githubCheckRunId).toBeUndefined();
  });

  it('reconcileOrphans: 有关联 DeploymentRun 的分支不灰化（归 stale/收割管道），无 run 的才灰化（Codex P2）', async () => {
    // b1：有关联 run（已 failed）——reconcileOrphans 必须跳过，让 reconcileStale 写红灯
    await runs.begin({ projectId: 'p1', branchId: 'b1', trigger: 'webhook' });
    await runner.ensureOpen(branch);
    runs.fail('dr_stale', {
      code: 'cds.run.interrupted', owner: 'cds', retryable: true,
      summary: '心跳过期', phase: 'build', evidenceRefs: [],
    });
    // b2：无关联 run 的旧式滞留 id——真正的孤儿，允许灰化
    const legacy: BranchEntry = {
      ...branch, id: 'b2', branch: 'feat/legacy', services: {},
      githubCheckRunId: 33, lastDeploymentRunId: undefined,
    };
    stateService.addBranch(legacy);

    await runner.reconcileOrphans();
    // 只有 b2 的 33 被灰化；b1 的 7 原样保留（id 未清、未被 PATCH）
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(33);
    expect(updates[0].payload.conclusion).toBe('neutral');
    expect(stateService.getBranch('b1')?.githubCheckRunId).toBe(7);
    expect(stateService.getBranch('b2')?.githubCheckRunId).toBeUndefined();
    // 启动管道随后的 reconcileStale（宽限 0）把 b1 收成红灯
    const n = await runner.reconcileStale({ terminalGraceMs: 0 });
    expect(n).toBe(1);
    expect(updates[1].id).toBe(7);
    expect(updates[1].payload.conclusion).toBe('failure');
  });

  it('concludeWithoutDeploy: 分支未关联 GitHub（无 repo/sha/installation）→ no-op', async () => {
    let called = 0;
    githubApp.createCheckRun = async () => { called += 1; return { id: 1, url: '' }; };
    const unlinked = { ...branch, id: 'b2', githubRepoFullName: undefined };
    stateService.addBranch(unlinked as any);
    await runner.concludeWithoutDeploy(unlinked as any, {
      conclusion: 'failure', title: 't', summary: 's',
    });
    expect(called).toBe(0);
  });

  it('无关联 run 且分支已终结为 error → 补收尾为 failure；分支仍 building → 不触碰', async () => {
    await runner.ensureOpen(branch); // 无 DeploymentRun（旧式部署）
    // 分支仍 building：不触碰
    let n = await runner.reconcileStale({ now: afterGrace() });
    expect(n).toBe(0);
    // 分支收敛为 error（deploy-stuck-reconciler 的产物）后 → 补收尾
    branch.status = 'error';
    branch.errorMessage = '服务启动失败';
    n = await runner.reconcileStale({ now: afterGrace() });
    expect(n).toBe(1);
    expect(updates[0].payload.conclusion).toBe('failure');
    expect(updates[0].payload.output.summary).toContain('服务启动失败');
  });
});
