import type { BranchEntry } from '../types.js';
import { hasBranchDeleteIntentReason } from './branch-wake-eligibility.js';

export interface DiscoveredAppContainer {
  containerName: string;
  branchId: string;
  profileId: string;
  running: boolean;
  exitCode?: number;
  oomKilled?: boolean;
  finishedAt?: string;
}

// Only this exact legacy startup error is migratable. Build/readiness/OOM
// failures must retain their diagnosis, even if another service rebooted.
const LEGACY_STARTUP_EXIT = '容器异常退出，疑似崩溃，需重新部署';

export function reconcileHostRebootBranch(
  branch: BranchEntry,
  containers: Map<string, DiscoveredAppContainer>,
  bootedAtMs: number,
  projectPaused: boolean,
): boolean {
  if (projectPaused || branch.executorId || branch.deleting || hasBranchDeleteIntentReason(branch)) return false;
  if (branch.status !== 'running' && branch.status !== 'error') return false;
  if (branch.ciImageStatus === 'failed' || branch.ciImageStatus === 'waiting') return false;
  // A previous stop is stale if the branch subsequently became running. For
  // legacy error rows, preserve explicit human/external/crash stop intent.
  if (branch.status === 'error' && branch.lastStopSource
    && !['cds', 'system', 'scheduler'].includes(branch.lastStopSource)) return false;
  const services = Object.entries(branch.services || {});
  if (!services.length || !Number.isFinite(bootedAtMs)) return false;
  let rebootExits = 0;
  for (const [profileId, svc] of services) {
    if (svc.status !== 'running' && !(svc.status === 'error' && svc.errorMessage === LEGACY_STARTUP_EXIT)) return false;
    const found = containers.get(`${branch.id}/${profileId}`);
    if (!found || found.containerName !== svc.containerName) return false;
    if (found.running) continue;
    const finishedAtMs = Date.parse(found.finishedAt || '');
    if (found.exitCode !== 255 || found.oomKilled !== false
      || !Number.isFinite(finishedAtMs) || Math.abs(finishedAtMs - bootedAtMs) > 120_000) return false;
    rebootExits++;
  }
  // Mixed live/stopped branches need per-service recovery; the existing wake
  // path restarts the whole branch, so never disrupt surviving services here.
  if (rebootExits !== services.length) return false;
  for (const svc of Object.values(branch.services)) {
    svc.status = 'stopped';
    svc.errorMessage = undefined;
  }
  branch.status = 'idle';
  branch.errorMessage = undefined;
  branch.lastStopSource = 'system';
  branch.lastStoppedAt = new Date(bootedAtMs).toISOString();
  branch.lastStopReason = '宿主重启中断了原运行分支；容器已保留，访问预览时按需恢复，无需重新编译';
  branch.heatState = 'cold';
  return true;
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
