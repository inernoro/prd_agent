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
  BRANCH_GROUP_LIMITS,
  BRANCH_GROUP_RULE_KINDS,
  assignBranchToGroup,
  groupAcceptsPin,
  groupBranches,
  groupDropSide,
  moveGroupOnto,
  pinBranch,
  previewGroupHits,
  ruleMatches,
  suggestPrefixGroups,
  type BranchGroup,
} from '../../web/src/lib/branchGroups';
import {
  BRANCH_GROUP_COLORS as SERVER_COLORS,
  BRANCH_GROUP_LIMITS as SERVER_LIMITS,
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
    expect(assignBranchToGroup(moveGroupOnto(groups, 'claude', 'release'), b('1', 'claude/release-notes'))).toEqual({ groupId: 'claude', via: 'rule' });
  });

  it('建组建议不超后端上限：组名截到 40 字，超过 100 字的前缀不作为建议', () => {
    const longPrefix = `${'x'.repeat(60)}/`;
    const tooLong = `${'y'.repeat(120)}/`;
    const suggestions = suggestPrefixGroups([
      b('1', `${longPrefix}a`), b('2', `${longPrefix}b`),
      b('3', `${tooLong}a`), b('4', `${tooLong}b`),
    ]);
    const long = suggestions.find((item) => item.prefix === longPrefix);
    expect(long?.name.length).toBe(BRANCH_GROUP_LIMITS.nameLength);
    expect(suggestions.some((item) => item.prefix === tooLong)).toBe(false);
  });

  it('拖组头调序：往上放在目标前、往下放在目标后，拖到下一组能下移、拖到最后一组能挪到末尾', () => {
    const ids = (list: BranchGroup[]) => list.map((item) => item.id);
    const groups = [group('a', []), group('b', []), group('c', [])];
    expect(ids(moveGroupOnto(groups, 'a', 'b'))).toEqual(['b', 'a', 'c']);
    expect(ids(moveGroupOnto(groups, 'a', 'c'))).toEqual(['b', 'c', 'a']);
    expect(ids(moveGroupOnto(groups, 'c', 'a'))).toEqual(['c', 'a', 'b']);
    expect(ids(moveGroupOnto(groups, 'b', 'b'))).toEqual(['a', 'b', 'c']);
  });

  it('拖组头的提示说的一侧，就是调序后真正落的那一侧', () => {
    const ids = (list: BranchGroup[]) => list.map((item) => item.id);
    const groups = [group('a', []), group('b', []), group('c', [])];
    for (const from of ['a', 'b', 'c']) {
      for (const to of ['a', 'b', 'c']) {
        const side = groupDropSide(groups, from, to);
        const moved = ids(moveGroupOnto(groups, from, to));
        if (!side) {
          expect(moved).toEqual(['a', 'b', 'c']);
          continue;
        }
        const fromAt = moved.indexOf(from);
        const toAt = moved.indexOf(to);
        expect(side === 'before' ? fromAt === toAt - 1 : fromAt === toAt + 1).toBe(true);
      }
    }
    expect(groupDropSide(groups, 'a', 'b')).toBe('after');
    expect(groupDropSide(groups, 'c', 'a')).toBe('before');
    expect(groupDropSide(groups, 'a', 'missing')).toBeNull();
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
    // 手动钉入与规则命中分开列：「命中 N 个」只数规则
    const withPin = previewGroupHits(groups, { ...groups[1], pinnedBranchIds: ['3'] }, list);
    expect(withPin.hits.map((item) => item.id)).toEqual(['1']);
    expect(withPin.pinned.map((item) => item.id)).toEqual(['3']);
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

  it('钉入到上限的组不再收新分支，已钉在里面的不受影响；pinBranch 目标满了原样返回', () => {
    const full = group('g-full', [], Array.from({ length: BRANCH_GROUP_LIMITS.pinsPerGroup }, (_, i) => `b-${i}`));
    expect(groupAcceptsPin(full, 'b-new')).toBe(false);
    expect(groupAcceptsPin(full, 'b-3')).toBe(true);
    const groups = [full, group('g-other', [], ['b-new'])];
    expect(pinBranch(groups, 'b-new', 'g-full')).toBe(groups);
    expect(pinBranch(groups, 'b-new', null)[1].pinnedBranchIds).toEqual([]);
  });

  it('移组菜单标出钉入已满的组、拖放与菜单都先查满没满；新建分组到 30 个上限置灰并兜底', () => {
    const page = read('pages/BranchListPage.tsx');
    expect(page).toContain('disabled={(pinned && option.id === currentGroupId) || (option.pinnedFull && !option.pinnedIds?.includes(branch.id))}');
    expect(page).toContain("pinIntoGroup(branchId, targetId === '__ungrouped__' ? null : targetId);");
    expect(page).toContain('if (target && !groupAcceptsPin(target, branchId)) {');
    expect(page).toContain('disabled={groupList.length >= BRANCH_GROUP_LIMITS.groups}');
    expect(page).toContain('if ((branchGroupsRef.current?.groups.length ?? 0) >= BRANCH_GROUP_LIMITS.groups) {');
  });

  it('上限两边一致，界面不给出后端必然拒绝的操作（Codex P2）', () => {
    expect({ ...BRANCH_GROUP_LIMITS }).toEqual({ ...SERVER_LIMITS });
  });

  it('编辑器：保存中整张表单只读、规则到上限不能再加；建组建议勾选数超过上限不能创建', () => {
    const editor = read('components/branch-groups/BranchGroupEditorDialog.tsx');
    expect(editor).toContain('<fieldset disabled={saving}');
    expect(editor).toContain('const atRuleLimit = draft.rules.length >= BRANCH_GROUP_LIMITS.rulesPerGroup;');
    expect(editor).toContain('disabled={atRuleLimit}');
    const suggestions = read('components/branch-groups/BranchGroupSuggestions.tsx');
    expect(suggestions).toContain('item.defaultChecked && index < BRANCH_GROUP_LIMITS.groups');
    expect(suggestions).toContain('disabled={picked.length === 0 || overLimit > 0 || saving}');
    // 建议的勾选与组名草稿由页面持有（建组乐观更新会卸载面板，失败回来时草稿要在）
    expect(read('pages/BranchListPage.tsx')).toContain('draft={suggestionDraft}');
    expect(suggestions).not.toContain('useState<Record<string, boolean>>');
    // 建议重算时保留用户已改的勾选与组名
    expect(suggestions).toContain('item.prefix in current ? current[item.prefix] : item.defaultChecked');
    expect(suggestions).toContain('item.prefix in current ? current[item.prefix] : item.name');
    // 保存完成只关当时那个编辑器
    const page = read('pages/BranchListPage.tsx');
    expect(page).toContain('setGroupEditor((current) => (current?.group.id === group.id ? null : current))');
    expect(page).toContain('setGroupEditor((current) => (current?.group.id === groupId ? null : current))');
    // 在别的保存还没回来时打开的编辑器，非冲突失败后也换回已确认版本（否则再保存会写回被撤回的改动）
    // 标记绑到打开时在途的那几步：只有其中某步被撤回才换草稿，它们成功了就与草稿无关
    expect(page).toContain('basedOn: [...pendingGroupUpdatesRef.current]');
    expect(page).toContain('!editor.basedOn?.some((dep) => withdrawn.has(dep))');
    expect(page).not.toContain('basedOnPending');
    // 只读（镜像）时不给出拖了也不会生效的把手：把手的渲染条件看回调，不只看是不是真分组
    const header = read('components/branch-groups/BranchGroupHeader.tsx');
    expect(header).toContain('{group && onGripDragStart ? (');
    // 不会改变任何东西的钉入 / 移出不发请求；按规则归组的分支拖到「未归组」时说清该改哪组的规则
    expect(page).toContain('if (!groupId && !pinnedIn) {');
    expect(page).toContain("if (groupId && pinnedIn?.id === groupId) return { ok: false, reason: '已经钉在这一组', silent: true };");
    // 拖动悬停的提示与松手后的处理共用 pinVerdict：放下去不会生效时悬停就说清原因、不接受放下
    expect(page).toContain('pinVerdict(draggingBranchIdRef.current, targetId === \'__ungrouped__\' ? null : targetId)');
    expect(page).toContain('const verdict = pinVerdict(branchId, groupId);');
    // 只读项目的空分组不提示「拖到这里 / 编辑规则」
    expect(page).toContain("'这一组现在没有分支（分组只读，要在父实例上调整）'");
    // 下拉菜单限高只取实际剩余空间，不垫最小高度（矮视口里会伸出视口）
    const dropdown = read('components/ui/dropdown-menu.tsx');
    expect(dropdown).toContain('maxHeight = Math.max(spaceBelow, 0);');
    expect(dropdown).not.toContain('Math.max(spaceBelow, 120)');
    // 「归了别组」的分行按组 id 作 key（组名可重复）
    expect(editor).toContain('<div key={entry.groupId}');
    expect(editor).not.toContain('key={entry.groupName}');
    // 列表已满时，还没存进列表的新分组不能保存（冲突后保留的新草稿也走这条）
    expect(editor).toContain('const atGroupLimit = draftIndex < 0 && groups.length >= BRANCH_GROUP_LIMITS.groups;');
    expect(editor).toContain('&& !atGroupLimit && !saving');
    // 拖组头的提示从同一个判断取落点，不写死「前面」
    expect(page).toContain('groupDropHintText(groupList, draggingGroupIdRef.current, group)');
    expect(page).not.toContain('松手把分组挪到「${group?.name || \'\'}」前面');
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
    expect(source).toContain('const { parts, queued, slot } = summarizeBranchStates(branches, actions, projectProfileIds);');
    expect(source).toContain('const summary = summarizeBranchStates(list, actions, projectProfileIds);');
  };

  it('页头汇总与组头汇总走同一个统计函数', () => {
    summaryShared(page);
  });

  it('红用例：组头另写一份汇总，守卫变红', () => {
    expectGuardRedOnMutation(
      summaryShared,
      page,
      mutate(page, 'const summary = summarizeBranchStates(list, actions, projectProfileIds);', 'const summary = { parts: [] as BranchGroupSummaryPart[] };'),
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
    // 每个请求都在服务端上一次确认的版本上重套自己的改动、带那个版本号；请求串行发（Codex P2）
    expect(source).toContain("{ method: 'PUT', body: { groups: update(base?.groups ?? []), baseUpdatedAt: base?.updatedAt ?? null } }");
    expect(source).toContain('const result = groupSaveChainRef.current.then(run, run);');
    expect(source).toContain('error.status === 409 && body?.latest');
  };

  it('保存带版本号，冲突时载入最新并提示', () => {
    saveWithConcurrency(page);
  });

  it('红用例：保存不带版本号，守卫变红', () => {
    expectGuardRedOnMutation(
      saveWithConcurrency,
      page,
      mutate(page, 'body: { groups: update(base?.groups ?? []), baseUpdatedAt: base?.updatedAt ?? null }', 'body: { groups: update(base?.groups ?? []) }'),
    );
  });

  // 切项目时：上一个项目的编辑器与保存状态清掉；还在路上的保存响应丢弃，不许写进新项目（Codex P2）。
  const projectSwitchSafe = (source: string) => {
    expect(source).toContain('    setGroupEditor(null);\n    setGroupsSaving(false);\n    setGroupsSaveError(\'\');\n    setGroupDropTarget(null);');
    // 按「第几次进入」判，不按项目 id：A → B → A 回来后，第一次进 A 的响应同样丢弃
    expect(source).toContain('const switchedAway = () => groupsEpochRef.current !== requestEpoch;');
    expect(source).toContain('    groupsEpochRef.current += 1;\n');
    // 保存队列按项目分开，上一个项目卡住的请求不堵新项目
    expect(source).toContain('    groupSaveChainRef.current = Promise.resolve();\n');
    expect(source.match(/if \(switchedAway\(\)\) return false;/g)).toHaveLength(3);
    expect(source).toContain('`/api/projects/${encodeURIComponent(requestProject)}/branch-groups`');
  };

  it('切项目时清掉编辑器、丢弃上一个项目的保存响应', () => {
    projectSwitchSafe(page);
  });

  it('红用例：切项目不关编辑器，守卫变红', () => {
    expectGuardRedOnMutation(projectSwitchSafe, page, mutate(page, '    setGroupEditor(null);\n    setGroupsSaving(false);', '    setGroupsSaving(false);'));
  });

  it('红用例：保存响应不看项目是否已切换，守卫变红', () => {
    expectGuardRedOnMutation(projectSwitchSafe, page, mutate(page, '        if (switchedAway()) return false;\n        confirmedGroupsRef.current = { groups: res.groups', '        confirmedGroupsRef.current = { groups: res.groups'));
  });

  it('编辑器预览按项目全部分支算，冲突时草稿换成最新版本', () => {
    expect(page).toMatch(/groups=\{groupList\}\n\s+\/\*[^*]*\*\/\n\s+branches=\{branches\}/);
    expect(page).toContain('const fresh = latest.groups.find((group) => group.id === editor.group.id);');
  });

  // 一步保存失败，排在它后面、建立在它之上的改动一并撤回，不在最新版本上悄悄空转成功。
  const dependentsDropped = (source: string) => {
    expect(source).toContain('if (batch !== groupSaveBatchRef.current) return false;');
    expect(source).toContain('        groupSaveBatchRef.current += 1;\n        pendingGroupUpdatesRef.current = [];');
  };

  it('一步保存失败时撤回排在后面的依赖改动', () => {
    dependentsDropped(page);
  });

  it('红用例：失败后排队的改动照发，守卫变红', () => {
    expectGuardRedOnMutation(dependentsDropped, page, mutate(page, '      if (batch !== groupSaveBatchRef.current) return false;\n', ''));
  });

  // 串行保存：连续两次改动不许拿同一个旧版本号撞出假冲突。
  it('红用例：保存不串行（直接并发发请求），守卫变红', () => {
    expectGuardRedOnMutation(
      saveWithConcurrency,
      page,
      mutate(page, 'const result = groupSaveChainRef.current.then(run, run);', 'const result = run();'),
    );
  });

  // 父实例镜像来的项目只读：移组菜单、拖拽、编辑、组头把手都不给，保存直接拒绝（Codex P2）。
  const readOnlyWired = (source: string) => {
    expect(source).toContain('const groupsEditable = groupedView && !groupsReadOnly;');
    expect(source).toContain('    groupsEditable\n      ? { options');
    expect(source).toContain('onEdit={group && !groupsReadOnly ? () =>');
    expect(source).toContain('onGripDragStart={group && !groupsReadOnly ? (event) =>');
    expect(source).toContain('if (confirmedGroupsRef.current?.readOnly) {');
  };

  it('镜像项目的分组只读，所有改动入口关闭', () => {
    readOnlyWired(page);
  });

  it('红用例：镜像项目仍给移组菜单，守卫变红', () => {
    expectGuardRedOnMutation(readOnlyWired, page, mutate(page, '    groupsEditable\n      ? { options', '    groupedView\n      ? { options'));
  });

  it('首次建组建议按项目全部分支数', () => {
    expect(page).toMatch(/<BranchGroupSuggestions\n\s+\/\*[^*]*\*\/\n\s+branches=\{branches\}/);
  });

  it('卡片拿到分组菜单、当前组、钉入组名与可拖动开关', () => {
    expect(page).toContain('groupMenu={groupMenu}');
    expect(page).toContain('draggableToGroup={groupsEditable}');
    expect(page).toContain('draggable={draggableToGroup || undefined}');
    expect(page).toContain('revealInGroupsRef.current(branchId);');
  });
});
