/**
 * 分支自定义分组的规范化与校验（唯一入口）。
 *
 * 路由只管收、存、回；「什么样的分组定义是合法的」全部在这里判定，
 * 前端编辑器与 Agent 直接调接口走的是同一套口径。
 *
 * 规范化而不是一味拒收：名字与规则值去首尾空白、同一分支被钉进多个组时只留第一个
 * （一个分支只归一组，这是认领顺序的前提）；真正说不通的输入（颜色不在五色里、
 * 规则类型未知、超上限）才 400，并指出是哪一组哪一项。
 */
import type { BranchGroup, BranchGroupColor, BranchGroupRule, BranchGroupRuleKind } from '../types.js';

export const BRANCH_GROUP_COLORS: readonly BranchGroupColor[] = ['orange', 'blue', 'green', 'purple', 'gray'];
export const BRANCH_GROUP_RULE_KINDS: readonly BranchGroupRuleKind[] = ['prefix', 'contains', 'equals', 'tag'];

export const BRANCH_GROUP_LIMITS = {
  groups: 30,
  nameLength: 40,
  rulesPerGroup: 20,
  ruleValueLength: 100,
  pinsPerGroup: 200,
  /** 单个钉入分支 id 的最大长度（CDS 分支 id 是 slug，只含字母、数字、. _ - /） */
  pinIdLength: 200,
} as const;

export type NormalizeBranchGroupsResult =
  | { ok: true; groups: BranchGroup[] }
  | { ok: false; field: string; message: string };

function fail(field: string, message: string): NormalizeBranchGroupsResult {
  return { ok: false, field, message };
}

export function normalizeBranchGroups(input: unknown): NormalizeBranchGroupsResult {
  if (!Array.isArray(input)) return fail('groups', 'groups 必须是数组');
  if (input.length > BRANCH_GROUP_LIMITS.groups) {
    return fail('groups', `分组最多 ${BRANCH_GROUP_LIMITS.groups} 个`);
  }
  const groups: BranchGroup[] = [];
  const seenIds = new Set<string>();
  const pinnedAnywhere = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index] as Partial<BranchGroup> | null;
    const at = `groups[${index}]`;
    if (!raw || typeof raw !== 'object') return fail(at, '分组必须是对象');
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(`${at}.id`, 'id 只能用字母、数字、- 和 _，最长 64');
    // 页面用 __ungrouped__ 表示「未归组」这个虚拟分区（区块 key、收起记忆、拖放落点），真分组不许占用（Codex P2，PR #1647）。
    if (id === '__ungrouped__') return fail(`${at}.id`, 'id「__ungrouped__」是保留字，表示未归组分区');
    if (seenIds.has(id)) return fail(`${at}.id`, `分组 id「${id}」重复`);
    seenIds.add(id);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return fail(`${at}.name`, '分组名不能为空');
    if (name.length > BRANCH_GROUP_LIMITS.nameLength) {
      return fail(`${at}.name`, `分组名最长 ${BRANCH_GROUP_LIMITS.nameLength} 个字`);
    }
    if (!BRANCH_GROUP_COLORS.includes(raw.color as BranchGroupColor)) {
      return fail(`${at}.color`, `颜色必须是：${BRANCH_GROUP_COLORS.join(' | ')}`);
    }
    const rawRules = raw.rules ?? [];
    if (!Array.isArray(rawRules)) return fail(`${at}.rules`, 'rules 必须是数组');
    if (rawRules.length > BRANCH_GROUP_LIMITS.rulesPerGroup) {
      return fail(`${at}.rules`, `每个分组最多 ${BRANCH_GROUP_LIMITS.rulesPerGroup} 条规则`);
    }
    const rules: BranchGroupRule[] = [];
    for (let ruleIndex = 0; ruleIndex < rawRules.length; ruleIndex += 1) {
      const rule = rawRules[ruleIndex] as Partial<BranchGroupRule> | null;
      const ruleAt = `${at}.rules[${ruleIndex}]`;
      if (!rule || !BRANCH_GROUP_RULE_KINDS.includes(rule.kind as BranchGroupRuleKind)) {
        return fail(`${ruleAt}.kind`, `规则类型必须是：${BRANCH_GROUP_RULE_KINDS.join(' | ')}`);
      }
      const value = typeof rule.value === 'string' ? rule.value.trim() : '';
      // 空值规则是编辑器里「新加了一行还没填」，丢掉而不是拒收整次保存。
      if (!value) continue;
      if (value.length > BRANCH_GROUP_LIMITS.ruleValueLength) {
        return fail(`${ruleAt}.value`, `规则值最长 ${BRANCH_GROUP_LIMITS.ruleValueLength} 个字`);
      }
      rules.push({ kind: rule.kind as BranchGroupRuleKind, value });
    }
    const rawPins = raw.pinnedBranchIds ?? [];
    if (!Array.isArray(rawPins)) return fail(`${at}.pinnedBranchIds`, 'pinnedBranchIds 必须是数组');
    if (rawPins.length > BRANCH_GROUP_LIMITS.pinsPerGroup) {
      return fail(`${at}.pinnedBranchIds`, `每个分组最多钉入 ${BRANCH_GROUP_LIMITS.pinsPerGroup} 个分支`);
    }
    const pinnedBranchIds: string[] = [];
    for (const pin of rawPins) {
      if (typeof pin !== 'string' || !pin.trim()) continue;
      const branchId = pin.trim();
      // 钉入 id 必须像真实分支 id：限定字符集与长度。否则 Agent 直接调接口时，每个 id 都能任意长，
      // 30 组 × 200 个钉入在校验上合法、整体却超出路由 2MB 的解析上限，先被拦成 413 而不是 400（Codex P2，PR #1647）。
      // 限定为不需要 JSON 转义的字符，才能从上限推出请求体的最大体积。
      if (!/^[A-Za-z0-9._/-]+$/.test(branchId) || branchId.length > BRANCH_GROUP_LIMITS.pinIdLength) {
        return fail(`${at}.pinnedBranchIds`, `钉入的分支 id 只能含字母、数字、. _ - /，最长 ${BRANCH_GROUP_LIMITS.pinIdLength} 个字符（收到「${branchId.slice(0, 40)}」）`);
      }
      // 一个分支只归一组：已被前面的组钉走的，这里丢掉。
      if (pinnedAnywhere.has(branchId)) continue;
      pinnedAnywhere.add(branchId);
      pinnedBranchIds.push(branchId);
    }
    groups.push({ id, name, color: raw.color as BranchGroupColor, rules, pinnedBranchIds });
  }
  return { ok: true, groups };
}
