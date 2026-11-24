import { describe, expect, it } from 'vitest';
import { resolveOutgoingTarget } from '../ReprocessChatDrawer';
import type { ToolboxItem } from '@/services/real/aiToolbox';

/**
 * 「不必先挑智能体」这件事本身的判据。
 *
 * 它决定这句话发给谁——发错人不会报错、不会红，只会安静地交给另一个智能体，
 * 或者把用户拦在一句「请先选择智能体」后面。所以必须逐格断言，不能靠点一遍。
 *
 * 优先级契约：开头的 @ 指派 > 当前收件人 > 通用体（可用时）> 拦下并说清为什么。
 */
describe('resolveOutgoingTarget', () => {
  const items = [
    { id: 'v', name: '视觉创作', agentKey: 'visual-agent' },
    { id: 'd', name: '缺陷管理智能体', agentKey: 'defect-agent' },
  ] as ToolboxItem[];

  const base = { active: null as never, generalAvailable: true, toolboxItems: items };

  it('已选中通用体：原话原样发给它，不需要任何指派', () => {
    const r = resolveOutgoingTarget({
      ...base,
      input: '这段录音的结论是什么',
      active: { kind: 'general' },
    });
    expect(r.target).toEqual({ kind: 'general' });
    expect(r.text).toBe('这段录音的结论是什么');
    expect(r.mentioned).toBe(false);
    expect(r.blocked).toBeNull();
  });

  it('@ 指派优先于当前收件人，并把 @ 从正文里摘掉', () => {
    const r = resolveOutgoingTarget({
      ...base,
      input: '@缺陷管理智能体 这个按钮点了没反应',
      active: { kind: 'general' },
    });
    expect(r.target).toMatchObject({ kind: 'toolbox' });
    expect((r.target as { item: ToolboxItem }).item.agentKey).toBe('defect-agent');
    expect(r.text).toBe('这个按钮点了没反应');
    expect(r.mentioned).toBe(true);
    expect(r.blocked).toBeNull();
  });

  it('只 @ 没写指令：拦下并说清缺什么，而不是发一句空话出去', () => {
    const r = resolveOutgoingTarget({ ...base, input: '@视觉创作', active: { kind: 'general' } });
    expect(r.blocked).toBe('mention-without-instruction');
  });

  it('通用体可用但用户没选：直接发给通用体——这正是「不必先挑」的兑现', () => {
    // 只断言 blocked 为空是不够的：调用方是按 `!decision.target` 判失败的，
    // 所以 target 必须真的是通用体。这条用例原先只测了一半，
    // 于是「target 仍是 null」这个洞在决策层测试全绿的情况下活了下来：
    // 默认收件人 effect 还没跑完、或刚移除当前收件人的那个窗口里，
    // 「可选」会退化回「必选」，还会弹一句「通用智能体暂时不可用」——它明明可用。
    const r = resolveOutgoingTarget({ ...base, input: '帮我理一下', active: null });
    expect(r.blocked).toBeNull();
    expect(r.target).toEqual({ kind: 'general' });
    expect(r.text).toBe('帮我理一下');
    expect(r.mentioned).toBe(false);
  });

  it('通用体不可用且没选：这时才要求手动挑，且理由是运行时不可用', () => {
    const r = resolveOutgoingTarget({
      ...base,
      input: '帮我理一下',
      active: null,
      generalAvailable: false,
    });
    expect(r.blocked).toBe('no-recipient');
    expect(r.target).toBeNull();
  });

  it('通用体不可用但用户已手动挑了：照发，不许因为运行时状态误伤既有路径', () => {
    const r = resolveOutgoingTarget({
      ...base,
      input: '润色一下',
      active: { kind: 'toolbox', item: items[0] },
      generalAvailable: false,
    });
    expect(r.blocked).toBeNull();
    expect(r.target).toMatchObject({ kind: 'toolbox' });
  });

  it('认不出的 @ 当普通文字：原样发出，不静默吞掉用户输入', () => {
    const r = resolveOutgoingTarget({
      ...base,
      input: '@不存在的体 帮我看看',
      active: { kind: 'general' },
    });
    expect(r.mentioned).toBe(false);
    expect(r.text).toBe('@不存在的体 帮我看看');
    expect(r.target).toEqual({ kind: 'general' });
  });
});
