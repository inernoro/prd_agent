import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { reconcileStaleDeployDispatches } from '../../src/services/deploy-dispatch-reconciler.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';

describe('reconcileStaleDeployDispatches', () => {
  it('marks stale dispatching webhook deploy metadata as interrupted without touching containers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-dispatch-reconcile-'));
    const stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    const now = new Date('2026-05-26T12:30:00.000Z');
    const serverEvents: Array<{ action: string; branchId?: string | null; details?: Record<string, unknown> }> = [];
    const serverEventLogStore: ServerEventLogSink = {
      record(record) {
        serverEvents.push({ action: record.action, branchId: record.branchId, details: record.details });
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
    });
    expect(serverEvents[0].details).toMatchObject({
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
});
