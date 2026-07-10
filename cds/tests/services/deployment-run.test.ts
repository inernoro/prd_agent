import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { StateService } from '../../src/services/state.js';

describe('DeploymentRunService', () => {
  let stateFile: string;
  let stateService: StateService;
  let clock: Date;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-deployment-run-'));
    stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as any);
    stateService.addBranch({
      id: 'b1',
      projectId: 'p1',
      branch: 'feat/run-ledger',
      worktreePath: '/tmp/b1',
      services: {},
      status: 'idle',
      createdAt: '2026-07-10T00:00:00.000Z',
    });
    clock = new Date('2026-07-10T01:00:00.000Z');
  });

  afterEach(async () => {
    await stateService.flush();
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function createService(maxEvents = 500): DeploymentRunService {
    return new DeploymentRunService(stateService, {
      now: () => new Date(clock),
      idFactory: () => 'dr_test',
      maxEvents,
    });
  }

  it('persists the run before execution and links it from the branch', async () => {
    const service = createService();
    const run = await service.begin({
      projectId: 'p1',
      branchId: 'b1',
      trigger: 'webhook',
      commitSha: 'abc123',
    });

    expect(run.status).toBe('pending');
    expect(run.seq).toBe(1);
    expect(run.events[0].status).toBe('pending');
    expect(stateService.getBranch('b1')?.lastDeploymentRunId).toBe('dr_test');

    const reloadedState = new StateService(stateFile);
    reloadedState.load();
    expect(reloadedState.getDeploymentRun('dr_test')?.commitSha).toBe('abc123');
    expect(reloadedState.getBranch('b1')?.lastDeploymentRunId).toBe('dr_test');
  });

  it('enforces legal transitions and keeps terminal runs immutable', async () => {
    const service = createService();
    await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'manual' });
    service.transition('dr_test', 'preparing', { phase: 'pull', message: '正在准备源码' });
    service.transition('dr_test', 'building', { phase: 'build', message: '正在构建' });
    service.transition('dr_test', 'starting', { phase: 'start', message: '正在启动' });
    service.transition('dr_test', 'verifying', { phase: 'ready', message: '正在验证' });
    const completed = service.transition('dr_test', 'running', { phase: 'complete', message: '部署完成' });

    expect(completed.status).toBe('running');
    expect(completed.finishedAt).toBeTruthy();
    expect(completed.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(() => service.append('dr_test', {
      phase: 'late', level: 'info', status: 'done', message: '不应追加',
    })).toThrow(/terminal/);
  });

  it('rejects skipped states that would make the ledger ambiguous', async () => {
    const service = createService();
    await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'manual' });
    expect(() => service.transition('dr_test', 'running', {
      phase: 'complete',
      message: '跳过全部阶段',
    })).toThrow(/pending -> running/);
  });

  it('supports afterSeq resume and reports a truncated event window', async () => {
    const service = createService(3);
    await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'manual' });
    service.append('dr_test', { phase: 'one', level: 'info', status: 'running', message: 'one' });
    service.append('dr_test', { phase: 'two', level: 'info', status: 'running', message: 'two' });
    service.append('dr_test', { phase: 'three', level: 'info', status: 'running', message: 'three' });

    const run = service.get('dr_test')!;
    expect(run.seq).toBe(4);
    expect(run.firstEventSeq).toBe(2);
    expect(service.getEventsAfter('dr_test', 2).events.map((event) => event.seq)).toEqual([3, 4]);
    expect(service.getEventsAfter('dr_test', 0).truncated).toBe(true);
  });

  it('reconciles stale non-terminal runs to a structured failure', async () => {
    const service = createService();
    await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'system' });
    service.transition('dr_test', 'preparing', { phase: 'pull', message: '正在准备' });
    clock = new Date('2026-07-10T01:20:01.000Z');

    const reconciled = service.reconcileInterrupted(clock, 20 * 60 * 1000);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].status).toBe('failed');
    expect(reconciled[0].failure).toMatchObject({
      code: 'cds.run.interrupted',
      owner: 'cds',
      retryable: true,
    });
  });

  it('refuses a project and branch mismatch', async () => {
    const service = createService();
    await expect(service.begin({
      projectId: 'other',
      branchId: 'b1',
      trigger: 'manual',
    })).rejects.toThrow(/project mismatch/);
  });
});
