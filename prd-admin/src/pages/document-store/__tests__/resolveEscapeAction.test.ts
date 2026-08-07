import { describe, expect, it } from 'vitest';
import { resolveEscapeAction } from '../ReprocessChatDrawer';

/**
 * 抽屉的 z-[1200] 蒙版盖满全屏。Esc 没接上时它关不掉，
 * 侧栏、主题切换、导航全被这层蒙版吃掉点击——真人只剩「找那个 X」一条路。
 * 这条判据在浏览器里已复现过（Escape 后 elementFromPoint 仍是 surface-backdrop），
 * 所以按层级逐格钉死，避免以后加新浮层时又忘一支。
 */
describe('resolveEscapeAction', () => {
  it('什么都没开时，Esc 关整个抽屉', () => {
    expect(resolveEscapeAction({ createAgentOpen: false, pickerOpen: false })).toBe('close-drawer');
  });

  it('智能体下拉开着时，先收下拉，不连抽屉一起关', () => {
    expect(resolveEscapeAction({ createAgentOpen: false, pickerOpen: true })).toBe('close-picker');
  });

  it('新建面板开着时，先收新建面板', () => {
    expect(resolveEscapeAction({ createAgentOpen: true, pickerOpen: false })).toBe('close-create-agent');
  });

  it('两层都开着时，只收最上面那层（新建面板压过下拉）', () => {
    expect(resolveEscapeAction({ createAgentOpen: true, pickerOpen: true })).toBe('close-create-agent');
  });
});
