import { describe, expect, it } from 'vitest';
import { BranchOperationCoordinator, BranchOperationSupersededError } from '../../src/services/branch-operation-coordinator.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';

function eventSink(): { sink: ServerEventLogSink; records: Array<{ action: string; operationId?: string | null; details?: Record<string, unknown> }> } {
  const records: Array<{ action: string; operationId?: string | null; details?: Record<string, unknown> }> = [];
  return {
    records,
    sink: {
      record(record) {
        records.push({ action: record.action, operationId: record.operationId, details: record.details });
      },
    },
  };
}

describe('BranchOperationCoordinator', () => {
  it('records queryable lifecycle events with top-level operationId', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const active = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'force-rebuild',
      trigger: 'manual',
      actor: 'user',
      profileId: 'api',
      continueWith: 'deploy-profile',
    });
    coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '2222222',
    });
    coordinator.complete(active.lease!, 'completed');
    const continuation = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy-profile',
      trigger: 'manual',
      actor: 'user',
      profileId: 'api',
    });
    const repeated = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy-profile',
      trigger: 'manual',
      actor: 'user',
      profileId: 'api',
    });
    coordinator.complete(continuation.lease!, 'completed');

    expect(repeated.status).toBe('rejected');
    expect(records.map((record) => record.action)).toEqual(expect.arrayContaining([
      'branch.operation.started',
      'branch.operation.merged',
      'branch.operation.completed',
      'branch.operation.queued',
      'branch.operation.continued',
      'branch.operation.rejected',
    ]));
    for (const record of records) {
      expect(record.operationId).toMatch(/^op_/);
    }
  });

  it('starts one operation per branch and rejects a concurrent manual deploy', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const first = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'user',
    });
    const second = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'user',
    });

    expect(first.status).toBe('started');
    expect(second.status).toBe('rejected');
    expect(second.activeOperationId).toBe(first.operationId);
    expect(records[0].operationId).toBe(first.operationId);
    expect(records.map((r) => r.action)).toEqual([
      'branch.operation.started',
      'branch.operation.rejected',
    ]);
  });

  it('merges concurrent webhook deploys to the latest pending commit', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const active = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '1111111',
    });
    const mergedA = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '2222222',
    });
    const mergedB = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '3333333',
    });

    expect(active.status).toBe('started');
    expect(mergedA.status).toBe('merged');
    expect(mergedB.status).toBe('merged');
    expect(coordinator.getPendingWebhookDeploy('prd-agent-main')?.request.commitSha).toBe('3333333');
    expect(records.filter((r) => r.action === 'branch.operation.merged')).toHaveLength(2);
  });

  it('manual delete cancels an active webhook deploy and fences the old lease', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const active = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '1111111',
    });
    expect(active.lease).toBeDefined();

    const decision = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'delete',
      trigger: 'manual',
      actor: 'user',
    });

    expect(decision.status).toBe('started');
    expect(decision.operationId).not.toBe(active.operationId);
    expect(active.lease?.isCurrent()).toBe(false);
    expect(() => active.lease?.assertCurrent('before-state-save')).toThrow(BranchOperationSupersededError);
    expect(records.map((r) => r.action)).toContain('branch.operation.cancelled');
  });

  it('manual delete cancels an active manual deploy so the deploy cannot later save state', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const deploy = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'user-a',
    });

    const del = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'delete',
      trigger: 'manual',
      actor: 'user-b',
    });

    expect(del.status).toBe('started');
    expect(deploy.lease?.isCurrent()).toBe(false);
    expect(() => deploy.lease?.assertCurrent('before-final-save')).toThrow(BranchOperationSupersededError);
    expect(records.find((r) => r.action === 'branch.operation.cancelled')?.operationId).toBe(deploy.operationId);
    expect(records.at(-1)?.operationId).toBe(del.operationId);
  });

  it('complete returns and clears a pending webhook deploy', () => {
    const coordinator = new BranchOperationCoordinator();
    const active = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '1111111',
    });
    coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '2222222',
    });

    const pending = coordinator.complete(active.lease!, 'completed');

    expect(pending?.request.commitSha).toBe('2222222');
    expect(coordinator.getActive('prd-agent-main')).toBeUndefined();
    expect(coordinator.getPendingWebhookDeploy('prd-agent-main')).toBeUndefined();
  });

  it('manual stop clears queued webhook deploys so stopped branches do not silently restart', () => {
    const coordinator = new BranchOperationCoordinator();
    const active = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '1111111',
    });
    coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '2222222',
    });

    const stop = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'stop',
      trigger: 'manual',
      actor: 'user',
    });

    expect(stop.status).toBe('started');
    expect(active.lease?.isCurrent()).toBe(false);
    expect(coordinator.getPendingWebhookDeploy('prd-agent-main')).toBeUndefined();
  });

  it('cleanup-damaged yields to an active webhook deploy instead of killing an in-flight build', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const active = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '1111111',
    });

    const cleanup = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'cleanup-damaged',
      trigger: 'manual',
      actor: 'user',
    });

    expect(cleanup.status).toBe('rejected');
    expect(coordinator.getActive('prd-agent-main')?.operationId).toBe(active.operationId);
    expect(active.lease?.isCurrent()).toBe(true);
    expect(records.map((r) => r.action)).toContain('branch.operation.rejected');
  });

  it('auto-restart yields to an active webhook deploy instead of starting a stale container', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const active = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '1111111',
    });

    const restart = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'auto-restart',
      trigger: 'system',
      actor: 'auto-restart',
      profileId: 'api',
      source: 'auto-restart.tick',
      reason: 'docker container is stopped while state says running',
    });

    expect(restart.status).toBe('rejected');
    expect(restart.activeOperationId).toBe(active.operationId);
    expect(coordinator.getActive('prd-agent-main')?.operationId).toBe(active.operationId);
    expect(records.map((r) => r.action)).toContain('branch.operation.rejected');
  });

  it('manual delete cancels an active auto-restart and fences its final state write', () => {
    const coordinator = new BranchOperationCoordinator();
    const restart = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'auto-restart',
      trigger: 'system',
      actor: 'auto-restart',
      profileId: 'api',
      source: 'auto-restart.tick',
    });

    const del = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'delete',
      trigger: 'manual',
      actor: 'user',
    });

    expect(del.status).toBe('started');
    expect(restart.lease?.isCurrent()).toBe(false);
    expect(() => restart.lease?.assertCurrent('after-docker-start')).toThrow(BranchOperationSupersededError);
  });

  it('serializes per branch without blocking other branches', () => {
    const coordinator = new BranchOperationCoordinator();
    const a = coordinator.begin({
      branchId: 'prd-agent-a',
      kind: 'deploy',
      trigger: 'manual',
    });
    const b = coordinator.begin({
      branchId: 'prd-agent-b',
      kind: 'deploy',
      trigger: 'manual',
    });

    expect(a.status).toBe('started');
    expect(b.status).toBe('started');
    expect(a.operationId).not.toBe(b.operationId);
  });

  it('reserves the same operationId for force-rebuild deploy continuation', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const force = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'force-rebuild',
      trigger: 'manual',
      actor: 'user',
      profileId: 'api',
      continueWith: 'deploy-profile',
    });

    const pending = coordinator.complete(force.lease!, 'completed');
    const deploy = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy-profile',
      trigger: 'manual',
      actor: 'user',
      profileId: 'api',
    });

    expect(pending).toBeNull();
    expect(deploy.status).toBe('started');
    expect(deploy.operationId).toBe(force.operationId);
    expect(deploy.generation).not.toBe(force.generation);
    expect(records.map((r) => r.action)).toContain('branch.operation.queued');
    expect(records.map((r) => r.action)).toContain('branch.operation.continued');
  });

  it('rejects repeated force-rebuild clicks while the same branch is rebuilding', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const first = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'force-rebuild',
      trigger: 'manual',
      actor: 'user',
      profileId: 'api',
      continueWith: 'deploy-profile',
    });
    const second = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'force-rebuild',
      trigger: 'manual',
      actor: 'user',
      profileId: 'api',
      continueWith: 'deploy-profile',
    });

    expect(first.status).toBe('started');
    expect(second.status).toBe('rejected');
    expect(second.activeOperationId).toBe(first.operationId);
    expect(records.map((r) => r.action)).toEqual([
      'branch.operation.started',
      'branch.operation.rejected',
    ]);
  });

  it('merges webhook deploys while force-rebuild waits for its manual deploy continuation', () => {
    const coordinator = new BranchOperationCoordinator();
    const force = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'force-rebuild',
      trigger: 'manual',
      actor: 'user',
      profileId: 'api',
      continueWith: 'deploy-profile',
    });
    coordinator.complete(force.lease!, 'completed');

    const webhook = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '2222222',
    });
    const deploy = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy-profile',
      trigger: 'manual',
      actor: 'user',
      profileId: 'api',
    });
    const pending = coordinator.complete(deploy.lease!, 'completed');

    expect(webhook.status).toBe('merged');
    expect(deploy.operationId).toBe(force.operationId);
    expect(pending?.request.commitSha).toBe('2222222');
  });

  it('manual delete cancels a reserved force-rebuild continuation and its pending webhook', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const force = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'force-rebuild',
      trigger: 'manual',
      actor: 'user',
      profileId: 'api',
      continueWith: 'deploy-profile',
    });
    coordinator.complete(force.lease!, 'completed');
    coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '2222222',
    });

    const del = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'delete',
      trigger: 'manual',
      actor: 'user',
    });

    expect(del.status).toBe('started');
    expect(coordinator.getPendingWebhookDeploy('prd-agent-main')).toBeUndefined();
    expect(records.filter((r) => r.action === 'branch.operation.cancelled').length).toBeGreaterThanOrEqual(1);
  });

  it('records active and pending operations as interrupted when CDS restarts', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const active = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      actor: 'system:webhook',
      requestId: 'req-1',
      commitSha: '1111111',
      source: 'api.deploy-branch',
    });
    const pending = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      actor: 'system:webhook',
      requestId: 'req-2',
      commitSha: '2222222',
      source: 'api.deploy-branch',
    });

    coordinator.interruptAll('CDS self-update is restarting the process', 'api.self-update');

    const interrupted = records.filter((record) => record.action === 'branch.operation.interrupted');
    expect(pending.status).toBe('merged');
    expect(interrupted).toHaveLength(2);
    expect(interrupted.map((record) => record.operationId)).toEqual(expect.arrayContaining([
      active.operationId,
      pending.operationId,
    ]));
    expect(interrupted.every((record) => record.details?.source === 'api.self-update')).toBe(true);
    expect(interrupted.find((record) => record.operationId === pending.operationId)?.details?.pending).toBe(true);
  });
});
