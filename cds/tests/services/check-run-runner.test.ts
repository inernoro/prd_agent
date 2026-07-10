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

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses runId for check correlation and projects structured failure events', async () => {
    const runs = new DeploymentRunService(stateService, { idFactory: () => 'dr_check' });
    runs.begin({ projectId: 'p1', branchId: 'b1', trigger: 'webhook' });

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
