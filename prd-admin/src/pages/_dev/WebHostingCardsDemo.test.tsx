// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebHostingCardsDemo from './WebHostingCardsDemo';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.unstubAllGlobals());
describe('网页卡片三档交互演示', () => {
  it('同一场景三档同步选择，示例不读写业务接口，详情保留上传来源', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const container = document.createElement('div'); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<WebHostingCardsDemo />));
      expect(container.querySelectorAll('[data-demo-scenario]')).toHaveLength(10);
      expect(container.querySelectorAll('[data-hosted-site-id]')).toHaveLength(30);
      const row = container.querySelector('[data-demo-scenario="related"]')!;
      expect(row.querySelectorAll('[aria-label="新创建，尚未打开"]')).toHaveLength(3);
      await act(async () => row.querySelector<HTMLButtonElement>('[data-site-select]')!.click());
      expect(row.querySelectorAll('[data-selected="true"]')).toHaveLength(3);
      await act(async () => row.querySelector<HTMLElement>('h3')!.click());
      expect(row.querySelectorAll('[aria-label="新创建，尚未打开"]')).toHaveLength(0);
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('预览 · 示例');
      await act(async () => [...document.querySelectorAll('button')].find(item => item.textContent === '关闭演示')!.click());
      await act(async () => row.querySelector<HTMLButtonElement>('[data-site-details-button]')!.click());
      expect(document.querySelector('[data-site-details]')?.textContent).toContain('手动上传');
      expect(fetch).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
