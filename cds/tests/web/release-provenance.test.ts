import {describe,it,expect} from 'vitest';
import {releaseActorLabel,releaseMergeState} from '../../web/src/lib/releaseProvenance';
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
});
