import fs from 'node:fs/promises';
import path from 'node:path';
import type { BranchEntry } from '../types.js';
import type { OrphanWorktreeFs } from './janitor.js';
import { WorktreeService } from './worktree.js';
import { worktreePathActivity, sameWorktreeDirectoryIdentity, WorktreeClaimHeldError, type WorktreeDirectoryIdentity } from './worktree-path-activity.js';

export interface DeploymentSourceRetentionReport {
  scanned: number; attempted: number; removed: string[]; held: Record<string, string>;
  failed: Array<{ path: string; error: string }>; deferred: number;
  lastAttemptedPath?: string;
  lastScannedPath?: string;
}
const related = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUSY = new Set(['building', 'starting', 'stopping', 'restarting', 'preparing', 'provisioning']);

/** Only detached UUID leaves are eligible; the ordinary orphan collector never owns these buckets. */
export async function reclaimDeploymentSources(input: {
  base: string; projectIds: string[]; branches: () => BranchEntry[];
  files: OrphanWorktreeFs; nowMs: number; maxRemovals?: number; minAgeMs?: number; afterPath?: string;
}): Promise<DeploymentSourceRetentionReport> {
  const report: DeploymentSourceRetentionReport = { scanned: 0, attempted: 0, removed: [], held: {}, failed: [], deferred: 0 };
  const max = input.maxRemovals ?? 20, minAge = input.minAgeMs ?? 2 * 3600_000;
  const isClaimed = (dir: string) => input.branches().some(b =>
    (BUSY.has(b.status) && b.worktreePath && related(dir, WorktreeService.deploymentSourceRootFor(b.worktreePath)))
    || Object.values(b.services || {}).some(s => s.sourceCheckoutPath && related(dir, path.resolve(s.sourceCheckoutPath))));
  const isMounted = (dir: string, paths: string[]) => paths.some(p => related(dir, path.resolve(p)));
  const realBase = await fs.realpath(input.base).catch(() => null);
  if (!realBase) return report;
  const candidates: Array<{ dir: string; mtime: number; identity: WorktreeDirectoryIdentity }> = [];
  const sourceDirs: string[] = [];
  for (const project of new Set(input.projectIds)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(project) || project === '..') continue;
    const projectDir = path.join(input.base, project), root = path.join(projectDir, '.deployment-sources');
    // No symlinked project, source bucket, branch bucket, or leaf can widen the deletion boundary.
    if (!(await fs.lstat(projectDir).catch(() => null))?.isDirectory()
      || !(await fs.lstat(root).catch(() => null))?.isDirectory()) continue;
    const roots = await fs.readdir(root, { withFileTypes: true }).catch(() => null);
    if (!roots) { report.held[root] = '无法完整读取部署源码桶'; continue; }
    for (const bucket of roots) {
      if (!bucket.isDirectory()) continue;
      const bucketPath = path.join(root, bucket.name);
      const leaves = await fs.readdir(bucketPath, { withFileTypes: true }).catch(() => null);
      if (!leaves) { report.held[bucketPath] = '无法读取部署源码目录'; continue; }
      for (const leaf of leaves) {
        if (!leaf.isDirectory() || !UUID.test(leaf.name)) continue;
        sourceDirs.push(path.join(bucketPath, leaf.name));
      }
    }
  }
  sourceDirs.sort();
  const next = input.afterPath ? sourceDirs.findIndex(dir => dir > input.afterPath!) : 0;
  const start = next < 0 ? 0 : next;
  const scanOrder = [...sourceDirs.slice(start), ...sourceDirs.slice(0, start)];
  for (const dir of scanOrder) {
    if (report.scanned >= 1024) { report.deferred++; continue; }
    report.scanned++; report.lastScannedPath = dir;
    const identity = await input.files.readDirectoryIdentity?.(dir);
    const expectedPath = path.join(realBase, path.relative(path.resolve(input.base), path.resolve(dir)));
    if (!identity || identity.entryPath !== expectedPath) { report.held[dir] = '目录归属无法确认'; continue; }
    const mtime = await input.files.statDirMtimeMs(dir);
    if (mtime === null || input.nowMs - mtime < minAge || isClaimed(dir)) {
      report.held[dir] = '目录过新、正在部署、台账引用或容器挂载'; continue;
    }
    candidates.push({ dir, mtime, identity });
  }
  if (!candidates.length) return report;
  const mounted = await input.files.listMountedHostPaths();
  if (mounted === null) { report.held[input.base] = '容器挂载枚举未完整确认，本轮不回收部署源码'; return report; }
  // Preserve the scan order. Resuming after the last dispatch keeps the 20-removal
  // budget and 1024-leaf window on one cursor, including worker-held leaves.
  for (const {dir, identity} of candidates) {
    if (isMounted(dir, mounted)) { report.held[dir] = '运行或停止的容器仍挂载该目录'; continue; }
    if (report.attempted >= max) { report.deferred++; continue; }
    const activity = worktreePathActivity.tryAcquire([dir]);
    if (!activity) { report.held[dir] = '源码正在准备、使用或回收'; continue; }
    let uncertain = false;
    try {
      if (!activity.extend([identity.entryPath]) || isClaimed(dir)) { report.held[dir] = '目录被认领或对象已变化'; continue; }
      const freshMounts = await input.files.listMountedHostPaths();
      const current = await input.files.readDirectoryIdentity?.(dir);
      if (freshMounts === null || isMounted(dir, freshMounts) || isClaimed(dir)
        || !current || !sameWorktreeDirectoryIdentity(identity, current)) { report.held[dir] = '临删挂载、归属或目录身份未确认'; continue; }
      report.attempted++;
      report.lastAttemptedPath = dir;
      const error = await input.files.removeDir(dir, { identity, allowedBase: input.base, entryOnly: false,
        sourceOnly: true, beforeStart: () => {
          if (isClaimed(dir) || !activity.markDestructive()) throw new WorktreeClaimHeldError();
        } });
      if (error) report.failed.push({ path: dir, error }); else report.removed.push(dir);
    } catch (error) {
      uncertain = (error as {code?:string})?.code === 'cleanup';
      if (uncertain) activity.markUncertain();
      report.held[dir] = '源码回收未确认，保留目录与占用';
    } finally { if (!uncertain) activity.release(); }
  }
  return report;
}
