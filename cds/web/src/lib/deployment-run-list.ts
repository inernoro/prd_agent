import type { DeploymentRunSummary } from '@/components/deployment/DeploymentRunLedger';

function listRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function optionalListText(value: unknown): boolean { return value == null || typeof value === 'string'; }

/** Qualify the shared ledger display fields; legacy timing data stays optional. */
export function branchScopedDeploymentRuns(value: unknown, projectId: string, branchId: string): DeploymentRunSummary[] | null {
  const packet = listRecord(value);
  if (!packet || !Array.isArray(packet.runs)) return null;
  const valid = packet.runs.every(value => {
    const run = listRecord(value);
    if (!run || run.projectId !== projectId || run.branchId !== branchId
      || typeof run.id !== 'string' || !run.id
      || !['pending', 'queued', 'preparing', 'building', 'starting', 'verifying', 'running', 'failed', 'cancelled'].includes(run.status as string)
      || !['webhook', 'manual', 'retry', 'scheduler', 'system'].includes(run.trigger as string)
      || typeof run.phase !== 'string' || typeof run.updatedAt !== 'string'
      || !Number.isSafeInteger(run.eventCount) || (run.eventCount as number) < 0
      || !optionalListText(run.commitSha) || !optionalListText(run.executorId)) return false;
    const failure = listRecord(run.failure), event = listRecord(run.latestEvent);
    return (run.failure == null || Boolean(failure && optionalListText(failure.summary) && optionalListText(failure.suggestedAction)))
      && (run.latestEvent == null || Boolean(event && optionalListText(event.message)));
  });
  return valid ? packet.runs.slice(0, 10) as DeploymentRunSummary[] : null;
}

