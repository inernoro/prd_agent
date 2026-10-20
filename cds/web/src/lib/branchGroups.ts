/*
 * 分支自定义分组的唯一判定源（2026-09-29）。
 *
 * 一个分支只归一组，认领顺序固定：
 *   1. 手动钉入（拖进组、或卡片菜单「移到分组」）——优先于任何规则
 *   2. 规则：按分组在页面上的顺序，第一个命中的组认领
 *   3. 都没命中：未归组
 *
 * 页面分区、编辑器里的「现在命中 N 个 / 被上方分组占用」、首次建组建议都从这里取，
 * 不许在页面里另写一份匹配逻辑。分组定义的存取与校验在后端
 * （cds/src/services/branch-groups.ts），两边的颜色与规则类型枚举由守卫测试比对一致。
 */

export type BranchGroupColor = 'orange' | 'blue' | 'green' | 'purple' | 'gray';
export type BranchGroupRuleKind = 'prefix' | 'contains' | 'equals' | 'tag';

export const BRANCH_GROUP_COLORS: readonly BranchGroupColor[] = ['orange', 'blue', 'green', 'purple', 'gray'];
export const BRANCH_GROUP_RULE_KINDS: readonly BranchGroupRuleKind[] = ['prefix', 'contains', 'equals', 'tag'];

/** 与后端 BRANCH_GROUP_LIMITS 同值（守卫测试比对）：界面不许给出后端必然拒绝的操作。 */
export const BRANCH_GROUP_LIMITS = {
  groups: 30,
  nameLength: 40,
  rulesPerGroup: 20,
  ruleValueLength: 100,
  pinsPerGroup: 200,
  /**
   * 单个钉入分支 id 的最大长度。CDS 能建出的最长分支 id 是「项目 slug（≤50）- 分支名 slug（≤255）」= 306，
   * 上限必须盖住它，否则长分支名的分支拖进分组必被拒（Codex P2，PR #1647）。
   */
  pinIdLength: 320,
} as const;

export const BRANCH_GROUP_COLOR_LABELS: Record<BranchGroupColor, string> = {
  orange: '橙',
  blue: '蓝',
  green: '绿',
  purple: '紫',
  gray: '灰',
};

export const BRANCH_GROUP_RULE_LABELS: Record<BranchGroupRuleKind, string> = {
  prefix: '分支名以…开头',
  contains: '分支名包含',
  equals: '分支名完全等于',
  tag: '带标签',
};

export interface BranchGroupRule {
  kind: BranchGroupRuleKind;
  value: string;
}

export interface BranchGroup {
  id: string;
  name: string;
  color: BranchGroupColor;
  rules: BranchGroupRule[];
  pinnedBranchIds: string[];
}

export interface BranchGroupsSettings {
  groups: BranchGroup[];
  updatedAt: string | null;
  updatedBy: string | null;
  /** 父实例镜像来的项目（预览实例里）：只能看，不能改 */
  readOnly?: boolean;
}

/** 判定只需要分支的这三样。 */
export interface GroupableBranch {
  id: string;
  branch: string;
  tags?: string[];
}

export type GroupAssignment = { groupId: string; via: 'pin' | 'rule' };

