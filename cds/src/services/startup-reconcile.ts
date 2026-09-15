import type { BranchEntry } from '../types.js';
import { hasBranchDeleteIntentReason } from './branch-wake-eligibility.js';

export interface DiscoveredAppContainer {
  containerName: string;
  branchId: string;
  profileId: string;
  running: boolean;
}

export function hasBranchDeleteCleanupIntent(branch: BranchEntry): boolean {
  // 「是不是删除流程留下的停机」只在 branch-wake-eligibility 里定义一次
  // （唤醒判据也要读它——半路把正在删的分支拉起来会和清理打架）。
  // 这里只在它之上加本模块特有的那一条：清理残渣只处理仍卡在 stopping 的分支。
  if (branch.status !== 'stopping') return false;
  return hasBranchDeleteIntentReason(branch);
}

export function shouldPruneDeletedBranchStartupResidue(
  branch: BranchEntry,
  appContainers: Map<string, DiscoveredAppContainer>,
): boolean {
  if (!hasBranchDeleteCleanupIntent(branch)) return false;
  if (branch.executorId) return false;

  const services = Object.keys(branch.services || {});
  if (services.length === 0) return true;

  return services.every((profileId) => !appContainers.has(`${branch.id}/${profileId}`));
}
