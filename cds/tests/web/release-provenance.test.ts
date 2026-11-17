import {describe,it,expect} from 'vitest';
import {releaseActorLabel,releaseMergeState} from '../../web/src/lib/releaseProvenance';
import { toFleetEnv } from '../../web/src/lib/releaseFleet';
describe('发布责任与回并展示',()=>{
 it('通用操作人不升级为具体身份',()=>{
  for (const actor of [undefined,'user','ai','unknown']) expect(releaseActorLabel(actor)).toBe('发布人待核实');
 });
 it('只解码服务端认证身份格式，不损坏含冒号的ID和显示名',()=>{
  expect(releaseActorLabel(`user:${encodeURIComponent('sso:1')}:${encodeURIComponent('值班:甲')}`)).toBe('值班:甲');
  expect(releaseActorLabel('user:bad:%broken')).toBe('发布人待核实');
 });
 it('声明身份保留为历史记录，不伪造密钥持有人',()=>{
  expect(releaseActorLabel('ai:alice')).toBe('历史记录：ai:alice');
  expect(releaseActorLabel('ai:key:abc')).toBe('项目 Agent · abc');
 });
 it('任一方向未知时不推断为已回并',()=>{
  expect(releaseMergeState({aheadCount:0,behindCount:null})).toBe('回并待核实');
  expect(releaseMergeState({aheadCount:null,behindCount:0})).toBe('回并待核实');
  expect(releaseMergeState({aheadCount:0,behindCount:5})).toBe('主干已包含该版本历史');
  expect(releaseMergeState({aheadCount:2,behindCount:5})).toBe('存在尚未回并的提交');
 });
 it('矩阵显示认证姓名，失败记录缺身份时不能借用成功版本的操作人', () => {
  const row = { target: { id: 't', name: 'target', type: 'ssh', isEnabled: true },
   lastOperator: 'user:owner:Alice', latestRun: { startedAt: '2026-11-16T00:00:00Z', status: 'failed', operator: undefined } };
  expect(toFleetEnv(row as never).lastRelease?.by).toBe('发布人待核实');
  expect(toFleetEnv({ ...row, latestRun: { ...row.latestRun, operator: 'user:other:Bob' } } as never).lastRelease?.by).toBe('Bob');
 });
});
