import type { StateService } from './state.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import type { BranchEntry } from '../types.js';
import { createHash } from 'node:crypto';

export interface DeployDispatchReconcileResult {
  branchId: string;
  projectId?: string;
  previousStatus: 'dispatching' | 'accepted';
  nextStatus: 'accepted' | 'interrupted';
  ageMin: number;
  commitSha?: string;
  dispatchAt: string;
  reason: string;
}

export interface ReconcileStaleDeployDispatchOptions {
  now?: Date;
  staleAfterMinutes?: number;
  source?: string;
  serverEventLogStore?: ServerEventLogSink | null;
}

const STALE_DEPLOY_DISPATCH_MINUTES = 15;

function parseTime(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createReconcileTraceId(branchId: string, dispatchAt: string, source: string): string {
  const digest = createHash('sha1')
    .update(`${branchId}\0${dispatchAt}\0${source}`)
    .digest('hex')
    .slice(0, 12);
  return `op_reconcile_${digest}`;
}

function hasRunningService(branch: BranchEntry): boolean {
  return Object.values(branch.services || {}).some((svc) => svc.status === 'running');
}

export function reconcileStaleDeployDispatches(
  stateService: StateService,
  options: ReconcileStaleDeployDispatchOptions = {},
): DeployDispatchReconcileResult[] {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const staleAfterMinutes = options.staleAfterMinutes ?? STALE_DEPLOY_DISPATCH_MINUTES;
  const source = options.source ?? 'deploy-dispatch-reconciler';
  const results: DeployDispatchReconcileResult[] = [];

  for (const branch of stateService.getAllBranches()) {
    const status = branch.lastDeployDispatchStatus;
    if (status !== 'dispatching' && status !== 'accepted') continue;
    const dispatchAt = branch.lastDeployDispatchAt;
    if (!dispatchAt) continue;
    const dispatchAtMs = parseTime(dispatchAt);
    if (!dispatchAtMs) continue;
    const lastDeployAtMs = parseTime(branch.lastDeployAt);
    if (lastDeployAtMs >= dispatchAtMs) continue;
    const lastReadyAtMs = parseTime(branch.lastReadyAt);
    if (
      lastReadyAtMs >= dispatchAtMs
      && branch.status === 'running'
      && hasRunningService(branch)
    ) {
      const reason = `Webhook deploy dispatch already reached ready state after dispatch; recovered deploy stamp from lastReadyAt`;
      const operationId = createReconcileTraceId(branch.id, dispatchAt, `${source}:ready`);
      const requestId = `reconcile_${operationId.slice('op_reconcile_'.length)}`;
      branch.lastDeployAt = branch.lastReadyAt;
      branch.lastDeployDispatchStatus = 'accepted';
      branch.lastDeployDispatchError = undefined;
      const result: DeployDispatchReconcileResult = {
        branchId: branch.id,
        projectId: branch.projectId,
        previousStatus: status,
        nextStatus: 'accepted',
        ageMin: Math.floor((nowMs - dispatchAtMs) / 60_000),
        commitSha: branch.lastDeployDispatchCommitSha,
        dispatchAt,
        reason,
      };
      results.push(result);

      stateService.appendLog(branch.id, {
        type: 'build',
        startedAt: dispatchAt,
        finishedAt: now.toISOString(),
        status: 'completed',
        events: [{
          step: 'webhook-dispatch',
          status: 'done',
          title: 'Webhook 部署派发状态已由运行时就绪证据恢复',
          log: reason,
          detail: {
            commitSha: branch.lastDeployDispatchCommitSha || null,
            previousStatus: status,
            nextStatus: 'accepted',
            lastReadyAt: branch.lastReadyAt || null,
            source,
          },
          timestamp: now.toISOString(),
        }],
      });
      options.serverEventLogStore?.record({
        category: 'system',
        severity: 'info',
        source,
        action: 'branch.deploy-dispatch.recovered-ready',
        message: `stale webhook deploy dispatch recovered from ready state for ${branch.id}`,
        projectId: branch.projectId,
        branchId: branch.id,
        requestId,
        operationId,
        details: {
          operationId,
          requestId,
          actor: 'system:deploy-dispatch-reconciler',
          trigger: 'system',
          previousStatus: status,
          nextStatus: 'accepted',
          lastDeployDispatchAt: branch.lastDeployDispatchAt || null,
          lastDeployDispatchCommitSha: branch.lastDeployDispatchCommitSha || null,
          lastReadyAt: branch.lastReadyAt || null,
          lastDeployAt: branch.lastDeployAt || null,
          reason,
        },
      });
      continue;
    }
    const ageMin = Math.floor((nowMs - dispatchAtMs) / 60_000);
    if (ageMin < staleAfterMinutes) continue;

    const reason = `Webhook deploy dispatch stayed ${status} for ${ageMin} minutes without a newer successful deploy stamp`;
    const operationId = createReconcileTraceId(branch.id, dispatchAt, source);
    const requestId = `reconcile_${operationId.slice('op_reconcile_'.length)}`;
    branch.lastDeployDispatchStatus = 'interrupted';
    branch.lastDeployDispatchError = reason;
    const result: DeployDispatchReconcileResult = {
      branchId: branch.id,
      projectId: branch.projectId,
      previousStatus: status,
      nextStatus: 'interrupted',
      ageMin,
      commitSha: branch.lastDeployDispatchCommitSha,
      dispatchAt,
      reason,
    };
    results.push(result);

    stateService.appendLog(branch.id, {
      type: 'build',
      startedAt: dispatchAt,
      finishedAt: now.toISOString(),
      status: 'error',
      events: [{
        step: 'webhook-dispatch',
        status: 'warning',
        title: 'Webhook 部署派发被 CDS 收敛为中断',
        log: reason,
        detail: {
          commitSha: branch.lastDeployDispatchCommitSha || null,
          previousStatus: status,
          nextStatus: 'interrupted',
          ageMin,
          source,
        },
        timestamp: now.toISOString(),
      }],
    });
    options.serverEventLogStore?.record({
      category: 'system',
      severity: 'warn',
      source,
      action: 'branch.deploy-dispatch.interrupted',
      message: `stale webhook deploy dispatch interrupted for ${branch.id}`,
      projectId: branch.projectId,
      branchId: branch.id,
      requestId,
      operationId,
      details: {
        operationId,
        requestId,
        actor: 'system:deploy-dispatch-reconciler',
        trigger: 'system',
        previousStatus: status,
        nextStatus: 'interrupted',
        lastDeployDispatchAt: branch.lastDeployDispatchAt || null,
        lastDeployDispatchCommitSha: branch.lastDeployDispatchCommitSha || null,
        lastDeployAt: branch.lastDeployAt || null,
        ageMin,
        reason,
      },
    });
  }

  if (results.length > 0) stateService.save();
  return results;
}
