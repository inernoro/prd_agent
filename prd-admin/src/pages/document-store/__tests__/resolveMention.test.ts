import { describe, expect, it } from 'vitest';
import { resolveMention } from '../ReprocessChatDrawer';
import type { ToolboxItem } from '@/services/real/aiToolbox';

/**
 * 「@某某」显式指派的解析判据。
 *
 * 背景：抽屉默认收件人是通用智能体，用户不必挑；@ 是他想越过通用体自己指定时的口子。
 * 这里每一条都是「判据太窄/太宽」会静默出错的形状——
 * 认错人不会报错，只会把话发给另一个智能体。
 */
describe('resolveMention', () => {
  const items = [
    { id: '1', name: '视觉创作', agentKey: 'visual-agent' },
    { id: '2', name: '视觉创作智能体', agentKey: 'visual-agent-pro' },
    { id: '3', name: '缺陷管理智能体', agentKey: 'defect-agent' },
  ] as ToolboxItem[];

  it('开头 @ 命中时摘掉指派、只把剩下的话发出去', () => {
    const hit = resolveMention('@缺陷管理智能体 这个按钮点了没反应', items);
    expect(hit?.item.agentKey).toBe('defect-agent');
    expect(hit?.rest).toBe('这个按钮点了没反应');
  });

  it('同名前缀取最长匹配，不会被短名字抢走', () => {
    // 取第一个匹配（而非最长）会命中「视觉创作」，把「智能体」三个字留在正文里
    const hit = resolveMention('@视觉创作智能体 画一张海报', items);
    expect(hit?.item.name).toBe('视觉创作智能体');
    expect(hit?.rest).toBe('画一张海报');
  });

  it('只认开头的 @：正文中间提到 @ 不是指派', () => {
    expect(resolveMention('刚才 @缺陷管理智能体 说过了', items)).toBeNull();
  });

  it('前导空格不影响识别', () => {
    expect(resolveMention('   @视觉创作 夜景', items)?.item.name).toBe('视觉创作');
  });

  it('认不出名字就当普通文字，原样发给当前收件人——不静默吞掉输入', () => {
    expect(resolveMention('@不存在的智能体 帮我看看', items)).toBeNull();
    expect(resolveMention('@', items)).toBeNull();
    expect(resolveMention('普通的一句话', items)).toBeNull();
  });

  it('只 @ 没写指令时 rest 为空，交给调用方提示补一句', () => {
    expect(resolveMention('@视觉创作', items)?.rest).toBe('');
  });
});
