import { describe, expect, it } from 'vitest';
import { BranchOperationCoordinator, BranchOperationSupersededError } from '../../src/services/branch-operation-coordinator.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';

function eventSink(): {
  sink: ServerEventLogSink;
  records: Array<{
    action: string;
    operationId?: string | null;
    operationKind?: string | null;
    operationTrigger?: string | null;
    operationActor?: string | null;
    operationSource?: string | null;
    commitSha?: string | null;
    details?: Record<string, unknown>;
  }>;
} {
  const records: Array<{
    action: string;
    operationId?: string | null;
    operationKind?: string | null;
    operationTrigger?: string | null;
    operationActor?: string | null;
    operationSource?: string | null;
    commitSha?: string | null;
    details?: Record<string, unknown>;
  }> = [];
  return {
    records,
    sink: {
      record(record) {
        records.push({
          action: record.action,
          operationId: record.operationId,
          operationKind: record.operationKind,
          operationTrigger: record.operationTrigger,
          operationActor: record.operationActor,
          operationSource: record.operationSource,
          commitSha: record.commitSha,
          details: record.details,
        });
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
      expect(record.operationKind).toMatch(/deploy|force-rebuild/);
      expect(record.operationTrigger).toMatch(/manual|webhook/);
    }
    const merged = records.find((record) => record.action === 'branch.operation.merged');
    expect(merged).toMatchObject({
      operationTrigger: 'webhook',
      commitSha: '2222222',
    });
  });

  it('starts one operation per branch and merges a concurrent manual deploy', () => {
    // 2026-07-16 起：manual 整分支 deploy 撞车不再 409，而是合并为最新待部署
    // 请求（治重试风暴，见 isMergeableManualDeploy）。
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
    expect(second.status).toBe('merged');
    expect(second.activeOperationId).toBe(first.operationId);
    expect(records[0].operationId).toBe(first.operationId);
    expect(records.map((r) => r.action)).toEqual([
      'branch.operation.started',
      'branch.operation.merged',
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
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
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
    const cancelled = records.filter((r) => r.action === 'branch.operation.cancelled');
    expect(cancelled).toHaveLength(2);
    expect(cancelled.some((r) => r.operationId === active.operationId && r.details?.pending !== true)).toBe(true);
    expect(cancelled.some((r) => r.details?.pending === true && r.details?.reason === 'superseded by stop')).toBe(true);
  });

  it('webhook stop from PR close cancels active and queued webhook deploys', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const active = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '1111111',
      source: 'github-webhook.push',
    });
    coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: '2222222',
      source: 'github-webhook.push',
    });

    const stop = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'stop',
      trigger: 'webhook',
      actor: 'system:webhook',
      source: 'github-webhook.pr-close',
      reason: 'PR closed; stop preview',
    });

    expect(stop.status).toBe('started');
    expect(active.lease?.isCurrent()).toBe(false);
    expect(coordinator.getPendingWebhookDeploy('prd-agent-main')).toBeUndefined();
    const cancelled = records.filter((r) => r.action === 'branch.operation.cancelled');
    expect(cancelled.some((r) => r.operationId === active.operationId && r.details?.pending !== true)).toBe(true);
    expect(cancelled.some((r) => r.details?.pending === true && r.details?.reason === 'superseded by stop')).toBe(true);
    expect(records.at(-1)).toMatchObject({
      action: 'branch.operation.started',
      operationKind: 'stop',
      operationTrigger: 'webhook',
    });
  });

  it('webhook stop yields to an active manual deploy', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const manual = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'user',
      source: 'api.deploy-branch',
    });

    const stop = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'stop',
      trigger: 'webhook',
      actor: 'system:webhook',
      source: 'github-webhook.pr-close',
      reason: 'PR closed; stop preview',
    });

    expect(stop.status).toBe('rejected');
    expect(stop.activeOperationId).toBe(manual.operationId);
    expect(manual.lease?.isCurrent()).toBe(true);
    expect(records.find((r) => r.action === 'branch.operation.rejected')).toMatchObject({
      operationKind: 'stop',
      operationTrigger: 'webhook',
    });
  });

  it('manual reset is a terminal operation that fences active and queued webhook deploys', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
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

    const reset = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'reset',
      trigger: 'manual',
      actor: 'user',
      source: 'api.reset-branch',
    });

    expect(reset.status).toBe('started');
    expect(active.lease?.isCurrent()).toBe(false);
    expect(coordinator.getPendingWebhookDeploy('prd-agent-main')).toBeUndefined();
    const cancelled = records.filter((r) => r.action === 'branch.operation.cancelled');
    expect(cancelled.some((r) => r.operationId === active.operationId && r.details?.pending !== true)).toBe(true);
    expect(cancelled.some((r) => r.details?.pending === true && r.details?.reason === 'superseded by reset')).toBe(true);
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

  it('manual delete cancels an active auto-lifecycle redeploy override write', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const auto = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'auto-lifecycle-redeploy',
      trigger: 'auto-lifecycle',
      actor: 'auto-lifecycle',
      source: 'autoLifecycleService.applyAutoPublish',
    });

    const del = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'delete',
      trigger: 'manual',
      actor: 'user',
    });

    expect(del.status).toBe('started');
    expect(auto.lease?.isCurrent()).toBe(false);
    expect(() => auto.lease?.assertCurrent('auto-publish after override write')).toThrow(BranchOperationSupersededError);
    expect(records.find((r) => r.action === 'branch.operation.cancelled')?.operationId).toBe(auto.operationId);
  });

  it('auto-lifecycle redeploy yields to an active manual deploy instead of rewriting state', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const manual = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'user',
    });

    const auto = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'auto-lifecycle-redeploy',
      trigger: 'auto-lifecycle',
      actor: 'auto-lifecycle',
      source: 'autoLifecycleService.applyAutoPublish',
    });

    expect(auto.status).toBe('rejected');
    expect(auto.activeOperationId).toBe(manual.operationId);
    expect(coordinator.getActive('prd-agent-main')?.operationId).toBe(manual.operationId);
    expect(records.map((r) => r.action)).toContain('branch.operation.rejected');
  });

  it('scheduler cooling yields to active manual operations and cannot overwrite them', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const manual = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'restart',
      trigger: 'manual',
      actor: 'user',
      source: 'api.restart-branch',
    });

    const cooling = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'scheduler-cooling',
      trigger: 'scheduler',
      actor: 'scheduler',
      source: 'scheduler.coolIdleBranch',
      reason: 'idle timeout',
    });

    expect(manual.status).toBe('started');
    expect(cooling.status).toBe('rejected');
    expect(cooling.activeOperationId).toBe(manual.operationId);
    expect(coordinator.getActive('prd-agent-main')?.operationId).toBe(manual.operationId);
    const rejected = records.find((r) => r.action === 'branch.operation.rejected');
    expect(rejected?.details).toMatchObject({
      kind: 'scheduler-cooling',
      trigger: 'scheduler',
      activeOperationId: manual.operationId,
      activeKind: 'restart',
    });
  });

  it('manual delete cancels active janitor removal so final writes are fenced', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const janitor = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'janitor-remove',
      trigger: 'janitor',
      actor: 'janitor',
      source: 'janitor.removeStaleBranch',
      reason: 'stale branch cleanup',
    });

    const del = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'delete',
      trigger: 'manual',
      actor: 'user',
      source: 'api.delete-branch',
    });

    expect(janitor.status).toBe('started');
    expect(del.status).toBe('started');
    expect(janitor.lease?.isCurrent()).toBe(false);
    expect(() => janitor.lease?.assertCurrent('janitor final state write')).toThrow(BranchOperationSupersededError);
    expect(records.find((r) => r.action === 'branch.operation.cancelled')?.operationId).toBe(janitor.operationId);
    expect(records.at(-1)?.operationId).toBe(del.operationId);
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

  it('serializes per branch/profile without blocking another profile on the same branch', () => {
    const coordinator = new BranchOperationCoordinator();
    const api = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy-profile',
      trigger: 'manual',
      profileId: 'api',
    });
    const admin = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy-profile',
      trigger: 'manual',
      profileId: 'admin',
    });
    const apiAgain = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy-profile',
      trigger: 'manual',
      profileId: 'api',
    });

    expect(api.status).toBe('started');
    expect(admin.status).toBe('started');
    expect(api.operationId).not.toBe(admin.operationId);
    expect(apiAgain.status).toBe('rejected');
    expect(apiAgain.activeOperationId).toBe(api.operationId);
  });

  it('branch-wide delete cancels all active profile operations on that branch', () => {
    const { sink, records } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const api = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy-profile',
      trigger: 'manual',
      profileId: 'api',
    });
    const admin = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy-profile',
      trigger: 'manual',
      profileId: 'admin',
    });

    const del = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'delete',
      trigger: 'manual',
      actor: 'user',
    });

    expect(del.status).toBe('started');
    expect(api.lease?.isCurrent()).toBe(false);
    expect(admin.lease?.isCurrent()).toBe(false);
    expect(records.filter((r) => r.action === 'branch.operation.cancelled')).toHaveLength(2);
  });

  it('reserved force-rebuild continuation only blocks the same profile or branch-wide operations', () => {
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

    const admin = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy-profile',
      trigger: 'manual',
      actor: 'user',
      profileId: 'admin',
    });
    const branchDeploy = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'user',
    });

    expect(admin.status).toBe('started');
    // 2026-07-16 起：manual 整分支 deploy 被在途操作挡住时合并为 pending
    // （admin 单服务部署完成后自动派发），不再 409。
    expect(branchDeploy.status).toBe('merged');
    expect([force.operationId, admin.operationId]).toContain(branchDeploy.activeOperationId);
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

  it('续约保留期间 manual 整分支 deploy 合并为 pending 而非拒绝——重放撞续约不得静默丢弃（Codex P2）', () => {
    const coordinator = new BranchOperationCoordinator();
    // 完整事故时序：profile B 在途 → manual 整分支 deploy 合并（用户被告知已排队）
    const profileB = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy-profile',
      trigger: 'manual',
      actor: 'user',
      profileId: 'web',
    });
    const merged = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'agent-a',
    });
    expect(merged.status).toBe('merged');

    // 与 B 并行的 profile A force-rebuild 完成，保留 deploy-profile 续约
    const force = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'force-rebuild',
      trigger: 'manual',
      actor: 'user',
      profileId: 'api',
      continueWith: 'deploy-profile',
    });
    expect(force.status).toBe('started');
    coordinator.complete(force.lease!, 'completed');

    // B 完成 → complete() 弹出 pending 交给路由内部重放
    const pending = coordinator.complete(profileB.lease!, 'completed');
    expect(pending?.request.kind).toBe('deploy');

    // 重放的整分支 deploy 与 deploy-profile 续约不匹配：修复前这里 rejected，
    // pending 已被弹出 → 请求静默丢失；现在应重新合并回 pending 等续约消费后派发
    const replay = coordinator.begin(pending!.request);
    expect(replay.status).toBe('merged');

    // force-rebuild 自己的续约 deploy-profile 仍优先接续（不被合并吞掉）
    const continuation = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy-profile',
      trigger: 'manual',
      actor: 'user',
      profileId: 'api',
    });
    expect(continuation.status).toBe('started');
    expect(continuation.operationId).toBe(force.operationId);

    // 续约操作完成后，重新合并的 pending 被弹出派发，承诺闭环
    const redispatched = coordinator.complete(continuation.lease!, 'completed');
    expect(redispatched?.request.kind).toBe('deploy');
    expect(redispatched?.request.trigger).toBe('manual');
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
    const cancelled = records.filter((r) => r.action === 'branch.operation.cancelled');
    expect(cancelled.length).toBeGreaterThanOrEqual(2);
    expect(cancelled.some((r) => r.operationId === force.operationId && r.details?.reserved === true)).toBe(true);
    expect(cancelled.some((r) => r.details?.pending === true && r.details?.reason === 'reserved continuation superseded by delete')).toBe(true);
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

  it('can list all active operations so restart gates can detect terminal work', () => {
    const { sink } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const deploy = coordinator.begin({
      branchId: 'prd-agent-main',
      profileId: 'api',
      kind: 'deploy-profile',
      trigger: 'manual',
      actor: 'user',
      source: 'api.deploy-profile',
    });
    const del = coordinator.begin({
      branchId: 'prd-agent-feature',
      kind: 'delete',
      trigger: 'manual',
      actor: 'user',
      requestId: 'delete-1',
      source: 'api.delete-branch',
    });

    expect(coordinator.getActiveOperations('prd-agent-main').map((op) => op.operationId)).toEqual([deploy.operationId]);
    expect(coordinator.getActiveOperations().map((op) => op.operationId)).toEqual(expect.arrayContaining([
      deploy.operationId,
      del.operationId,
    ]));
    expect(coordinator.getActiveOperations().find((op) => op.request.kind === 'delete')?.request.requestId).toBe('delete-1');
  });

  it('manual restart is fenced like other branch-wide startup writes', () => {
    const { records, sink } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const restart = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'restart',
      trigger: 'manual',
      actor: 'user',
      source: 'api.restart-branch',
    });
    const deployProfile = coordinator.begin({
      branchId: 'prd-agent-main',
      profileId: 'api',
      kind: 'deploy-profile',
      trigger: 'manual',
      actor: 'user',
      source: 'api.deploy-profile',
    });

    expect(restart.status).toBe('started');
    expect(deployProfile.status).toBe('rejected');
    expect(deployProfile.activeOperationId).toBe(restart.operationId);
    expect(records.find((record) => record.action === 'branch.operation.rejected')?.details?.activeKind).toBe('restart');
  });

  // ── 2026-07-16 队列堵死复盘：manual 整分支 deploy 合并去重 ──

  it('manual deploy 撞上在途 manual deploy 时合并为 pending（不再 409），complete 后可派发', () => {
    const { sink } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const first = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'agent-a',
      commitSha: '1111111',
    });
    expect(first.status).toBe('started');

    const retry = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'agent-a',
      commitSha: '2222222',
    });
    expect(retry.status).toBe('merged');
    expect(retry.pendingCommitSha).toBe('2222222');

    const pending = coordinator.complete(first.lease!, 'completed');
    expect(pending).not.toBeNull();
    expect(pending!.request.trigger).toBe('manual');
    expect(pending!.request.commitSha).toBe('2222222');
  });

  it('manual 与 webhook 合并共享同一 pending，last-writer-wins 且 mergedCount 累计', () => {
    const { sink } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const active = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'agent-a',
    });
    const webhookMerge = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'webhook',
      commitSha: 'aaaaaaa',
    });
    expect(webhookMerge.status).toBe('merged');
    const manualMerge = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'agent-b',
      commitSha: 'bbbbbbb',
    });
    expect(manualMerge.status).toBe('merged');

    const pending = coordinator.complete(active.lease!, 'completed');
    expect(pending!.mergedCount).toBe(2);
    expect(pending!.request.trigger).toBe('manual');
    expect(pending!.request.commitSha).toBe('bbbbbbb');
  });

  it('manual deploy-profile 撞车仍 409（单服务合并语义不明确，维持拒绝）', () => {
    const { sink } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'user',
    });
    const profileRetry = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy-profile',
      profileId: 'api',
      trigger: 'manual',
      actor: 'user',
    });
    expect(profileRetry.status).toBe('rejected');
  });

  it('stop 在途时 manual deploy 维持 409——不得合并后在停止完成时自动重启（Codex P2）', () => {
    const { sink } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const stop = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'stop',
      trigger: 'manual',
      actor: 'operator',
    });
    expect(stop.status).toBe('started');

    const deployDuringStop = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'agent-a',
    });
    expect(deployDuringStop.status).toBe('rejected');

    // stop 完成后不派发任何 pending：分支保持停止，不被自动重启
    const pending = coordinator.complete(stop.lease!, 'completed');
    expect(pending).toBeNull();
  });

  it('带 versionId 的版本重部署撞车维持 409——pending 重放会丢版本捕获配置（Codex P2）', () => {
    const { sink } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'agent-a',
    });
    const versionRedeploy = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'operator',
      versionId: 'dv_123',
    });
    expect(versionRedeploy.status).toBe('rejected');
  });

  it('带一次性选项（force/ignoreRequired/targetExecutorId）的 manual deploy 撞车维持 409——pending 重放会丢选项（Codex P2）', () => {
    const { sink } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'agent-a',
    });
    // ?force=1 绕过项目暂停闸门：重放不带 force 会被暂停闸门直接拦下
    const forcedDeploy = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'operator',
      hasOneShotOptions: true,
    });
    expect(forcedDeploy.status).toBe('rejected');

    // 对照：不带一次性选项的普通 manual deploy 仍走合并通道
    const plainDeploy = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'operator',
    });
    expect(plainDeploy.status).toBe('merged');
  });

  it('manual stop 仍按优先级 supersede 在途 deploy，并取消已合并的 pending', () => {
    const { sink } = eventSink();
    const coordinator = new BranchOperationCoordinator(sink);
    const deploy = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'user',
    });
    const merged = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'deploy',
      trigger: 'manual',
      actor: 'user',
      commitSha: 'ccccccc',
    });
    expect(merged.status).toBe('merged');

    const stop = coordinator.begin({
      branchId: 'prd-agent-main',
      kind: 'stop',
      trigger: 'manual',
      actor: 'user',
    });
    expect(stop.status).toBe('started');
    expect(deploy.lease!.isCurrent()).toBe(false);
    // stop supersede 已把 pending 取消：stop 完成后不应再派发被合并的 deploy
    const pendingAfterStop = coordinator.complete(stop.lease!, 'completed');
    expect(pendingAfterStop).toBeNull();
  });
});
