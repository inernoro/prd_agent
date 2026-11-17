import type { ReleaseRun } from '@/pages/release-center/types';

/** 单次请求的关联信息；它不提供服务端幂等或耐久性保证。 */
export interface ReleaseRequest {
  requestId: string;
  projectId: string;
  projectLabel?: string;
  targetLabel?: string;
  branchLabel?: string;
  targetId: string;
  branchId: string;
  commitSha: string;
  kind: 'deploy' | 'retry' | 'rollback';
  sourceReleaseId?: string;
  rollbackTargetReleaseId?: string;
  requestedAt: string;
}

export type CorrelatedRelease =
  | { kind: 'found'; run: ReleaseRun }
  | { kind: 'missing' | 'ambiguous' | 'mismatch' };

/** 只认可本次请求的唯一正向记录；查无结果从不证明没有执行。 */
export function correlateRelease(request: ReleaseRequest, runs: ReleaseRun[]): CorrelatedRelease {
  const candidates = runs.filter(run => run.requestId === request.requestId);
  if (candidates.length === 0) return { kind: 'missing' };
  if (candidates.length !== 1) return { kind: 'ambiguous' };
  const run = candidates[0];
  const sameSource = run.projectId === request.projectId && run.targetId === request.targetId
    && run.branchId === request.branchId && run.commitSha === request.commitSha;
  const sameAction = request.kind === 'rollback'
    ? run.rollbackOf === request.sourceReleaseId && run.rollbackTargetReleaseId === request.rollbackTargetReleaseId
    : !run.rollbackOf;
  return sameSource && sameAction ? { kind: 'found', run } : { kind: 'mismatch' };
}

export function releaseRequestStorageKey(account: string): string {
  return `cds:unconfirmed-releases:${encodeURIComponent(account)}`;
}

/** 恢复的记录只用于只读核对，绝不据此重新POST。 */
export function readReleaseRequests(storage: Pick<Storage, 'getItem'>, key: string): ReleaseRequest[] {
  const raw = storage.getItem(key);
  try {
    const value: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ReleaseRequest => item && typeof item === 'object'
      && ['requestId', 'projectId', 'targetId', 'branchId', 'commitSha', 'requestedAt'].every(field => typeof item[field] === 'string' && item[field])
      && ['deploy', 'retry', 'rollback'].includes(item.kind)
      && (item.kind !== 'rollback' || typeof item.sourceReleaseId === 'string' && typeof item.rollbackTargetReleaseId === 'string'));
  } catch { return []; }
}

export { userErrorMessage as releaseFailureReason } from './userErrorMessage';

export { consoleAccountIdentity as releaseAccountIdentity } from './consoleIdentity';
