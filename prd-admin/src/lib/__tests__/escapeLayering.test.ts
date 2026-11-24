import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shouldCloseOnEscape } from '../escapeLayering';

const dock = readFileSync(
  new URL('../../components/web-hosting/ShareSiteEditDock.tsx', import.meta.url), 'utf8');
const previewModal = readFileSync(
  new URL('../../components/web-hosting/SitePreviewModal.tsx', import.meta.url), 'utf8');

/**
 * 两个浮层都挂在 document / window 上听 Escape，而它们内部都会打开 Radix 弹窗
 * （知识选择、回滚确认、驳回原因）。Radix 在捕获阶段处理 Escape 并 preventDefault，
 * 事件照样冒泡上来——不看 defaultPrevented 的话，用户按一次 Escape 只想关掉里面那一层，
 * 外层连同还没保存的修改要求一起被关掉（Codex P2 x2，2026-09-15）。
 *
 * 判据只此一份：第一轮只修了分享页那个坞，预览浮层原样留着，下一轮立刻被报了第二次。
 */
describe('Escape 只关最上面那一层', () => {
  it('没人处理过的 Escape 关掉外层', () => {
    expect(shouldCloseOnEscape({ key: 'Escape', defaultPrevented: false })).toBe(true);
  });

  it('已被上层弹窗处理掉的 Escape 不关外层', () => {
    expect(
      shouldCloseOnEscape({ key: 'Escape', defaultPrevented: true }),
      '嵌套弹窗按 Escape 会连外层一起关掉，用户丢掉还没保存的输入',
    ).toBe(false);
  });

  it('别的按键一概不关', () => {
    expect(shouldCloseOnEscape({ key: 'Enter', defaultPrevented: false })).toBe(false);
    expect(shouldCloseOnEscape({ key: 'Esc', defaultPrevented: false })).toBe(false);
  });

  it('两个浮层都走这一份判据，没有人再手写一遍', () => {
    for (const [name, source] of [['ShareSiteEditDock', dock], ['SitePreviewModal', previewModal]] as const) {
      // companion：确实还在听 Escape（否则下面的断言没有意义）。
      expect(source, `${name} 不再监听键盘了？`).toContain('keydown');
      expect(source, `${name} 没有引用共享判据`).toContain("from '@/lib/escapeLayering'");
      expect(source, `${name} 又手写了一遍 Escape 判据`).not.toMatch(/key === 'Escape'/);
    }
  });
});
