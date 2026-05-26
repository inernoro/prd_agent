import type { StateService } from './state.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

export interface DeployDispatchReconcileResult {
  branchId: string;
  projectId?: string;
  previousStatus: 'dispatching' | 'accepted';
  nextStatus: 'interrupted';
  ageMin: number;
  commitSha?: string;
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
    const ageMin = Math.floor((nowMs - dispatchAtMs) / 60_000);
    if (ageMin < staleAfterMinutes) continue;

    const reason = `Webhook deploy dispatch stayed ${status} for ${ageMin} minutes without a newer successful deploy stamp`;
    branch.lastDeployDispatchStatus = 'interrupted';
    branch.lastDeployDispatchError = reason;
    const result: DeployDispatchReconcileResult = {
      branchId: branch.id,
      projectId: branch.projectId,
      previousStatus: status,
      nextStatus: 'interrupted',
      ageMin,
      commitSha: branch.lastDeployDispatchCommitSha,
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
      details: {
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