export function ruleMatches(rule: BranchGroupRule, branch: GroupableBranch): boolean {
  const value = rule.value.trim();
  if (!value) return false;
  switch (rule.kind) {
    case 'prefix':
      return branch.branch.startsWith(value);
    case 'contains':
      return branch.branch.includes(value);
    case 'equals':
      return branch.branch === value;
    case 'tag':
      return (branch.tags || []).includes(value.replace(/^#/, ''));
    default:
      return false;
  }
}

export function groupRulesMatch(group: BranchGroup, branch: GroupableBranch): boolean {
  return group.rules.some((rule) => ruleMatches(rule, branch));
}

/** 单个分支归哪组、是怎么归进去的；没归组返回 null。 */
export function assignBranchToGroup(groups: BranchGroup[], branch: GroupableBranch): GroupAssignment | null {
  const pinned = groups.find((group) => group.pinnedBranchIds.includes(branch.id));
  if (pinned) return { groupId: pinned.id, via: 'pin' };
  const byRule = groups.find((group) => groupRulesMatch(group, branch));
  return byRule ? { groupId: byRule.id, via: 'rule' } : null;
}

export interface GroupedBranches<T extends GroupableBranch> {
  /** 与 groups 同序；每组内保持传入顺序（页面已排好序）。 */
  sections: Array<{ group: BranchGroup; branches: T[] }>;
  ungrouped: T[];
  assignment: Map<string, GroupAssignment>;
}

export function groupBranches<T extends GroupableBranch>(groups: BranchGroup[], branches: T[]): GroupedBranches<T> {
  const byGroup = new Map<string, T[]>(groups.map((group) => [group.id, []]));
  const ungrouped: T[] = [];
  const assignment = new Map<string, GroupAssignment>();
  for (const branch of branches) {
    const hit = assignBranchToGroup(groups, branch);
    if (hit) {
      assignment.set(branch.id, hit);
      byGroup.get(hit.groupId)?.push(branch);
    } else {
      ungrouped.push(branch);
    }
  }
  return {
    sections: groups.map((group) => ({ group, branches: byGroup.get(group.id) || [] })),
    ungrouped,
    assignment,
  };
}

/**
 * 编辑器里的实时命中预览：把「正在编辑的这一组」放回它在列表中的位置算一遍，分三类——
 * 按规则归进来的（hits）、被上方分组或别组钉入先认领走的（taken，带认领组名）、
 * 本组手动钉入的（pinned，与规则命中分开列，不混进「命中 N 个」）。
 */
export function previewGroupHits<T extends GroupableBranch>(
  groups: BranchGroup[],
  draft: BranchGroup,
  branches: T[],
): { hits: T[]; pinned: T[]; taken: Array<{ branch: T; groupId: string; groupName: string }> } {
  const index = groups.findIndex((group) => group.id === draft.id);
  const list = index >= 0
    ? groups.map((group) => (group.id === draft.id ? draft : group))
    : [...groups, draft];
  const hits: T[] = [];
  const pinned: T[] = [];
  const taken: Array<{ branch: T; groupId: string; groupName: string }> = [];
  for (const branch of branches) {
    const owner = assignBranchToGroup(list, branch);
    if (owner?.groupId === draft.id) {
      (owner.via === 'pin' ? pinned : hits).push(branch);
    } else if (groupRulesMatch(draft, branch) && owner) {
      const name = list.find((group) => group.id === owner.groupId)?.name || '其他分组';
      taken.push({ branch, groupId: owner.groupId, groupName: name });
    }
  }
  return { hits, pinned, taken };
}

/** 分支名第一个「/」之前连同斜杠，没有斜杠返回 null。 */
export function branchPrefix(name: string): string | null {
  const slash = name.indexOf('/');
  return slash > 0 ? name.slice(0, slash + 1) : null;
}

const KNOWN_PREFIX_NAMES: Record<string, string> = {
  'claude/': 'Claude 在做',
  'codex/': 'Codex 在做',
  'cursor/': 'Cursor 在做',
  'release/': '发布线',
  'hotfix/': '热修',
  'feat/': '新功能',
  'feature/': '新功能',
  'fix/': '修复',
};

export interface PrefixSuggestion {
  prefix: string;
  count: number;
  name: string;
  color: BranchGroupColor;
  /** 只有 1 个分支的前缀默认不勾，免得一上来就一堆单卡小组。 */
  defaultChecked: boolean;
}

/** 第一次切到「按分组」时给的建议：按分支名前缀统计，多的在前。 */
export function suggestPrefixGroups(branches: GroupableBranch[]): PrefixSuggestion[] {
  const counts = new Map<string, number>();
  for (const branch of branches) {
    const prefix = branchPrefix(branch.branch);
    if (prefix) counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  return [...counts.entries()]
    // 超过规则值上限的前缀建不成规则（后端必拒），不作为可一键创建的建议给出（Codex P2，PR #1647）
    .filter(([prefix]) => prefix.length <= BRANCH_GROUP_LIMITS.ruleValueLength)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([prefix, count], index) => ({
      prefix,
      count,
      // 猜出来的组名按上限截断：输入框的 maxLength 不会截初始值，超长组名会让一键建组整个被拒
      name: (KNOWN_PREFIX_NAMES[prefix] || prefix.slice(0, -1)).slice(0, BRANCH_GROUP_LIMITS.nameLength),
      color: BRANCH_GROUP_COLORS[index % (BRANCH_GROUP_COLORS.length - 1)],
      defaultChecked: count >= 2,
    }));
}

export function newBranchGroupId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `g-${random}`;
}

/** 这个组还能不能再钉进这个分支：已经钉在里面的永远可以，否则看有没有到上限（每组 200 个）。 */
/**
 * 按后端的归一化口径（名字与规则值去空白、空规则丢掉）比较两份分组是否内容相同。
 * 编辑器用它挡住「打开、什么都没改、点保存」：那种保存会整份覆盖并推进版本号，
 * 让别人同时进行的真实修改白白撞上 409，修改记录也会谎称改过（Codex P2，PR #1647）。
 */
export function sameBranchGroupContent(a: BranchGroup, b: BranchGroup): boolean {
  const normalize = (group: BranchGroup) => JSON.stringify([
    group.id,
    group.name.trim(),
    group.color,
    group.rules
      .map((rule) => ({ kind: rule.kind, value: rule.value.trim() }))
      .filter((rule) => rule.value.length > 0)
      .map((rule) => [rule.kind, rule.value]),
    group.pinnedBranchIds,
  ]);
  return normalize(a) === normalize(b);
}

export function groupAcceptsPin(group: BranchGroup, branchId: string): boolean {
  return group.pinnedBranchIds.includes(branchId) || group.pinnedBranchIds.length < BRANCH_GROUP_LIMITS.pinsPerGroup;
}

/**
 * 把一个分支钉进某组（groupId 为 null = 取消钉入、回到按规则归组），同时从别组的钉入里拿掉。
 * 目标组已满时原样返回，不造出后端必然拒绝的列表（入口处另有提示，Codex P2，PR #1647）。
 */
export function pinBranch(groups: BranchGroup[], branchId: string, groupId: string | null): BranchGroup[] {
  const target = groupId ? groups.find((group) => group.id === groupId) : undefined;
  if (target && !groupAcceptsPin(target, branchId)) return groups;
  return groups.map((group) => {
    const without = group.pinnedBranchIds.filter((id) => id !== branchId);
    return {
      ...group,
      pinnedBranchIds: group.id === groupId ? [...without, branchId] : without,
    };
  });
}

/**
 * 拖组头松手后落在目标的哪一侧：往上拖在前面、往下拖在后面，原地或找不到返回 null。
 * 调序与拖动时的提示都只从这里取，提示不会和实际落点说反（Codex P2，PR #1647）。
 */
export function groupDropSide(groups: BranchGroup[], fromId: string, toId: string): 'before' | 'after' | null {
  if (fromId === toId) return null;
  const from = groups.findIndex((group) => group.id === fromId);
  const to = groups.findIndex((group) => group.id === toId);
  if (from < 0 || to < 0) return null;
  return from > to ? 'before' : 'after';
}

/**
 * 把 fromId 拖到 toId 的位置（拖组头调顺序）：往上拖放在目标前面，往下拖放在目标后面。
 * 只有「放在前面」一种时，拖到紧挨着的下一组等于原地不动，也没法挪到最后（Codex P2，PR #1647）。
 */
export function moveGroupOnto(groups: BranchGroup[], fromId: string, toId: string): BranchGroup[] {
  if (!groupDropSide(groups, fromId, toId)) return groups;
  const from = groups.findIndex((group) => group.id === fromId);
  const to = groups.findIndex((group) => group.id === toId);
  const next = groups.slice();
  const [moving] = next.splice(from, 1);
  next.splice(to, 0, moving);
  return next;
}
