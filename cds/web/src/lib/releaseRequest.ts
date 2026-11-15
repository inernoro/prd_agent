import { ApiError } from './api';
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

/** 主消息保留服务端业务原因，接口路径和HTTP包装不占产品说明区。 */
export function releaseFailureReason(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === 'object') {
    const body = error.body as Record<string, unknown>;
    for (const field of ['message', 'error', 'hint']) if (typeof body[field] === 'string' && body[field].trim()) return body[field];
  }
  if (error instanceof TypeError) return '网络连接中断，尚未收到可确认的结果';
  return error instanceof Error ? error.message : '暂时无法确认结果';
}

export { consoleAccountIdentity as releaseAccountIdentity } from './consoleIdentity';
