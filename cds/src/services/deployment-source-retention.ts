import fs from 'node:fs/promises';
import path from 'node:path';
import type { BranchEntry } from '../types.js';
import type { OrphanWorktreeFs } from './janitor.js';
import { WorktreeService } from './worktree.js';
import { worktreePathActivity, sameWorktreeDirectoryIdentity, WorktreeClaimHeldError, type WorktreeDirectoryIdentity } from './worktree-path-activity.js';
import { inspectDeploymentSource, SourceInspectionHeldError, SOURCE_HOLD_REASONS, type SourceHoldReason } from './deployment-source-inspection.js';

export interface DeploymentSourceRetentionReport {
  dataObservations?: Array<{ projectId: string; sourceIdentity: string; dataIdentity: string; marker: string; device: number; inode: number; birthtimeMs?: number }>;
  scanned: number; attempted: number; removed: string[]; held: Record<string, string>;
  failed: Array<{ path: string; error: string }>; deferred: number;
  lastAttemptedPath?: string;
  lastScannedPath?: string;
  preview?: Array<{ path: string; allocatedBytes: number }>;
  cancelled?: boolean;
  filesystem?: { beforeAvailableBytes: number | null; afterAvailableBytes: number | null; netAvailableBytesDelta: number | null; measurement: 'filesystem-net-change' };
}
export type DeploymentSourceHoldReason = 'filesystem-unknown' | 'identity-unknown' | 'age-or-claim-unconfirmed'
  | 'container-mounted' | 'in-use' | 'identity-or-mount-unconfirmed' | 'protected-or-unconfirmed' | SourceHoldReason;

/** Public counters only: never copy host paths or worker error text into the snapshot. */
export function summarizeDeploymentSourceHolds(held: Record<string, string>): Partial<Record<DeploymentSourceHoldReason, number>> {
  const known = new Map<string, DeploymentSourceHoldReason>([
    ['无法确认部署源码基础目录，本轮保留', 'filesystem-unknown'],
    ['无法确认部署源码目录，本轮保留', 'filesystem-unknown'],
    ['无法完整读取部署源码桶', 'filesystem-unknown'],
    ['无法读取部署源码目录', 'filesystem-unknown'],
    ['目录归属无法确认', 'identity-unknown'],
    ['目录过新、正在部署、台账引用或容器挂载', 'age-or-claim-unconfirmed'],
    ['容器挂载枚举未完整确认，本轮不回收部署源码', 'identity-or-mount-unconfirmed'],
    ['运行或停止的容器仍挂载该目录', 'container-mounted'],
    ['源码正在准备、使用或回收', 'in-use'],
    ['目录被认领或对象已变化', 'identity-or-mount-unconfirmed'],
    ['临删挂载、归属或目录身份未确认', 'identity-or-mount-unconfirmed'],
  ]);
  const counts: Partial<Record<DeploymentSourceHoldReason, number>> = {};
  for (const reason of Object.values(held)) {
    const code = SOURCE_HOLD_REASONS.includes(reason as SourceHoldReason) ? reason as SourceHoldReason
      : known.get(reason) ?? 'protected-or-unconfirmed';
    counts[code] = (counts[code] || 0) + 1;
  }
  return counts;
}

const related = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUSY = new Set(['building', 'starting', 'stopping', 'restarting', 'preparing', 'provisioning']);

