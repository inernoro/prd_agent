import { describe, expect, it } from 'vitest';
import { executiveWorkspaceModel, memberRecordState, workspaceSparkline } from '../executiveWorkspaceModel';
import { workspaceFixture } from './workspaceFixture';

describe('真实工作区数据适配', () => {
  it('按后端团队与完整名单展示，零记录成员与未知成员资料不同', () => {
    const data = workspaceFixture();
    const model = executiveWorkspaceModel(data);
    expect(model.groups[0].name).toBe('真实协作组');
    expect(model.members).toHaveLength(2);
    expect(memberRecordState(model.byId.get('u2')!)).toBe('none');
    delete data.workspace;
    const old = executiveWorkspaceModel(data);
    expect(old.members).toEqual([]);
    expect(old.groups[0].userIds).toEqual([]);
  });
  it('已有失败或积压事实不因没有调用而消失', () => {
    const member = workspaceFixture().workspace!.members[1];
    expect(memberRecordState({ ...member, imagesFailed: 1 })).toBe('failed');
    expect(memberRecordState({ ...member, defectsBacklog: 1 })).toBe('backlog');
    expect(memberRecordState({ ...member, hasActivity: true })).toBe('record');
  });
  it('空、全零和非法日序列不伪造曲线；数值从零基线显示', () => {
    expect(workspaceSparkline([])).toBe('');
    expect(workspaceSparkline([0, 0, 0])).toBe('');
    expect(workspaceSparkline([1, NaN])).toBe('');
    expect(workspaceSparkline([0, 2, 1], 100, 20)).toBe('M0.00,18.00 L50.00,2.00 L100.00,10.00');
  });
});
