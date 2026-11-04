// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebHostingCardsDemo from './WebHostingCardsDemo';

afterEach(() => vi.unstubAllGlobals());
describe('网页卡片交互设计演示', () => {
  it('打开新网页仅移除它的新标记，分享状态独立，重置后可以再次演示', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(<WebHostingCardsDemo />));
      expect(container.querySelectorAll('[aria-label="新创建，尚未打开"]')).toHaveLength(2);
      expect(container.querySelectorAll('[data-site-shared-badge]')).toHaveLength(2);
      expect(container.textContent).not.toContain('未分享');
      const card = container.querySelector<HTMLElement>('[data-hosted-site-id="demo-1"]')!;
      expect(card.querySelector('[data-site-edit-badge]')?.getAttribute('aria-label')).toBe('已编辑 0 次');
      act(() => card.querySelector<HTMLElement>('h3')!.click());
      expect(container.querySelectorAll('[aria-label="新创建，尚未打开"]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-site-shared-badge]')).toHaveLength(2);
      expect(container.querySelector('[aria-label="模拟打开网页"]')?.textContent).toContain('#1679');
      act(() => card.querySelector<HTMLButtonElement>('[aria-label="分享"]')!.click());
      expect(card.querySelector('[data-site-shared-badge]')).not.toBeNull();
      expect(card.querySelector('[aria-label="新创建，尚未打开"]')).toBeNull();
      act(() => [...container.querySelectorAll('button')].find(button => button.textContent === '重置演示')!.click());
      expect(container.querySelectorAll('[aria-label="新创建，尚未打开"]')).toHaveLength(2);
      expect(container.querySelectorAll('[data-site-shared-badge]')).toHaveLength(2);
      act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'Markdown 修复示例')!.click());
      expect(container.querySelectorAll('li strong')).toHaveLength(4);
      expect(container.querySelectorAll('[data-citation-badge]')).toHaveLength(4);
      expect(container.textContent).not.toContain('**');
    } finally { act(() => root.unmount()); container.remove(); }
  });
});
