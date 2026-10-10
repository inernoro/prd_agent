import type { StateService } from './state.js';
import type { BranchOperationRequest } from './branch-operation-coordinator.js';

/** Run terminal status never proves that its Daemon identities have been reconciled. */
export function unresolvedCandidateRun(state: Pick<StateService, 'getDeploymentRuns'>, branchId: string, exceptRunId?: string) {
  return state.getDeploymentRuns().find(run => run.branchId === branchId && run.id !== exceptRunId &&
    run.candidate && run.candidate.phase !== 'released');
}

export function candidateOperationAdmission(state: Pick<StateService, 'getDeploymentRuns'>, request: BranchOperationRequest): string | null {
  // Explicit stop may cancel an executor and stop the published graph; it does not release the journal.
  if (request.kind === 'stop') return null;
  return unresolvedCandidateRun(state, request.branchId)
    ? 'candidate_reconciliation_required: 上次交付的新旧实例尚未完成对账，暂不允许新的启动、替换或删除' : null;
}
