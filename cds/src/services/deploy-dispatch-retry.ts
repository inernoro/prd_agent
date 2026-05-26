import type { BranchEntry } from '../types.js';
import type { DeployDispatchReconcileResult } from './deploy-dispatch-reconciler.js';

export interface DeployDispatchRetryDecision {
  retry: boolean;
  reason: string;
}

function parseTime(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function shouldRetryInterruptedWebhookDispatch(
  branch: BranchEntry | undefined,
  result: DeployDispatchReconcileResult,
): DeployDispatchRetryDecision {
  if (!branch) return { retry: false, reason: 'branch-missing' };
  if (!result.commitSha) return { retry: false, reason: 'missing-commit-sha' };
  if (branch.lastDeployDispatchCommitSha !== result.commitSha) {
    return { retry: false, reason: 'dispatch-commit-changed' };
  }
  if (branch.lastDeployDispatchAt !== result.dispatchAt) {
    return { retry: false, reason: 'dispatch-timestamp-changed' };
  }

  const dispatchAtMs = parseTime(result.dispatchAt);
  const lastDeployAtMs = parseTime(branch.lastDeployAt);
  if (lastDeployAtMs >= dispatchAtMs) {
    return { retry: false, reason: 'already-deployed-after-dispatch' };
  }

  const lastStoppedAtMs = parseTime(branch.lastStoppedAt);
  const terminalStopAfterDispatch =
    lastStoppedAtMs >= dispatchAtMs
    && (branch.lastStopSource === 'user' || branch.lastStopSource === 'executor' || branch.lastStopSource === 'system');
  if (terminalStopAfterDispatch) {
    return { retry: false, reason: `terminal-stop-after-dispatch:${branch.lastStopSource}` };
  }

  if (branch.status === 'idle' && Object.values(branch.services || {}).every((svc) => svc.status === 'stopped')) {
    return { retry: false, reason: 'branch-idle-all-services-stopped' };
  }

  return { retry: true, reason: 'stale-webhook-dispatch-safe-to-retry' };
}