/** Only detached UUID leaves are eligible; the ordinary orphan collector never owns these buckets. */
export async function reclaimDeploymentSources(input: {
  base: string; projectIds: string[]; branches: () => BranchEntry[];
  files: OrphanWorktreeFs; nowMs: number; maxRemovals?: number; minAgeMs?: number; afterPath?: string;
  dryRun?: boolean; signal?: AbortSignal;
}): Promise<DeploymentSourceRetentionReport> {
  const report: DeploymentSourceRetentionReport = { scanned: 0, attempted: 0, removed: [], held: {}, failed: [], deferred: 0 };
  const requested = input.maxRemovals ?? 20;
  const max = Number.isSafeInteger(requested) ? Math.max(1, Math.min(20, requested)) : 20;
  const minAge = input.minAgeMs ?? 2 * 3600_000;
  if (input.dryRun) report.preview = [];
  const isClaimed = (dir: string) => input.branches().some(b =>
    (BUSY.has(b.status) && b.worktreePath && related(dir, WorktreeService.deploymentSourceRootFor(b.worktreePath)))
    || Object.values(b.services || {}).some(s => s.sourceCheckoutPath && related(dir, path.resolve(s.sourceCheckoutPath))));
  const isMounted = (dir: string, paths: string[]) => paths.some(p => related(dir, path.resolve(p)));
  const realBase = await fs.realpath(input.base).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') report.held[input.base] = '无法确认部署源码基础目录，本轮保留';
    return null;
  });
  if (!realBase) return report;
  const isDirectory = async (dir: string): Promise<boolean> => {
    try {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory()) report.held[dir] = '目录归属无法确认';
      return stat.isDirectory();
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report.held[dir] = '无法确认部署源码目录，本轮保留';
      return false;
    }
  };
  const candidates: Array<{ dir: string; mtime: number; identity: WorktreeDirectoryIdentity }> = [];
  const sourceDirs: string[] = [];
  for (const project of new Set(input.projectIds)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(project) || project === '..') continue;
    const projectDir = path.join(input.base, project), root = path.join(projectDir, '.deployment-sources');
    // No symlinked project, source bucket, branch bucket, or leaf can widen the deletion boundary.
    if (!await isDirectory(projectDir) || !await isDirectory(root)) continue;
    const roots = await fs.readdir(root, { withFileTypes: true }).catch(() => null);
    if (!roots) { report.held[root] = '无法完整读取部署源码桶'; continue; }
    for (const bucket of roots) {
      if (!bucket.isDirectory()) { if (bucket.isSymbolicLink()) report.held[path.join(root, bucket.name)] = '目录归属无法确认'; continue; }
      const bucketPath = path.join(root, bucket.name);
      const leaves = await fs.readdir(bucketPath, { withFileTypes: true }).catch(() => null);
      if (!leaves) { report.held[bucketPath] = '无法读取部署源码目录'; continue; }
      for (const leaf of leaves) {
        if (!UUID.test(leaf.name)) continue;
        if (!leaf.isDirectory()) { report.held[path.join(bucketPath, leaf.name)] = '目录归属无法确认'; continue; }
        sourceDirs.push(path.join(bucketPath, leaf.name));
      }
    }
  }
  sourceDirs.sort();
  const next = input.afterPath ? sourceDirs.findIndex(dir => dir > input.afterPath!) : 0;
  const start = next < 0 ? 0 : next;
  const scanOrder = [...sourceDirs.slice(start), ...sourceDirs.slice(0, start)];
  for (const [index, dir] of scanOrder.entries()) {
    if (input.signal?.aborted) { report.cancelled = true; report.deferred += scanOrder.length - index; break; }
    if (report.scanned >= 1024) { report.deferred++; continue; }
    report.scanned++; report.lastScannedPath = dir;
    const identity = await input.files.readDirectoryIdentity?.(dir);
    const expectedPath = path.join(realBase, path.relative(path.resolve(input.base), path.resolve(dir)));
    if (!identity || identity.entryPath !== expectedPath) { report.held[dir] = '目录归属无法确认'; continue; }
    // Observe data before age/current-use filtering: those protections must not hide migration debt.
    let dataDetected = false;
    for (const marker of ['.cds-data', '.cds-run-data']) {
      const location = path.join(dir, marker);
      try {
        const entry = await fs.lstat(location);
        dataDetected = true;
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          (report.dataObservations ??= []).push({ projectId: path.relative(input.base, dir).split(path.sep)[0],
            sourceIdentity: path.relative(input.base, dir), dataIdentity: path.relative(input.base, location), marker, device: entry.dev, inode: entry.ino, birthtimeMs: entry.birthtimeMs });
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { dataDetected = true;report.held[dir] = 'persistent-data-query-unconfirmed'; } }
    }
    if (dataDetected) { report.held[dir] ??= 'persistent-data';continue; }
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
  let previewed = 0;
  const available = async () => {
    try { const device = (await fs.stat(input.base)).dev, s = await fs.statfs(input.base);
      return { device, bytes: s.bavail * s.bsize }; } catch { return null; }
  };
  const before = await available();
  for (const [index, {dir, identity}] of candidates.entries()) {
    if (input.signal?.aborted) { report.cancelled = true; report.deferred += candidates.length - index; break; }
    if (isMounted(dir, mounted)) { report.held[dir] = '运行或停止的容器仍挂载该目录'; continue; }
    if ((input.dryRun ? previewed : report.attempted) >= max) { report.deferred++; continue; }
    const activity = worktreePathActivity.tryAcquire([dir]);
    if (!activity) { report.held[dir] = '源码正在准备、使用或回收'; continue; }
    let uncertain = false;
    try {
      if (!activity.extend([identity.entryPath]) || isClaimed(dir)) { report.held[dir] = '目录被认领或对象已变化'; continue; }
      const freshMounts = await input.files.listMountedHostPaths();
      const current = await input.files.readDirectoryIdentity?.(dir);
      if (freshMounts === null || isMounted(dir, freshMounts) || isClaimed(dir)
        || !current || !sameWorktreeDirectoryIdentity(identity, current)) { report.held[dir] = '临删挂载、归属或目录身份未确认'; continue; }
      if (input.dryRun) {
        previewed++;
        const proof = await inspectDeploymentSource(dir, identity, true, input.signal);
        if (proof.reason || proof.allocatedBytes === undefined) report.held[dir] = proof.reason ?? 'size-query-failed';
        else report.preview!.push({ path: dir, allocatedBytes: proof.allocatedBytes });
        continue;
      }
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
      report.held[dir] = error instanceof SourceInspectionHeldError ? error.reason : '源码回收未确认，保留目录与占用';
    } finally { if (!uncertain) activity.release(); }
  }
  const after = await available();
  if (input.signal?.aborted) report.cancelled = true;
  report.filesystem = { beforeAvailableBytes: before?.bytes ?? null, afterAvailableBytes: after?.bytes ?? null,
    netAvailableBytesDelta: !before || !after || before.device !== after.device ? null : after.bytes - before.bytes,
    measurement: 'filesystem-net-change' };
  return report;
}
