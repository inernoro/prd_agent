import type { BranchEntry } from '../types.js';

export interface DiscoveredAppContainer {
  containerName: string;
  branchId: string;
  profileId: string;
  running: boolean;
}

export function hasBranchDeleteCleanupIntent(branch: BranchEntry): boolean {
  const reason = branch.lastStopReason || '';
  if (!reason.includes('删除分支流程已开始')) return false;
  if (branch.status !== 'stopping') return false;
  return branch.lastStopSource === 'system'
    || branch.lastStopSource === 'webhook'
    || branch.lastStopSource === 'cds';
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
