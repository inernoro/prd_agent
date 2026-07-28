/**
 * 孤儿 worktree 对账（2026-07-27 宕机复盘 P2）。
 *
 * janitor 的 sweep 只遍历 `stateService.getAllBranches()`——也就是说它只看得见
 * **台账里还有记录**的分支。磁盘上「目录还在、台账里已经没有对应分支」的 worktree
 * 完全在它的视野之外：分支删除半途失败、项目被删、CDS 崩在创建过程中、手工 clone
 * 的残留，都会留下这种目录。事故当天宿主 `.cds-worktrees` 已经 45.5GB，而按 TTL
 * 够格删的分支只有 3 个——TTL 那条路径**根本够不着**这部分空间。
 *
 * 目录布局是 `<base>/<projectId>/<branchSlug>`（WorktreeService.worktreePathFor），
 * 所以对账就是一次两层目录枚举与台账 worktreePath 集合求差。
 *
 * 判定做成纯函数：真实的 readdir / stat / rm 由调用方注入，测试不碰磁盘。
 */

/** 磁盘上枚举到的一个 worktree 目录。 */
export interface DiskWorktreeDir {
  /** 绝对路径（与 BranchEntry.worktreePath 同一形态，便于直接比对）。 */
  path: string;
  /** 目录最后修改时间（毫秒）。用于「太新的不碰」这条竞态护栏。 */
  mtimeMs: number;
}

export interface OrphanWorktreeInput {
  /** 磁盘上枚举到的全部 worktree 目录。 */
  diskDirs: readonly DiskWorktreeDir[];
  /** 台账里所有分支声明的 worktreePath。 */
  claimedPaths: readonly string[];
  nowMs: number;
  /**
   * 目录新于这个年龄就不动（默认 2 小时）。分支创建是「先建目录、后写台账」的
   * 多步过程，CDS 又可能在中间重启；没有这条护栏，对账会把**正在创建**的分支
   * 目录当成孤儿删掉，比不清理危险得多。
   */
  minAgeMs?: number;
  /** 单轮最多删几个，避免一次 sweep 长时间占住磁盘 IO。 */
  maxRemovals?: number;
  /**
   * 当前被任何容器（含已停止）bind-mount 的宿主路径。
   *
   * 容器把 worktree 目录挂进去当源码目录，所以「台账里没有这个分支」不等于
   * 「没有容器在用这个目录」——分支记录先被删、容器还没被收割的窗口里，删掉目录
   * 会让那个还在跑的容器当场瞎掉。台账之外再加这一层物理占用检查。
   */
  mountedPaths?: readonly string[];
}

export interface OrphanWorktreePlan {
  /** 本轮可安全删除的目录。 */
  remove: string[];
  /** 保留原因（path → 原因），供 /api/janitor/state 举证「为什么没删」。 */
  keptReasons: Record<string, string>;
  /** 判定为孤儿但被单轮上限截断的数量——如实报出，不让「跑过了」被误读成「清干净了」。 */
  deferred: number;
}

export const DEFAULT_ORPHAN_WORKTREE_MIN_AGE_MS = 2 * 60 * 60_000;
export const DEFAULT_ORPHAN_WORKTREE_MAX_REMOVALS = 20;

/** 归一化路径：去掉末尾斜杠，便于两侧集合直接比对。 */
export function normalizeWorktreePath(p: string): string {
  const s = (p || '').trim().replace(/\/+$/, '');
  return s;
}

/**
 * 算出本轮可回收的孤儿 worktree 目录。
 *
 * 「孤儿」的唯一判据是**没有任何台账分支声明这个路径**。刻意不去解析目录名反推
 * branchId：slug 与 branchId 之间的映射随历史版本变过（扁平布局 → 项目嵌套布局），
 * 靠名字反推会在存量数据上误判；而 worktreePath 是分支自己写下的、当下就在用的
 * 事实，拿它做集合差最稳。
 */
export function computeOrphanWorktreePlan(input: OrphanWorktreeInput): OrphanWorktreePlan {
  const minAgeMs = input.minAgeMs ?? DEFAULT_ORPHAN_WORKTREE_MIN_AGE_MS;
  const maxRemovals = Math.max(0, input.maxRemovals ?? DEFAULT_ORPHAN_WORKTREE_MAX_REMOVALS);
  const claimed = new Set(input.claimedPaths.map(normalizeWorktreePath).filter(Boolean));
  const mounted = (input.mountedPaths || []).map(normalizeWorktreePath).filter(Boolean);
  const keptReasons: Record<string, string> = {};
  const orphans: string[] = [];
  // 挂载点可能是 worktree 目录本身，也可能是它下面的子目录（compose 常挂子路径），
  // 故用前缀判定而不是相等判定。
  const isMounted = (dir: string): boolean =>
    mounted.some((m) => m === dir || m.startsWith(`${dir}/`));

  for (const dir of input.diskDirs) {
    const p = normalizeWorktreePath(dir.path);
    if (!p) continue;
    if (claimed.has(p)) {
      keptReasons[p] = '台账中有分支正在使用';
      continue;
    }
    if (isMounted(p)) {
      keptReasons[p] = '有容器正挂载该目录（先收割容器再回收目录）';
      continue;
    }
    const ageMs = input.nowMs - dir.mtimeMs;
    if (!Number.isFinite(ageMs) || ageMs < minAgeMs) {
      // 时间读不出来也按「太新」处理：宁可漏删，不可误删正在创建的分支
      keptReasons[p] = `目录过新（${Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : '未知'} 分钟），可能正在创建中`;
      continue;
    }
    orphans.push(p);
  }

  const remove = orphans.slice(0, maxRemovals);
  for (const p of orphans.slice(maxRemovals)) {
    keptReasons[p] = '本轮上限截断，下轮继续';
  }
  return { remove, keptReasons, deferred: Math.max(0, orphans.length - remove.length) };
}
