import type { StateService } from './state.js';
import type { AcceptanceResourceRun } from './acceptance-resource-run.js';
import type { BranchOperationRequest } from './branch-operation-coordinator.js';
import type { BranchEntry } from '../types.js';

export const ACCEPTANCE_RELEASE_BLOCKED = 'acceptance_release_reconciliation_required';
type Reader = Pick<StateService, 'getState' | 'getAcceptanceResourcePublicationDrafts'>;
function pendingRows(state: Reader): readonly AcceptanceResourceRun[] {
  return state.getAcceptanceResourcePublicationDrafts();
}
/** Unknown intent shape is occupied too. Neither a revoked lease nor a terminal report proves release. */
export function acceptanceReleaseBlockReason(state: Reader, branchId: string): string | null {
  const canonical = Object.values(state.getState().acceptanceResourceRuns || {});
  if ([...canonical, ...pendingRows(state)].some(row => row.branchId === branchId && row.stage === 'active'
    && Object.prototype.hasOwnProperty.call(row, 'creationIntent'))) return 'acceptance_creation_reconciliation_required';
  return [...canonical.filter(row => row.stage !== 'released'), ...pendingRows(state)]
    .some(row => row.branchId === branchId && Object.prototype.hasOwnProperty.call(row, 'releaseIntent'))
    ? ACCEPTANCE_RELEASE_BLOCKED : null;
}
/** Internal lease scope only; the release caller must separately validate project access, owner and real evidence. */
export function acceptanceReleaseOperationAdmission(state: Reader, request: BranchOperationRequest): string | null {
  const blocked = acceptanceReleaseBlockReason(state, request.branchId);
  if (!blocked) return null;
  if (blocked === 'acceptance_creation_reconciliation_required') {
    const holders = Object.values(state.getState().acceptanceResourceRuns || {}).filter(row => row.branchId === request.branchId
      && row.stage === 'active' && Object.prototype.hasOwnProperty.call(row, 'creationIntent'));
    const row = holders[0];
    // Internal continuation only. The caller must still prove the original capability and actual lease.
    if (request.kind !== 'acceptance-create' || request.source !== 'acceptance-resource-deploy' || request.profileId != null
      || holders.length !== 1 || pendingRows(state).some(draft => draft.branchId === request.branchId)
      || !row || row.id !== request.acceptanceRunId || row.projectId !== request.projectId || row.targetSha !== request.commitSha
      || !/^[a-f0-9]{40}$/.test(row.targetSha) || row.resource || row.terminal || row.releaseIntent
      || row.creationIntent?.version !== 1 || row.creationIntent.phase !== 'configured'
      || !/^[a-f0-9]{64}$/.test(row.creationIntent.profileDigest) || !Number.isFinite(Date.parse(row.creationIntent.startedAt))) return blocked;
    return null;
  }
  if (request.kind !== 'acceptance-release') return ACCEPTANCE_RELEASE_BLOCKED;
  const table = state.getState().acceptanceResourceRuns || {};
  const holders = Object.values(table).filter(row => row.branchId === request.branchId && row.stage !== 'released'
    && Object.prototype.hasOwnProperty.call(row, 'releaseIntent'));
  const row = holders[0];
  if (holders.length !== 1 || pendingRows(state).some(draft => draft.branchId === request.branchId
      && Object.prototype.hasOwnProperty.call(draft, 'releaseIntent'))
    || !row || row.id !== request.acceptanceRunId || row.projectId !== request.projectId || row.targetSha !== request.commitSha
    || row.stage !== 'finished' || !row.resource || !row.terminal || row.releaseIntent?.version !== 1
    || !['prepared', 'stopped', 'removed'].includes(row.releaseIntent.phase)) return ACCEPTANCE_RELEASE_BLOCKED;
  return null;
}
/** Read/copy from another branch is allowed, but a run's temporary resource never becomes a new owner's config. */
export function acceptanceResourceCopyExcludedProfiles(state: Reader, source: BranchEntry): ReadonlySet<string> {
  return new Set([...Object.values(state.getState().acceptanceResourceRuns || {}).filter(row => row.stage !== 'released'), ...pendingRows(state)]
    .filter(row => row.branchId === source.id).map(row => row.profileId));
}
