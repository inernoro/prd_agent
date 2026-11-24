import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BranchSubmitterHeader } from '../../web/src/components/branch-groups/BranchSubmitterHeader';
import { branchSubmitter, groupBranchesBySubmitter, parseBranchViewMode } from '../../web/src/lib/branchSubmitters';
import { reduceBranchListState } from '../../web/src/lib/branch-list-state';

describe('按提交者归类', () => {
  it('GitHub 用户优先，同一账号大小写与空白变化不会拆组', () => {
    const branches = [
      { id: 'a', githubSenderLogin: ' Alice ', builder: { name: '机器人', email: 'bot@example.com' } },
      { id: 'b', githubSenderLogin: 'alice', builder: { name: '另一个作者' } },
      { id: 'c', githubSenderLogin: 'bob' },
    ];
    const sections = groupBranchesBySubmitter(branches);
    expect(sections.map((s) => s.branches.map((b) => b.id))).toEqual([['a', 'b'], ['c']]);
    expect(sections[0].submitter.name).toBe('@Alice');
  });

  it('作者账号兜底与同账号推送者合并，作者邮箱区分同名用户', () => {
    const sections = groupBranchesBySubmitter([
      { id: 'a', builder: { name: '甲', login: 'alice' } },
      { id: 'b', githubSenderLogin: 'ALICE' },
      { id: 'c', builder: { name: '同名', email: 'first@example.com' } },
      { id: 'd', builder: { name: '同名', email: 'second@example.com' } },
      { id: 'e', builder: { name: '改过名字', email: ' FIRST@EXAMPLE.COM ' } },
    ]);
    expect(sections.map((s) => s.branches.map((b) => b.id))).toEqual([['a', 'b'], ['c', 'e'], ['d']]);
  });

  it('名字、邮箱和账号属于独立身份；未知信息统一放在最后，所有分支恰好出现一次', () => {
    const branches = [
      { id: 'unknown' },
      { id: 'name', builder: { name: 'alice' } },
      { id: 'login', githubSenderLogin: 'alice' },
      { id: 'email', builder: { email: 'alice' } },
      { id: 'blank', githubSenderLogin: '  ', builder: { name: ' ', login: ' ', email: ' ' } },
    ];
    const sections = groupBranchesBySubmitter(branches);
    expect(sections.map((s) => s.branches.map((b) => b.id))).toEqual([['name'], ['login'], ['email'], ['unknown', 'blank']]);
    expect(sections.at(-1)?.submitter).toMatchObject({ name: '未知提交者', unknown: true });
    expect(sections.flatMap((s) => s.branches)).toHaveLength(branches.length);
    expect(groupBranchesBySubmitter([])).toEqual([]);
  });

  it('SSE 更新提交者后移动到新用户组，不复制或丢失分支', () => {
    const branches = [
      { id: 'a', projectId: 'p', githubSenderLogin: 'alice' },
      { id: 'b', projectId: 'p', githubSenderLogin: 'bob' },
    ];
    const result = reduceBranchListState({ branches, lastKnownGoodBranches: branches }, {
      type: 'sseBranchPatch', branchId: 'a', projectId: 'p', patch: { githubSenderLogin: 'bob' },
    });
    expect(groupBranchesBySubmitter(result.state.branches).map((s) => s.branches.map((b) => b.id))).toEqual([['a', 'b']]);
  });

  it('三种视图均可恢复，旧值与损坏的记忆回到状态视图', () => {
    expect(['status', 'groups', 'submitters'].map(parseBranchViewMode)).toEqual(['status', 'groups', 'submitters']);
    expect(parseBranchViewMode(null)).toBe('status');
    expect(parseBranchViewMode('invalid')).toBe('status');
  });

  it('用户组头渲染身份、数量、异常汇总与可访问的收起按钮', () => {
    const html = renderToStaticMarkup(createElement(BranchSubmitterHeader, {
      submitter: branchSubmitter({ githubSenderLogin: 'alice' }),
      count: 3, parts: [{ text: '1 个出错需要处理', tone: 'warn' }], collapsed: true, onToggle: () => undefined,
    }));
    expect(html).toContain('@alice');
    expect(html).toContain('3');
    expect(html).toContain('个分支');
    expect(html).toContain('1 个出错需要处理');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('展开提交者 @alice');
    expect(html).not.toContain('编辑');
    expect(html).not.toContain('draggable');
  });
});
