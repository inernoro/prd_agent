import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { reconcileStaleDeployDispatches } from '../../src/services/deploy-dispatch-reconciler.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';

describe('reconcileStaleDeployDispatches', () => {
  it('recovers stale dispatch metadata when runtime reached ready after dispatch', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-dispatch-reconcile-ready-'));
    const stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    const now = new Date('2026-05-26T12:30:00.000Z');
    const serverEvents: Array<{
      action: string;
      branchId?: string | null;
      requestId?: string | null;
      operationId?: string | null;
      details?: Record<string, unknown>;
    }> = [];
    const serverEventLogStore: ServerEventLogSink = {
      record(record) {
        serverEvents.push({
          action: record.action,
          branchId: record.branchId,
          requestId: record.requestId,
          operationId: record.operationId,
          details: record.details,
        });
      },
    };

    stateService.addBranch({
      id: 'prd-agent-main',
      projectId: 'prd-agent',
      branch: 'main',
      worktreePath: path.join(tmpDir, 'main'),
      status: 'running',
      createdAt: '2026-05-26T10:00:00.000Z',
      lastDeployAt: '2026-05-26T11:00:00.000Z',
      lastReadyAt: '2026-05-26T12:05:00.000Z',
      lastDeployDispatchAt: '2026-05-26T12:00:00.000Z',
      lastDeployDispatchCommitSha: 'abc123',
      lastDeployDispatchSource: 'webhook',
      lastDeployDispatchStatus: 'dispatching',
      services: {
        api: {
          profileId: 'api',
          containerName: 'cds-prd-agent-main-api',
          hostPort: 10001,
          status: 'running',
        },
      },
    });

    const result = reconcileStaleDeployDispatches(stateService, {
      now,
      staleAfterMinutes: 15,
      source: 'unit-test',
      serverEventLogStore,
    });

    const branch = stateService.getBranch('prd-agent-main')!;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      branchId: 'prd-agent-main',
      previousStatus: 'dispatching',
      nextStatus: 'accepted',
      commitSha: 'abc123',
    });
    expect(branch.lastDeployAt).toBe('2026-05-26T12:05:00.000Z');
    expect(branch.lastDeployDispatchStatus).toBe('accepted');
    expect(branch.lastDeployDispatchError).toBeUndefined();
    expect(stateService.getLogs('prd-agent-main').at(-1)?.status).toBe('completed');
    expect(serverEvents).toHaveLength(1);
    expect(serverEvents[0]).toMatchObject({
      action: 'branch.deploy-dispatch.recovered-ready',
      branchId: 'prd-agent-main',
      requestId: expect.stringMatching(/^reconcile_/),
      operationId: expect.stringMatching(/^op_reconcile_/),
    });
    expect(serverEvents[0].details).toMatchObject({
      requestId: serverEvents[0].requestId,
      operationId: serverEvents[0].operationId,
      actor: 'system:deploy-dispatch-reconciler',
      trigger: 'system',
      previousStatus: 'dispatching',
      nextStatus: 'accepted',
      lastReadyAt: '2026-05-26T12:05:00.000Z',
    });
  });

  it('does not recover a dispatch when any service is still failed after lastReadyAt', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-dispatch-reconcile-partial-ready-'));
    const stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);

    stateService.addBranch({
      id: 'prd-agent-main',
      projectId: 'prd-agent',
      branch: 'main',
      worktreePath: path.join(tmpDir, 'main'),
      status: 'running',
      createdAt: '2026-05-26T10:00:00.000Z',
      lastDeployAt: '2026-05-26T11:00:00.000Z',
      lastReadyAt: '2026-05-26T12:05:00.000Z',
      lastDeployDispatchAt: '2026-05-26T12:00:00.000Z',
      lastDeployDispatchCommitSha: 'abc123',
      lastDeployDispatchSource: 'webhook',
      lastDeployDispatchStatus: 'accepted',
      services: {
        api: {
          profileId: 'api',
          containerName: 'cds-prd-agent-main-api',
          hostPort: 10001,
          status: 'running',
        },
        admin: {
          profileId: 'admin',
          containerName: 'cds-prd-agent-main-admin',
          hostPort: 10002,
          status: 'error',
          errorMessage: '就绪探测超时',
        },
      },
    });

    const result = reconcileStaleDeployDispatches(stateService, {
      now: new Date('2026-05-26T12:30:00.000Z'),
      staleAfterMinutes: 15,
      source: 'unit-test',
    });

    const branch = stateService.getBranch('prd-agent-main')!;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      branchId: 'prd-agent-main',
      previousStatus: 'accepted',
      nextStatus: 'interrupted',
    });
    expect(branch.lastDeployAt).toBe('2026-05-26T11:00:00.000Z');
    expect(branch.lastDeployDispatchStatus).toBe('interrupted');
    expect(branch.lastDeployDispatchError).toContain('stayed accepted');
  });

  it('marks stale dispatching webhook deploy metadata as interrupted without touching containers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-dispatch-reconcile-'));
    const stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    const now = new Date('2026-05-26T12:30:00.000Z');
    const serverEvents: Array<{
      action: string;
      branchId?: string | null;
      requestId?: string | null;
      operationId?: string | null;
      details?: Record<string, unknown>;
    }> = [];
    const serverEventLogStore: ServerEventLogSink = {
      record(record) {
        serverEvents.push({
          action: record.action,
          branchId: record.branchId,
          requestId: record.requestId,
          operationId: record.operationId,
          details: record.details,
        });
      },
    };

    stateService.addBranch({
      id: 'prd-agent-main',
      projectId: 'prd-agent',
      branch: 'main',
      worktreePath: path.join(tmpDir, 'main'),
      status: 'running',
      createdAt: '2026-05-26T10:00:00.000Z',
      lastDeployAt: '2026-05-26T11:00:00.000Z',
      lastDeployDispatchAt: '2026-05-26T12:00:00.000Z',
      lastDeployDispatchCommitSha: 'abc123',
      lastDeployDispatchSource: 'webhook',
      lastDeployDispatchStatus: 'dispatching',
      services: {
        api: {
          profileId: 'api',
          containerName: 'cds-prd-agent-main-api',
          hostPort: 10001,
          status: 'running',
        },
      },
    });

    const result = reconcileStaleDeployDispatches(stateService, {
      now,
      staleAfterMinutes: 15,
      source: 'unit-test',
      serverEventLogStore,
    });

    const branch = stateService.getBranch('prd-agent-main')!;
    expect(result).toHaveLength(1);
    expect(branch.status).toBe('running');
    expect(branch.services.api.status).toBe('running');
    expect(branch.lastDeployDispatchStatus).toBe('interrupted');
    expect(branch.lastDeployDispatchError).toContain('stayed dispatching');
    expect(stateService.getLogs('prd-agent-main').at(-1)?.events[0]?.step).toBe('webhook-dispatch');
    expect(serverEvents).toHaveLength(1);
    expect(serverEvents[0]).toMatchObject({
      action: 'branch.deploy-dispatch.interrupted',
      branchId: 'prd-agent-main',
      requestId: expect.stringMatching(/^reconcile_/),
      operationId: expect.stringMatching(/^op_reconcile_/),
    });
    expect(serverEvents[0].details).toMatchObject({
      requestId: serverEvents[0].requestId,
      operationId: serverEvents[0].operationId,
      actor: 'system:deploy-dispatch-reconciler',
      trigger: 'system',
      previousStatus: 'dispatching',
      nextStatus: 'interrupted',
      lastDeployDispatchCommitSha: 'abc123',
    });
  });

  it('keeps fresh dispatches and dispatches followed by a newer deploy stamp', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-dispatch-reconcile-fresh-'));
    const stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.addBranch({
      id: 'fresh',
      projectId: 'prd-agent',
      branch: 'fresh',
      worktreePath: path.join(tmpDir, 'fresh'),
      status: 'running',
      createdAt: '2026-05-26T10:00:00.000Z',
      lastDeployAt: '2026-05-26T11:00:00.000Z',
      lastDeployDispatchAt: '2026-05-26T12:20:00.000Z',
      lastDeployDispatchStatus: 'dispatching',
      services: {},
    });
    stateService.addBranch({
      id: 'completed',
      projectId: 'prd-agent',
      branch: 'completed',
      worktreePath: path.join(tmpDir, 'completed'),
      status: 'running',
      createdAt: '2026-05-26T10:00:00.000Z',
      lastDeployAt: '2026-05-26T12:10:00.000Z',
      lastDeployDispatchAt: '2026-05-26T12:00:00.000Z',
      lastDeployDispatchStatus: 'accepted',
      services: {},
    });

    const result = reconcileStaleDeployDispatches(stateService, {
      now: new Date('2026-05-26T12:30:00.000Z'),
      staleAfterMinutes: 15,
    });

    expect(result).toHaveLength(0);
    expect(stateService.getBranch('fresh')?.lastDeployDispatchStatus).toBe('dispatching');
    expect(stateService.getBranch('completed')?.lastDeployDispatchStatus).toBe('accepted');
  });

  it('finalizes an orphan running deploy log superseded by a newer successful deploy (anti 疑似卡住)', () => {
    // 复刻 2026-06-29 miduo-backend-master：lastDeployAt(06-24) 晚于派发(06-23)，但 06-23 的
    // webhook-dispatch 日志永远停在 running，被前端误报「疑似卡住 ≥1h」。收敛器应 finalize 它。
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-dispatch-reconcile-orphan-'));
    const stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    const now = new Date('2026-06-29T00:00:00.000Z');

    stateService.addBranch({
      id: 'miduo-backend-master',
      projectId: 'miduo-backend',
      branch: 'master',
      worktreePath: path.join(tmpDir, 'master'),
      status: 'running',
      createdAt: '2026-06-23T11:00:00.000Z',
      lastDeployAt: '2026-06-24T01:35:07.333Z',
      lastReadyAt: '2026-06-24T01:35:05.174Z',
      lastDeployDispatchAt: '2026-06-23T11:09:38.458Z',
      lastDeployDispatchStatus: 'accepted',
      services: {
        api: { profileId: 'api', containerName: 'cds-x-api', hostPort: 32781, status: 'running' },
      },
    });
    // 孤儿：webhook-dispatch 永远停在 running，startedAt 早于 lastDeployAt
    stateService.appendLog('miduo-backend-master', {
      type: 'build',
      startedAt: '2026-06-23T11:09:01.343Z',
      status: 'running',
      events: [{ step: 'webhook-dispatch', status: 'running', title: 'Webhook 正在派发部署请求', timestamp: '2026-06-23T11:09:01.343Z' }],
    });
    // 真实完成的部署日志（必须保持不变）
    stateService.appendLog('miduo-backend-master', {
      type: 'build',
      startedAt: '2026-06-24T01:27:08.542Z',
      finishedAt: '2026-06-24T01:35:05.174Z',
      status: 'completed',
      events: [{ step: 'runtime-ready', status: 'done', title: '运行时已通过就绪探测', timestamp: '2026-06-24T01:35:05.174Z' }],
    });

    reconcileStaleDeployDispatches(stateService, { now, source: 'unit-test' });

    const logs = stateService.getLogs('miduo-backend-master');
    const orphan = logs.find((l) => l.startedAt === '2026-06-23T11:09:01.343Z')!;
    expect(orphan.status).toBe('completed');
    expect(orphan.finishedAt).toBe(now.toISOString());
    const real = logs.find((l) => l.startedAt === '2026-06-24T01:27:08.542Z')!;
    expect(real.status).toBe('completed');
    expect(real.finishedAt).toBe('2026-06-24T01:35:05.174Z');
  });

  it('does not finalize a genuinely-running deploy started after lastDeployAt', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-dispatch-reconcile-live-'));
    const stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    const now = new Date('2026-06-29T00:00:00.000Z');
    stateService.addBranch({
      id: 'b',
      projectId: 'p',
      branch: 'main',
      worktreePath: path.join(tmpDir, 'b'),
      status: 'running',
      createdAt: '2026-06-23T11:00:00.000Z',
      lastDeployAt: '2026-06-23T11:00:00.000Z',
      lastDeployDispatchAt: '2026-06-22T10:00:00.000Z',
      lastDeployDispatchStatus: 'accepted',
      services: { api: { profileId: 'api', containerName: 'c', hostPort: 1, status: 'running' } },
    });
    // 真正进行中的部署：startedAt 晚于 lastDeployAt → 不应被 finalize
    stateService.appendLog('b', {
      type: 'build',
      startedAt: '2026-06-23T12:00:00.000Z',
      status: 'running',
      events: [{ step: 'pull', status: 'running', title: '拉取', timestamp: '2026-06-23T12:00:00.000Z' }],
    });
    reconcileStaleDeployDispatches(stateService, { now, source: 'unit-test' });
    const live = stateService.getLogs('b').find((l) => l.startedAt === '2026-06-23T12:00:00.000Z')!;
    expect(live.status).toBe('running');
  });
});
