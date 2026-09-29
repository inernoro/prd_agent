/**
 * 分支自定义分组（2026-09-29）的判定与接线守卫。
 *
 * 1. 归组判定是纯函数（lib/branchGroups），直接测行为：钉入优先于规则、规则按分组顺序认领、
 *    一个分支只归一组、编辑器预览把「被上方分组占用」的单独列出、首次建组建议的默认勾选。
 * 2. 前后端各有一份颜色与规则类型枚举（后端校验、前端编辑器），这里比对两份一致——
 *    漂了就会出现「界面能选、保存 400」或「后端收、界面画不出」。
 * 3. 页面接线测不了行为（要真浏览器，见 scripts/branch-card-visual-audit.mjs 的分组段），
 *    只钉「删掉就会静默退化」的几处，并配红用例证明判据不空。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BRANCH_GROUP_COLORS,
  BRANCH_GROUP_RULE_KINDS,
  assignBranchToGroup,
  groupBranches,
  moveGroupBefore,
  pinBranch,
  previewGroupHits,
  ruleMatches,
  suggestPrefixGroups,
  type BranchGroup,
} from '../../web/src/lib/branchGroups';
import {
  BRANCH_GROUP_COLORS as SERVER_COLORS,
  BRANCH_GROUP_RULE_KINDS as SERVER_RULE_KINDS,
} from '../../src/services/branch-groups';
import { expectGuardRedOnMutation, mutate } from '../helpers/guard-mutation.js';

const WEB_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const read = (relative: string): string => fs.readFileSync(path.join(WEB_SRC, relative), 'utf-8');

const b = (id: string, branch: string, tags: string[] = []) => ({ id, branch, tags });
const group = (id: string, rules: BranchGroup['rules'], pinnedBranchIds: string[] = []): BranchGroup => ({
  id,
  name: id.toUpperCase(),
  color: 'gray',
  rules,
  pinnedBranchIds,
});

describe('归组判定：钉入 > 规则按分组顺序 > 未归组', () => {
  it('四种规则各自的匹配口径', () => {
    const branch = b('1', 'claude/login-fix', ['登录重构']);
    expect(ruleMatches({ kind: 'prefix', value: 'claude/' }, branch)).toBe(true);
    expect(ruleMatches({ kind: 'prefix', value: 'codex/' }, branch)).toBe(false);
    expect(ruleMatches({ kind: 'contains', value: 'login' }, branch)).toBe(true);
    expect(ruleMatches({ kind: 'equals', value: 'claude/login' }, branch)).toBe(false);
    expect(ruleMatches({ kind: 'equals', value: 'claude/login-fix' }, branch)).toBe(true);
    expect(ruleMatches({ kind: 'tag', value: '#登录重构' }, branch)).toBe(true);
    // 空值规则不命中任何分支（编辑器里新加了一行还没填）
    expect(ruleMatches({ kind: 'contains', value: '  ' }, branch)).toBe(false);
  });

  it('规则都命中时，靠上的分组认领', () => {
    const groups = [group('release', [{ kind: 'contains', value: 'release' }]), group('claude', [{ kind: 'prefix', value: 'claude/' }])];
    expect(assignBranchToGroup(groups, b('1', 'claude/release-notes'))).toEqual({ groupId: 'release', via: 'rule' });
    expect(assignBranchToGroup(moveGroupBefore(groups, 'claude', 'release'), b('1', 'claude/release-notes'))).toEqual({ groupId: 'claude', via: 'rule' });
  });

  it('钉入优先于任何规则，哪怕规则所在的组更靠上', () => {
    const groups = [group('claude', [{ kind: 'prefix', value: 'claude/' }]), group('hot', [], ['1'])];
    expect(assignBranchToGroup(groups, b('1', 'claude/x'))).toEqual({ groupId: 'hot', via: 'pin' });
  });

  it('分区保持传入顺序，一个分支只出现在一处', () => {
    const groups = [group('claude', [{ kind: 'prefix', value: 'claude/' }]), group('codex', [{ kind: 'prefix', value: 'codex/' }])];
    const list = [b('1', 'claude/a'), b('2', 'main'), b('3', 'codex/b'), b('4', 'claude/c')];
    const result = groupBranches(groups, list);
    expect(result.sections.map((section) => section.branches.map((item) => item.id))).toEqual([['1', '4'], ['3']]);
    expect(result.ungrouped.map((item) => item.id)).toEqual(['2']);
    const all = [...result.sections.flatMap((section) => section.branches), ...result.ungrouped].map((item) => item.id);
    expect(new Set(all).size).toBe(list.length);
  });

  it('钉入是排他的：钉进新组会从旧组拿掉；传 null 取消钉入', () => {
    const groups = [group('a', [], ['1']), group('b', [])];
    const moved = pinBranch(groups, '1', 'b');
    expect(moved.map((item) => item.pinnedBranchIds)).toEqual([[], ['1']]);
    expect(pinBranch(moved, '1', null).map((item) => item.pinnedBranchIds)).toEqual([[], []]);
  });

  it('编辑器预览：命中的算进来，被上方分组或别组钉入先认领的单独列出', () => {
    const groups = [group('release', [{ kind: 'contains', value: 'release' }]), group('claude', [{ kind: 'prefix', value: 'claude/' }], [])];
    const list = [b('1', 'claude/a'), b('2', 'claude/release-notes'), b('3', 'main')];
    const preview = previewGroupHits(groups, groups[1], list);
    expect(preview.hits.map((item) => item.id)).toEqual(['1']);
    expect(preview.taken.map(({ branch, groupName }) => [branch.id, groupName])).toEqual([['2', 'RELEASE']]);
    // 还没保存的新分组：排在最后参与认领
    const draft = group('new', [{ kind: 'equals', value: 'main' }]);
    expect(previewGroupHits(groups, draft, list).hits.map((item) => item.id)).toEqual(['3']);
  });
});

describe('首次建组建议', () => {
  it('按前缀计数，多的在前；只有 1 个分支的前缀默认不勾；认识的前缀给中文组名', () => {
    const list = [b('1', 'claude/a'), b('2', 'claude/b'), b('3', 'codex/c'), b('4', 'codex/d'), b('5', 'codex/e'), b('6', 'feat/x'), b('7', 'main')];
    const suggestions = suggestPrefixGroups(list);
    expect(suggestions.map((item) => [item.prefix, item.count, item.defaultChecked])).toEqual([
      ['codex/', 3, true],
      ['claude/', 2, true],
      ['feat/', 1, false],
    ]);
    expect(suggestions.find((item) => item.prefix === 'claude/')?.name).toBe('Claude 在做');
    // 默认色不落到灰：灰留给未归组
    expect(suggestions.every((item) => item.color !== 'gray')).toBe(true);
  });

  it('分支名都没有前缀时不给建议', () => {
    expect(suggestPrefixGroups([b('1', 'main'), b('2', 'test')])).toEqual([]);
  });
});

describe('前后端枚举一致', () => {
  it('颜色与规则类型两边完全相同', () => {
    expect([...BRANCH_GROUP_COLORS]).toEqual([...SERVER_COLORS]);
    expect([...BRANCH_GROUP_RULE_KINDS]).toEqual([...SERVER_RULE_KINDS]);
  });

  it('每个颜色在两个主题里都定义了 token，组头色块类名写全', () => {
    const css = read('index.css');
    const header = read('components/branch-groups/BranchGroupHeader.tsx');
    for (const color of BRANCH_GROUP_COLORS) {
      expect(css.match(new RegExp(`--group-${color}:`, 'g')), color).toHaveLength(2);
      expect(header).toContain(`bg-[hsl(var(--group-${color}))]`);
    }
  });
});

describe('页面接线', () => {
  const page = read('pages/BranchListPage.tsx');

  // 页头一句话与每个组头共用 summarizeBranchStates：两处各写一份，组头的「出错」就会和页头对不上。
  const summaryShared = (source: string) => {
    expect(source.match(/function summarizeBranchStates\(/g)).toHaveLength(1);
    expect(source).toContain('const { parts, queued, slot } = summarizeBranchStates(branches, actions);');
    expect(source).toContain('const summary = summarizeBranchStates(list, actions);');
  };

  it('页头汇总与组头汇总走同一个统计函数', () => {
    summaryShared(page);
  });

  it('红用例：组头另写一份汇总，守卫变红', () => {
    expectGuardRedOnMutation(
      summaryShared,
      page,
      mutate(page, 'const summary = summarizeBranchStates(list, actions);', 'const summary = { parts: [] as BranchGroupSummaryPart[] };'),
    );
  });

  // 分区只走 lib/branchGroups：页面里不许另写匹配逻辑。
  const groupingFromLib = (source: string) => {
    expect(source).toContain('const groupedBranches = useMemo(() => groupBranches(groupList, sortedBranches), [groupList, sortedBranches]);');
    expect(source).not.toMatch(/\.startsWith\(rule\.value/);
  };

  it('分区只走 groupBranches 一个判定源', () => {
    groupingFromLib(page);
  });

  it('红用例：分区改成页面里自己匹配，守卫变红', () => {
    expectGuardRedOnMutation(
      groupingFromLib,
      page,
      mutate(
        page,
        'const groupedBranches = useMemo(() => groupBranches(groupList, sortedBranches), [groupList, sortedBranches]);',
        'const groupedBranches = useMemo(() => groupBranches(groupList, sortedBranches.filter((x) => x.branch.startsWith(rule.value))), [groupList, sortedBranches]);',
      ),
    );
  });

  // 保存走乐观并发：带 baseUpdatedAt，409 时载入最新版本并说清楚，不静默覆盖别人的修改。
  const saveWithConcurrency = (source: string) => {
    expect(source).toContain("{ method: 'PUT', body: { groups: nextGroups, baseUpdatedAt: before?.updatedAt ?? null } }");
    expect(source).toContain('error.status === 409 && body?.latest');
  };

  it('保存带版本号，冲突时载入最新并提示', () => {
    saveWithConcurrency(page);
  });

  it('红用例：保存不带版本号，守卫变红', () => {
    expectGuardRedOnMutation(
      saveWithConcurrency,
      page,
      mutate(page, 'body: { groups: nextGroups, baseUpdatedAt: before?.updatedAt ?? null }', 'body: { groups: nextGroups }'),
    );
  });

  it('卡片拿到分组菜单、当前组、钉入组名与可拖动开关', () => {
    expect(page).toContain('groupMenu={groupMenu}');
    expect(page).toContain('draggableToGroup={groupedView}');
    expect(page).toContain('draggable={draggableToGroup || undefined}');
    expect(page).toContain('revealInGroupsRef.current(branchId);');
  });
});
