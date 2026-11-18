import { ApiError } from './api';
import type { ReleaseApprovalDetail } from '../../../src/domain/release-governance';

export type ReleaseApprovalRead<T> = { key: string; result?: T; error?: string };

export function releaseApprovalReadFailure<T>(
  previous: ReleaseApprovalRead<T> | undefined, key: string, failure: unknown, error: string,
): ReleaseApprovalRead<T> {
  const retain = previous?.key === key && (!(failure instanceof ApiError) || failure.status >= 500 || failure.status === 429);
  return { key, result: retain ? previous.result : undefined, error };
}

export const releaseApprovalInboxPath = (projectId: string, targetId: string): string =>
  `/release-center/approval?${new URLSearchParams({ project: projectId, target: targetId })}`;

export const releaseApprovalTitle = (record: Pick<ReleaseApprovalDetail['authorization'], 'kind' | 'action'>): string =>
  record.kind === 'debug' ? '连续调试申请' : record.action === 'rollback' ? '回滚审批申请' : '单次发布申请';

export const releaseApprovalPath = (id: string, scope?: { projectId: string; targetId: string }): string =>
  `/release-center/approval?${new URLSearchParams({ request: id, ...(scope ? { project: scope.projectId, target: scope.targetId } : {}) })}`;

export const releaseApprovalWorkbenchPath = (record: Pick<ReleaseApprovalDetail['authorization'], 'projectId' | 'targetId' | 'branchId'>): string =>
  `/release-console?${new URLSearchParams({ project: record.projectId, target: record.targetId, mode: 'single', branch: record.branchId })}`;

/** A link from an approval must never silently substitute a different source. */
export function chooseReleaseWorkbenchBranch(branches: Array<{ id: string }>, current: string, fromApproval: string): string {
  if (branches.some(branch => branch.id === current)) return current;
  if (fromApproval) return branches.some(branch => branch.id === fromApproval) ? fromApproval : '';
  return branches[0]?.id || '';
}

/** Prefer the pinned revision while preserving older branch responses. */
export function releaseWorkbenchCommit(branch?: { pinnedCommit?: string; githubCommitSha?: string; commitSha?: string }): string {
  return branch?.pinnedCommit || branch?.githubCommitSha || branch?.commitSha || '';
}

export function releaseApprovalState(record: Pick<ReleaseApprovalDetail['authorization'], 'status' | 'expiresAt' | 'consumedBy'>, now: number): keyof typeof releaseApprovalLabels {
  if (record.status === 'approved' && record.consumedBy) return 'used';
  if (record.status === 'pending' || record.status === 'approved') {
    const expires = Date.parse(record.expiresAt);
    if (!Number.isFinite(expires) || expires <= now) return 'expired';
  }
  return record.status;
}

export function canRevokeReleaseApproval(record: Pick<ReleaseApprovalDetail['authorization'], 'status'>): boolean {
  return record.status === 'pending' || record.status === 'approved';
}

export const releaseApprovalLabels = {
  pending: '待独立审批', approved: '已批准', rejected: '已拒绝', revoked: '已撤销', expired: '已到期', used: '本次批准已使用',
} as const;
