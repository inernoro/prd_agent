import type { BranchEntry, Project } from '../types.js';

/**
 * branch-protection —— 「这条分支能不能被自动回收/驱逐」的**唯一判定源**（SSOT）。
 *
 * 2026-07-27 P0 事故：CDS 把主分支 main 直接删掉了。
 * 根因是同一件事在两处各写了一份，且两份不一致：
 *   - `scheduler.isPinned()` 有完整的主干保护（含按 **git 分支名** 判定的 isTrunkBranch）
 *   - `janitor.isBranchProtected()` 只比对 `defaultBranchId === branch.id`，**缺主干判定**
 * 于是当 `Project.defaultBranch`（存的是 CDS 分支 id）未配置或与实际不符时，
 * scheduler 认得出 main、janitor 认不出，janitor 的 sweep 就把 main 当过期分支
 * 连 state 条目带 worktree 一起删了。
 *
 * 因此这里把判定收敛成一份，scheduler / janitor / webhook 全部消费同一个函数：
 * 两处漂移在结构上不再可能发生。新增任何「会删分支 / 删 worktree」的路径时，
 * 一律先过 `resolveBranchProtection()`，不要再自己写一遍条件。
 */

/**
 * 主干分支的兜底名。仅在项目没有上报远端默认分支（`gitDefaultBranch`）时使用。
 * 这是「宁可少删、不可误删」的保守兜底：真有人把普通分支命名成 main/master，
 * 代价只是它不会被自动回收（可手动删），远小于误删主干。
 */
export const FALLBACK_TRUNK_BRANCH_NAMES = ['main', 'master'] as const;

/** 分支被保护的原因。用于报表/日志，让「为什么没删它」可解释。 */
export type BranchProtectionReason =
  | 'pinned-by-user'
  | 'color-marked'
  | 'default-branch'
  | 'config-pinned'
  | 'trunk-branch';

/**
 * 判定所需的最小 state 读取面。`StateService` 结构上即满足，
 * 测试可注入假实现而无需构造完整 state。
 */
export interface BranchProtectionLookup {
  getProject(idOrSlug: string): Project | undefined;
  /** per-project 默认分支（项目级值优先，未设回落到旧 state.defaultBranch）。 */
  getDefaultBranchFor(projectId?: string | null): string | null;
}

export interface BranchProtection {
  /** true = 禁止自动删除 / 自动降温。 */
  protected: boolean;
  /** 命中的第一个保护原因；未受保护为 null。 */
  reason: BranchProtectionReason | null;
}

/** 保护原因的中文说明（写进 sweep 报表与日志，运维不必读代码就知道为什么跳过）。 */
export function describeBranchProtectionReason(reason: BranchProtectionReason): string {
  switch (reason) {
    case 'pinned-by-user': return '用户已固定（pinnedByUser）';
    case 'color-marked': return '标记调试中（isColorMarked）';
    case 'default-branch': return '项目默认分支（defaultBranch）';
    case 'config-pinned': return '配置固定名单（pinnedBranches）';
    case 'trunk-branch': return '主干分支（仓库默认分支，永不自动删除）';
  }
}

/**
 * 该分支是否为「主干分支」（仓库默认分支）。**只按 git 分支名判定**：
 *   - 命中项目 `gitDefaultBranch`（远端上报的默认分支名，如 main/master）→ 是
 *   - 兜底：分支名恰为 main / master → 是
 *
 * 刻意不依赖 `Project.defaultBranch` —— 那存的是 CDS 分支 id（预览路由 fallback 用），
 * 可能未配置、也可能与真实主干不符，正是 main 被误降温 / 被误删的根因。
 */
export function isTrunkBranch(branch: BranchEntry, project?: Project | null): boolean {
  const branchName = (branch.branch || '').trim();
  if (!branchName) return false;
  const remoteDefault = (project?.gitDefaultBranch || '').trim();
  if (remoteDefault && branchName === remoteDefault) return true;
  return (FALLBACK_TRUNK_BRANCH_NAMES as readonly string[]).includes(branchName);
}

/**
 * 判定一条分支是否受保护，并给出原因。
 *
 * `lookup` 必须是 per-project 的（用 `branch.projectId` 查项目），不能传一个
 * 全局默认分支 id —— CDS 是多项目的，A 项目的主干不该因为 B 项目的配置而失去保护。
 */
export function resolveBranchProtection(
  branch: BranchEntry,
  lookup: BranchProtectionLookup,
  configPinned: readonly string[] = [],
): BranchProtection {
  if (branch.pinnedByUser) return { protected: true, reason: 'pinned-by-user' };
  if (branch.isColorMarked) return { protected: true, reason: 'color-marked' };
  if (lookup.getDefaultBranchFor(branch.projectId) === branch.id) {
    return { protected: true, reason: 'default-branch' };
  }
  if (configPinned.includes(branch.id)) return { protected: true, reason: 'config-pinned' };
  const project = branch.projectId ? lookup.getProject(branch.projectId) : undefined;
  if (isTrunkBranch(branch, project)) return { protected: true, reason: 'trunk-branch' };
  return { protected: false, reason: null };
}

/** 布尔快捷方式。需要展示原因时用 `resolveBranchProtection`。 */
export function isBranchProtected(
  branch: BranchEntry,
  lookup: BranchProtectionLookup,
  configPinned: readonly string[] = [],
): boolean {
  return resolveBranchProtection(branch, lookup, configPinned).protected;
}
