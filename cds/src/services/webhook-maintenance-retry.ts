import type { BranchEntry } from '../types.js';

/** 只补发服务端明确拒绝的自更新请求；超时/断线等结果不明的请求绝不自动重试。 */
export class SelfUpdateDeferredError extends Error {}
export const MAINTENANCE_RETRY_MAX_AGE_MS = 30 * 60_000;
export const MAINTENANCE_RETRY_MAX_ATTEMPTS = 3;

export function unresolvedWebhookDispatches(branches: readonly BranchEntry[]): number {
  return branches.filter((b) => {
    if (b.maintenanceDeferredDeploy) return Date.now() - Date.parse(b.maintenanceDeferredDeploy.createdAt) >= MAINTENANCE_RETRY_MAX_AGE_MS;
    if (b.lastDeployDispatchSource !== 'webhook' || b.lastDeployDispatchStatus !== 'failed') return false;
    if (b.githubCommitSha && b.lastDeployDispatchCommitSha && b.githubCommitSha !== b.lastDeployDispatchCommitSha) return false;
    const dispatchedAt = Date.parse(b.lastDeployDispatchAt ?? '');
    if (Date.parse(b.lastDeployAt ?? '') >= dispatchedAt) return false;
    return true;
  }).length;
}

type RetryState = {
  getAllBranches(): BranchEntry[];
  getBranch(id: string): BranchEntry | undefined;
  getProject(id: string): { paused?: boolean } | undefined;
  save(): void;
  flush(): Promise<void>;
};
const running = new WeakSet<RetryState>();

export async function resumeMaintenanceDeploys(state: RetryState, deps: {
  draining(): boolean;
  dispatch(branchId: string, commitSha: string): Promise<void>;
  now?: () => number;
  record?(branchId: string, result: string): void;
}): Promise<void> {
  if (running.has(state) || deps.draining()) return;
  running.add(state);
  try {
    for (const branch of state.getAllBranches()) {
      const pending = branch.maintenanceDeferredDeploy;
      if (!pending || deps.draining()) continue;
      const now = (deps.now ?? Date.now)();
      const obsolete = branch.githubCommitSha !== pending.commitSha || branch.lastDeployDispatchCommitSha !== pending.commitSha
        || Date.parse(branch.lastDeployAt ?? '') >= Date.parse(pending.createdAt);
      let failure: string | undefined;
      if (!obsolete && pending.claimed) failure = '自更新补发中断，接收结果未确认；为避免重复部署，需要检查部署记录后手动重试';
      else if (!obsolete && (now - Date.parse(pending.createdAt) >= MAINTENANCE_RETRY_MAX_AGE_MS || pending.attempts >= MAINTENANCE_RETRY_MAX_ATTEMPTS)) failure = '自更新补发超过 30 分钟或 3 次上限，请手动重试';
      if (obsolete || failure) {
        branch.maintenanceDeferredDeploy = undefined;
        if (failure) { branch.lastDeployDispatchStatus = 'failed'; branch.lastDeployDispatchError = failure; }
        state.save(); await state.flush(); deps.record?.(branch.id, failure ?? '已被更新的部署取代');
        continue;
      }
      if (state.getProject(branch.projectId)?.paused) continue;
      pending.claimed = true;
      pending.attempts += 1;
      state.save(); await state.flush(); // 先持久化领取；重启后不盲目重复一个可能已被接收的请求。
      if (state.getBranch(branch.id)?.maintenanceDeferredDeploy !== pending || branch.githubCommitSha !== pending.commitSha) continue;
      try {
        await deps.dispatch(branch.id, pending.commitSha);
        if (state.getBranch(branch.id)?.maintenanceDeferredDeploy !== pending) continue;
        branch.maintenanceDeferredDeploy = undefined;
        branch.lastDeployDispatchStatus = 'accepted';
        branch.lastDeployDispatchError = undefined;
        state.save(); await state.flush(); deps.record?.(branch.id, '自更新结束，部署端点已接收补发');
      } catch (error) {
        if (state.getBranch(branch.id)?.maintenanceDeferredDeploy !== pending) continue;
        if (error instanceof SelfUpdateDeferredError) pending.claimed = false;
        else {
          branch.maintenanceDeferredDeploy = undefined;
          branch.lastDeployDispatchStatus = 'failed';
          branch.lastDeployDispatchError = '补发失败或接收结果未确认，需要检查部署记录后手动重试';
        }
        state.save(); await state.flush(); deps.record?.(branch.id, branch.lastDeployDispatchError ?? '仍在自更新，等待下轮有界补发');
      }
    }
  } finally { running.delete(state); }
}
