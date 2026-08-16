import { describe, expect, it } from 'vitest';
import { INITIAL_CHAT_LAYERS, reduceChatLayers, type ChatLayerEvent, type ChatLayerState } from '../ReprocessChatDrawer';

/**
 * 抽屉的 z-[1200] 蒙版盖满全屏。Esc 没接上时它关不掉，
 * 侧栏、主题切换、导航全被这层蒙版吃掉点击——真人只剩「找那个 X」一条路。
 *
 * 上一版这里测的是 `resolveEscapeAction({createAgentOpen, pickerOpen})`，
 * 其中一条传了 `{true, true}`——**组件里根本产生不了这个状态**，因为
 * 「打开新建面板」那一下会把 pickerOpen 置 false。于是单测四条全绿，
 * 真人按 Esc 却从新建面板直接掉回抽屉，再也回不到选择器
 * （2026-08-11 验收实测 C4）。
 *
 * 所以现在**只驱动真实转移序列**：每条用例都从初始态出发，按用户实际点的顺序
 * 派事件，不再手工拼一个中间状态。手工拼状态正是上一版失效的原因。
 */
const run = (...events: ChatLayerEvent[]): { state: ChatLayerState; closedDrawer: boolean } => {
  let state = INITIAL_CHAT_LAYERS;
  let closedDrawer = false;
  for (const event of events) {
    const result = reduceChatLayers(state, event);
    state = result.next;
    closedDrawer = closedDrawer || result.closeDrawer;
  }
  return { state, closedDrawer };
};

describe('抽屉浮层栈', () => {
  it('什么都没开时，Esc 关整个抽屉', () => {
    expect(run('escape').closedDrawer).toBe(true);
  });

  it('选择器开着时，Esc 只收选择器，不连抽屉一起关', () => {
    const { state, closedDrawer } = run('toggle-picker', 'escape');
    expect(state.pickerOpen).toBe(false);
    expect(closedDrawer).toBe(false);
  });

  it('从选择器进新建面板：Esc 先退回选择器，再按一下才收选择器，第三下才关抽屉', () => {
    // 这正是验收里失败的那条路径，逐格钉死
    let state = INITIAL_CHAT_LAYERS;
    const step = (event: ChatLayerEvent) => {
      const result = reduceChatLayers(state, event);
      state = result.next;
      return result.closeDrawer;
    };

    step('toggle-picker');
    expect(state.pickerOpen).toBe(true);

    step('open-create-agent');
    expect(state.createAgentOpen).toBe(true);
    expect(state.pickerOpen).toBe(false);   // 新建面板压在上面，选择器让位

    expect(step('escape')).toBe(false);
    expect(state.createAgentOpen).toBe(false);
    expect(state.pickerOpen).toBe(true);    // 关键：退回选择器，而不是掉回抽屉

    expect(step('escape')).toBe(false);
    expect(state.pickerOpen).toBe(false);

    expect(step('escape')).toBe(true);      // 第三下才关抽屉
  });

  it('不是从选择器进的新建面板，退出时不会凭空弹出选择器', () => {
    const { state } = run('open-create-agent', 'escape');
    expect(state.createAgentOpen).toBe(false);
    expect(state.pickerOpen).toBe(false);
  });

  it('新建面板自己的关闭按钮与 Esc 走同一条路，行为一致', () => {
    const viaButton = run('toggle-picker', 'open-create-agent', 'close-create-agent').state;
    const viaEscape = run('toggle-picker', 'open-create-agent', 'escape').state;
    expect(viaButton).toEqual(viaEscape);
  });
});
