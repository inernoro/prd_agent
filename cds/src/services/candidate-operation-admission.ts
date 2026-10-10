import type { StateService } from './state.js';
import type { BranchOperationRequest } from './branch-operation-coordinator.js';

/** Run terminal status never proves that its Daemon identities have been reconciled. */
export function unresolvedCandidateRun(state: Pick<StateService, 'getDeploymentRuns'>, branchId: string, exceptRunId?: string) {
  return state.getDeploymentRuns().find(run => run.branchId === branchId && run.id !== exceptRunId &&
    run.candidate && run.candidate.phase !== 'released');
}

export function candidateOperationAdmission(state: Pick<StateService, 'getDeploymentRuns'>, request: BranchOperationRequest): string | null {
  if (request.kind === 'candidate-reconcile') {
    const records = state.getDeploymentRuns().filter(run => run.branchId === request.branchId && run.candidate && run.candidate.phase !== 'released');
    const run = records.length === 1 ? records[0] : undefined; const candidate = run?.candidate;
    return request.trigger === 'system' && request.source === 'candidate-reconciler' && !request.profileId &&
      run && candidate && run.id === request.reconcileRunId && run.projectId === request.projectId &&
      typeof run.operationId === 'string' && !!run.operationId &&
      ['prepared', 'starting', 'ready', 'switch-intent', 'routed', 'rollback-intent', 'rollback-verified', 'reconciling'].includes(candidate.phase) &&
      ['failed', 'cancelled'].includes(run.status) && typeof run.finishedAt === 'string' && Number.isFinite(Date.parse(run.finishedAt)) &&
      candidate.recoveryProof?.version === 1 && run.operationId === candidate.operationId &&
      typeof candidate.targetSha === 'string' && /^[a-f0-9]{40}$/.test(candidate.targetSha) &&
      run.commitSha === candidate.targetSha && typeof run.configHash === 'string' && !!run.configHash && run.configHash === candidate.configHash
      ? null : 'candidate_reconciliation_scope: unique terminal owned journal required';
  }
  // Explicit stop may cancel an executor and stop the published graph; it does not release the journal.
  if (request.kind === 'stop') return null;
  return unresolvedCandidateRun(state, request.branchId)
    ? 'candidate_reconciliation_required: 上次交付的新旧实例尚未完成对账，暂不允许新的启动、替换或删除' : null;
}
