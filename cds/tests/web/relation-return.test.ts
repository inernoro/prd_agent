import { describe, expect, it } from 'vitest';
import { rememberRelationReturn, enterRelationReturn, relationReturnKind, relationRestoreForVisit, consumeRelationRestore, type RelationReturnTask } from '../../web/src/lib/relationReturn.js';
const task = (): RelationReturnTask => ({ kind: 'branches', branchId: 'branch-a', projectId: 'project-a', activeTagFilter: '业务', showArchived: true, selectedBranchIds: ['branch-a', 'branch-b'], relationExpanded: true });
const enter = (token: unknown, actor = 'actor-a', branch = 'branch-a', key = 'relation-visit', index = 5) => enterRelationReturn(token, actor, branch, key, index);
describe('关系返回的来源与任务边界', () => {
  it('来源未真正离开前不恢复；进入后恢复同访问的筛选/展开而非新的默认页', () => {
    const token = rememberRelationReturn(task(), 'actor-a', 'source-visit', 4)!;
    expect(relationRestoreForVisit('actor-a', 'source-visit', 4, 'project-a')).toBeNull();
    expect(enter(token)).toBe('branches');
    const restore = relationRestoreForVisit('actor-a', 'source-visit', 4, 'project-a');
    expect(restore?.task).toEqual(task());
    expect(relationReturnKind(token, 'actor-a', 'branch-a', 'relation-visit', 5)).toBe('branches');
  });
  it('未知token、身份、对象、history index/key不吻合均不能猜前一页', () => {
    const token = rememberRelationReturn(task(), 'actor-a', 'boundary-source', 4)!;
    expect(enter('unknown-token')).toBeNull();
    expect(enter(token, 'actor-b')).toBeNull();
    expect(enter(token, null as unknown as string)).toBeNull();
    expect(enter(token, 'actor-a', 'branch-b')).toBeNull();
    expect(enter(token, 'actor-a', 'branch-a', 'relation-visit', 6)).toBeNull();
    expect(enter(token)).toBe('branches');
    expect(enter(token, 'actor-a', 'branch-a', 'different-visit')).toBeNull();
  });
  it('来源记录按项目/访问key隔离，不恢复另一个当前任务', () => {
    const token = rememberRelationReturn(task(), 'actor-a', 'isolated-source', 4)!; enter(token);
    expect(relationRestoreForVisit('actor-b', 'isolated-source', 4, 'project-a')).toBeNull();
    expect(relationRestoreForVisit('actor-a', 'other-source', 4, 'project-a')).toBeNull();
    expect(relationRestoreForVisit('actor-a', 'isolated-source', 4, 'project-b')).toBeNull();
    expect(relationRestoreForVisit('actor-a', 'isolated-source', 3, 'project-a')).toBeNull();
  });
  it('恢复一次即消费，Forward再回关系页不能复活旧Drawer或旧筛选', () => {
    const token = rememberRelationReturn(task(), 'actor-a', 'once-source', 4)!; enter(token);
    const restore = relationRestoreForVisit('actor-a', 'once-source', 4, 'project-a')!;
    consumeRelationRestore(restore.token);
    expect(relationRestoreForVisit('actor-a', 'once-source', 4, 'project-a')).toBeNull();
    expect(enter(token)).toBeNull();
    expect(relationReturnKind(token, 'actor-a', 'branch-a', 'relation-visit', 5)).toBeNull();
  });
  it('同来源的新任务使旧token失效，不借旧对象返回', () => {
    const first = rememberRelationReturn(task(), 'actor-a', 'replace-source', 4)!; enter(first);
    const second = rememberRelationReturn({ ...task(), branchId: 'branch-b' }, 'actor-a', 'replace-source', 4)!;
    expect(enter(first)).toBeNull();
    expect(enter(second, 'actor-a', 'branch-b')).toBe('branches');
  });
  it('复制界面选择不会改变来源记录的选择数组', () => {
    const selected = task(); const token = rememberRelationReturn(selected, 'actor-a', 'clone-source', 4)!; enter(token);
    const restore = relationRestoreForVisit('actor-a', 'clone-source', 4, 'project-a')!;
    restore.task.selectedBranchIds.push('new-selection');
    expect(relationRestoreForVisit('actor-a', 'clone-source', 4, 'project-a')?.task).toEqual(selected);
  });
  it('不可确认的来源身份或index不注册回退承诺', () => {
    expect(rememberRelationReturn(task(), null, 'source', 4)).toBeUndefined();
    expect(rememberRelationReturn(task(), 'actor-a', 'source', undefined)).toBeUndefined();
    expect(rememberRelationReturn(task(), 'actor-a', 'source', -1)).toBeUndefined();
    expect(rememberRelationReturn(task(), 'actor-a', '', 4)).toBeUndefined();
  });
  it('有界内存淘汰旧访问后只允许明确的无来源fallback', () => {
    const oldest = rememberRelationReturn(task(), 'actor-a', 'oldest-source', 4)!; enter(oldest);
    for (let i = 0; i < 33; i++) rememberRelationReturn(task(), 'actor-a', 'new-source-' + i, 4);
    expect(enter(oldest)).toBeNull();
  });
});
