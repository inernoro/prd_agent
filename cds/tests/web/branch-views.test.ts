import { describe, expect, it } from 'vitest';
import { BRANCH_VIEW_LIMIT, branchViewGroups, branchViewsStorageKey, defaultBranchViews, groupBranchesByView, normalizeBranchViews, readBranchViews, removeBranchView, type BranchView } from '../../web/src/lib/branchViews';
import { branchSubmitter } from '../../web/src/lib/branchSubmitters';

const view = (source: BranchView['source'], extra: Partial<BranchView> = {}): BranchView => ({ id: source, name: source, source, ...extra });
const branch = (id: string, name: string, tags: string[] = []) => ({ id, branch: name, tags });

describe('个人分类视图偏好', () => {
  it('默认保留现有三种分类，迁移旧视图选择，不自动重新添加删除的分类', () => {
    const old = new Map([['cds_branch_view_mode:p', 'submitters']]);
    const storage = { getItem: (key: string) => old.get(key) ?? null };
    const key = branchViewsStorageKey('alice', 'p');
    expect(readBranchViews(storage, key, 'p').selectedId).toBe('submitters');
    const removed = removeBranchView(defaultBranchViews('groups'), 'groups');
    old.set(key, JSON.stringify(removed));
    expect(readBranchViews(storage, key, 'p')).toEqual(removed);
    expect(removed.views.map((v) => v.id)).toEqual(['status', 'submitters']);
    expect(removed.selectedId).toBe('status');
  });

  it('删除当前分类回到剩余分类，最后一个分类不能删除；不影响正在编辑的名字', () => {
    const settings = { views: [view('tags', { name: '' }), view('roles')], selectedId: 'roles' };
    const result = removeBranchView(settings, 'roles');
    expect(result).toEqual({ views: [view('tags', { name: '' })], selectedId: 'tags' });
    expect(removeBranchView(result, 'tags')).toBe(result);
  });

  it('账号和项目分别隔离，同一分隔符不会造成键碰撞', () => {
    const aliceP = branchViewsStorageKey('alice', 'p');
    expect(aliceP).not.toBe(branchViewsStorageKey('bob', 'p'));
    expect(aliceP).not.toBe(branchViewsStorageKey('alice', 'q'));
    expect(branchViewsStorageKey('a:b', 'c')).not.toBe(branchViewsStorageKey('a', 'b:c'));
    const store = new Map([[aliceP, JSON.stringify({ views: [view('roles')], selectedId: 'roles' })]]);
    const storage = { getItem: (key: string) => store.get(key) ?? null };
    expect(readBranchViews(storage, aliceP, 'p').views).toEqual([view('roles')]);
    expect(readBranchViews(storage, branchViewsStorageKey('bob', 'p'), 'p')).toEqual(defaultBranchViews());
  });

  it('偏好损坏或存储被禁用时仍能显示默认分类；未知分类不执行，数量受限', () => {
    expect(readBranchViews({ getItem: () => '{bad' }, 'key', 'p')).toEqual(defaultBranchViews());
    expect(readBranchViews({ getItem: () => { throw new Error('disabled'); } }, 'key', 'p')).toEqual(defaultBranchViews());
    expect(normalizeBranchViews({ views: [{ id: 'bad', source: 'constructor', name: '坏分类' }], selectedId: 'bad' })).toEqual(defaultBranchViews());
    const views = Array.from({ length: 20 }, (_, i) => view('tags', { id: `v${i}` }));
    expect(normalizeBranchViews({ views, selectedId: 'v19' }).views).toHaveLength(BRANCH_VIEW_LIMIT);
    expect(normalizeBranchViews({ views, selectedId: 'v19' }).selectedId).toBe('v0');
    expect(normalizeBranchViews({ views: [view('tag-prefix', { tagPrefix: '' })] })).toEqual(defaultBranchViews());
  });
});

describe('分类与搜索定位的共同归类判定', () => {
  it('提交者视图保留账号优先与未知用户行为，分类 ID 隔离同依据的两个视图', () => {
    const b = { ...branch('a', 'main'), githubSenderLogin: 'alice' };
    expect(branchViewGroups(view('submitters'), b)[0].name).toBe(branchSubmitter(b).name);
    expect(branchViewGroups(view('submitters'), b)[0].id).not.toBe(branchViewGroups(view('submitters', { id: 'another' }), b)[0].id);
    expect(branchViewGroups(view('submitters'), branch('unknown', 'main'))[0].unknown).toBe(true);
  });

  it('多标签分支在各标签组出现一次，无标签在最后；输入分支顺序保留', () => {
    const list = [branch('none', 'main'), branch('a', 'feat/a', ['登录', '支付', '登录']), branch('b', 'fix/b', ['登录'])];
    const sections = groupBranchesByView(view('tags'), list);
    expect(sections.map((s) => [s.group.name, s.branches.map((b) => b.id)])).toEqual([
      ['登录', ['a', 'b']], ['支付', ['a']], ['无标签', ['none']],
    ]);
    expect(branchViewGroups(view('tags'), list[1]).map((g) => g.id)).toEqual(sections.slice(0, 2).map((s) => s.group.id));
  });

  it('角色只使用明确的分支标签，不从 Agent 或任务猜测角色', () => {
    const sections = groupBranchesByView(view('roles'), [branch('a', 'codex/fix-login', ['角色:开发']), branch('b', 'fix/a', ['角色:测试']), branch('c', 'claude/qa')]);
    expect(sections.map((s) => s.group.name)).toEqual(['开发', '测试', '未指定角色']);
  });

  it('任务和 Agent 优先明确标签，再用有限分支前缀；不能推断的明确标注', () => {
    expect(branchViewGroups(view('tasks'), branch('a', 'fix/login'))[0].name).toBe('修复');
    expect(branchViewGroups(view('tasks'), branch('a', 'fix/login', ['任务:新功能']))[0].name).toBe('新功能');
    expect(branchViewGroups(view('agents'), branch('a', 'codex/login'))[0].name).toBe('Codex');
    expect(branchViewGroups(view('agents'), branch('a', 'codex/login', ['Agent:Claude']))[0].name).toBe('Claude');
    expect(branchViewGroups(view('agents'), branch('a', 'fix/login'))[0].name).toBe('未指定 Agent');
    expect(branchViewGroups(view('tasks'), branch('a', 'constructor/login'))[0].unknown).toBe(true);
  });

  it('自定义标签前缀支持业务分类，未命中的分支进入未分类，不改写标签', () => {
    const custom = view('tag-prefix', { id: 'modules', tagPrefix: '模块:' });
    const a = branch('a', 'codex/a', ['模块:登录', '模块:支付', '角色:开发']);
    expect(branchViewGroups(custom, a).map((g) => g.name)).toEqual(['登录', '支付']);
    expect(branchViewGroups(custom, branch('b', 'main', ['登录']))[0].name).toBe('未分类');
    expect(a.tags).toEqual(['模块:登录', '模块:支付', '角色:开发']);
    expect(groupBranchesByView(custom, [])).toEqual([]);
  });
});
