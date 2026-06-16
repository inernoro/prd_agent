/**
 * 「筛选设置」齿轮弹层守护测试。
 *
 * 三件事必须固化为源码级守护，否则历史 bug 会回归：
 *  1. 弹层用 createPortal 挂 body（避免被工具栏 overflow 裁剪 — 2026-06-16 fix）
 *  2. window scroll 监听必须放过弹层内部的滚动（max-h-72 列表），仅外层滚动才关闭
 *  3. ESC 键和窗口 resize 都应触发关闭（fixed 定位失锚后的可达性兜底）
 */
import { describe, expect, it } from 'vitest';
import source from './listFilter.tsx?raw';

describe('listFilter gear popover', () => {
  it('renders gear popover via createPortal to document.body', () => {
    expect(source).toContain("import { createPortal } from 'react-dom';");
    expect(source).toContain('createPortal(');
    expect(source).toContain('document.body,');
    expect(source).toContain('data-filter-gear-pop');
  });

  it('scroll listener ignores scrolls originating inside the popover', () => {
    // 必须读 e.target 并放过内部滚动；纯 () => setGearOpen(false) 会把弹层自己滚没
    expect(source).toMatch(/closest\?\.\(['"]\[data-filter-gear-pop\]['"]\)/);
    expect(source).toMatch(/onScroll\s*=\s*\(e:\s*Event\)/);
    // 守护：禁止退化回无参数的 onScroll
    expect(source).not.toMatch(/const\s+onScroll\s*=\s*\(\s*\)\s*=>\s*setGearOpen\(false\)/);
  });

  it('closes on ESC key and on window resize', () => {
    expect(source).toMatch(/e\.key\s*===\s*['"]Escape['"]/);
    expect(source).toContain("addEventListener('keydown'");
    expect(source).toContain("addEventListener('resize'");
    expect(source).toContain("removeEventListener('keydown'");
    expect(source).toContain("removeEventListener('resize'");
  });
});
