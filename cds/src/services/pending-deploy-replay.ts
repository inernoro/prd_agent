import { observePendingDeployDispatch } from './pending-deploy-dispatch.js';
import type { StateService } from './state.js';
import type { BranchOperationCoordinator, PendingWebhookDeploy } from './branch-operation-coordinator.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import type { CdsConfig } from '../types.js';

export interface PendingDeployReplayDeps {
  stateService: Pick<StateService, 'getBranch'>;
  config: Pick<CdsConfig, 'masterPort'>;
  activeServerEventLogStore?: ServerEventLogSink | null;
  coordinator?: Pick<BranchOperationCoordinator, 'claimPending' | 'markPendingSent' | 'settlePending' | 'discardPending'>;
  fetch?: typeof fetch;
  observation?: { headersTimeoutMs?: number; observationTimeoutMs?: number };
}

export function replayPendingDeploy(pending: PendingWebhookDeploy | null, deps: PendingDeployReplayDeps): void {
  const { stateService, config } = deps;
  const serverEventLogStore = deps.activeServerEventLogStore;
  if (!pending) return;
  const branch = stateService.getBranch(pending.branchId);
  // Never derive original ownership or widen a malformed service scope from current state.
  const validScope = pending.request.branchId === pending.branchId && (
    (pending.request.kind === 'deploy-profile' && typeof pending.request.profileId === 'string'
      && pending.request.profileId.trim().length > 0) ||
    (pending.request.kind === 'deploy' && !pending.request.profileId)
  );
  const dropReason = !branch ? 'branch_gone'
    : (pending.request.projectId || null) !== (branch.projectId || null) ? 'project_mismatch'
    : !validScope ? 'invalid_scope' : undefined;
  if (dropReason) {
    serverEventLogStore?.record({
      category: 'system',
      severity: 'warn',
      source: 'branch-operation-coordinator',
      action: 'branch.operation.pending-drop',
      message: `pending deploy dropped: ${dropReason}`,
      projectId: pending.request.projectId || undefined,
      branchId: pending.branchId,
      requestId: pending.request.requestId || null,
      operationId: pending.operationId,
      operationKind: pending.request.kind,
      operationTrigger: pending.request.trigger,
      operationActor: pending.request.actor || null,
      operationSource: pending.request.source || null,
      commitSha: pending.request.commitSha || null,
      details: {
        reason: dropReason,
        operationId: pending.operationId,
        commitSha: pending.request.commitSha || null,
        trigger: pending.request.trigger,
        actor: pending.request.actor || null,
        source: pending.request.source || null,
        kind: pending.request.kind,
        mergedCount: pending.mergedCount,
      },
    });
    void deps.coordinator?.discardPending(pending).catch(() => {});
    return;
  }
  if (!branch) return;
  const profilePath = pending.request.kind === 'deploy-profile' && pending.request.profileId
    ? `/${encodeURIComponent(pending.request.profileId)}` : '';
  const url = `http://127.0.0.1:${config.masterPort}/api/branches/${encodeURIComponent(pending.branchId)}/deploy${profilePath}`;
  const originalIdentity = JSON.stringify([branch.id, branch.projectId || null, branch.branch, branch.worktreePath, branch.createdAt]);
  const dispatch = async () => {
    if (deps.coordinator) {
      if (!await deps.coordinator.claimPending(pending)) return;
      const current = stateService.getBranch(pending.branchId);
      if (current !== branch || JSON.stringify([current?.id, current?.projectId || null, current?.branch, current?.worktreePath, current?.createdAt]) !== originalIdentity) {
        await deps.coordinator.discardPending(pending); return;
      }
      if (!deps.coordinator.markPendingSent(pending)) return;
    }
  void observePendingDeployDispatch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CDS-Internal': '1',
      ...(deps.coordinator ? { 'X-CDS-Pending-Operation-Id': pending.operationId, 'X-CDS-Pending-Generation': String(pending.generation) } : {}),
      // 透传原始 trigger：合并进 pending 的 manual deploy 重发时仍以 manual
      // 身份进入（保持优先级 80 语义与 run 账本归因），webhook 照旧。
      'X-CDS-Trigger': pending.request.trigger,
      'X-CDS-Request-Id': pending.request.requestId || pending.operationId,
      ...(branch.projectId ? { 'X-CDS-Source-Project-Id': branch.projectId } : {}),
      'X-CDS-Source-Branch-Id': pending.branchId,
    },
    // An unpinned manual whole request means the branch HEAD at execution time.
    body: JSON.stringify({ commitSha: pending.request.kind === 'deploy' && pending.request.trigger === 'manual'
      && pending.request.commitPinned !== true ? undefined : pending.request.commitSha || undefined }),
  }, { fetch: deps.fetch, ...deps.observation }).then(async (result) => {
    await deps.coordinator?.settlePending(pending, result);
    serverEventLogStore?.record({
      category: 'system',
      severity: result.outcome === 'failed' ? 'error' : result.outcome === 'unknown' ? 'warn' : 'info',
      source: 'branch-operation-coordinator',
      action: `branch.operation.pending-dispatch.${result.outcome}`,
      message: `pending deploy observation: ${result.reason}`,
      projectId: branch.projectId,
      branchId: pending.branchId,
      requestId: pending.request.requestId || null,
      operationId: pending.operationId,
      operationKind: pending.request.kind,
      operationTrigger: pending.request.trigger,
      operationActor: pending.request.actor || null,
      operationSource: pending.request.source || null,
      commitSha: pending.request.commitSha || null,
      details: {
        ...result,
        operationId: pending.operationId,
        commitSha: pending.request.commitSha || null,
        trigger: pending.request.trigger,
        actor: pending.request.actor || null,
        source: pending.request.source || null,
        kind: pending.request.kind,
        mergedCount: pending.mergedCount,
      },
    });
  }).catch(() => recordPersistenceFailure());
  serverEventLogStore?.record({
    category: 'system',
    severity: 'info',
    source: 'branch-operation-coordinator',
    action: 'branch.operation.pending-dispatch.started',
    message: `pending webhook deploy dispatched: ${pending.branchId}`,
    projectId: branch.projectId,
    branchId: pending.branchId,
    requestId: pending.request.requestId || null,
    operationId: pending.operationId,
    operationKind: pending.request.kind,
    operationTrigger: pending.request.trigger,
    operationActor: pending.request.actor || null,
    operationSource: pending.request.source || null,
    commitSha: pending.request.commitSha || null,
    details: {
      operationId: pending.operationId,
      commitSha: pending.request.commitSha || null,
      trigger: pending.request.trigger,
      actor: pending.request.actor || null,
      source: pending.request.source || null,
      kind: pending.request.kind,
      mergedCount: pending.mergedCount,
    },
  });
  };
  const recordPersistenceFailure = () => serverEventLogStore?.record({ category: 'system', severity: 'error',
    source: 'branch-operation-coordinator', action: 'branch.operation.pending-persistence.failed',
    message: 'pending deployment durable transition failed; no retry authorized', branchId: pending.branchId,
    projectId: pending.request.projectId || undefined, operationId: pending.operationId });
  void dispatch().catch(recordPersistenceFailure);
}
