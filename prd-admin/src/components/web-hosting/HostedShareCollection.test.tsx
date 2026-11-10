// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HostedShareCollection from './HostedShareCollection';

vi.mock('@/components/reactbits/Threads', () => ({ default: () => <canvas /> }));
vi.mock('@/hooks/useDataTheme', () => ({ useDataTheme: () => 'dark' }));

afterEach(() => vi.unstubAllGlobals());

describe('合集成员沿用原分享的阅读骨架', () => {
  it('30 份资料分页、搜索和紧凑列表保留原排序与分享凭证', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    try {
      act(() => root.render(<HostedShareCollection collectionPath="/s/wp/snapshot" data={{ title: '30 份资料', mainSiteId: '1', sites: Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), title: `资料 ${i + 1}`, siteUrl: 'https://cos.example/index.html', entryFile: 'index.html', entrySize: 1, fileCount: 1, totalSize: 1 })) }} />));
      const links = () => [...element.querySelectorAll<HTMLAnchorElement>('.hosted-share-member')];
      expect(links()).toHaveLength(12);
      expect(element.querySelector('.is-main')?.textContent).toContain('主文档');
      act(() => [...element.querySelectorAll('button')].find(x => x.textContent === '下一页')!.click());
      expect(new URL(links()[0].href).searchParams.get('siteId')).toBe('13');
      act(() => [...element.querySelectorAll('button')].find(x => x.textContent === '下一页')!.click());
      expect(links()).toHaveLength(6);
      act(() => element.querySelector<HTMLButtonElement>('[aria-label="紧凑列表"]')!.click());
      expect(element.querySelector('.hosted-share-members.is-list')).not.toBeNull();
      const field = element.querySelector<HTMLInputElement>('[aria-label="查找合集文档"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '资料 30');
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(links()).toHaveLength(1);
      expect(links()[0].getAttribute('href')).toBe('/s/wp/snapshot?siteId=30');
      expect(element.textContent).toContain('第 1 / 1 页');
    } finally { act(() => root.unmount()); element.remove(); }
  });
  it('所有卡片保留合集凭证，只选择成员，不跳 COS 或创建新的分享凭证', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const element = document.createElement('div');
    const root = createRoot(element);
    const save = vi.fn();
    try {
      act(() => root.render(<HostedShareCollection collectionPath="/s/wp/existing-token" action={<button onClick={save}>登录并保存</button>}
        data={{ title: '历史合集', sites: ['first', 'second & extra'].map(id => ({
          id, title: id, siteUrl: `https://cos.example/${id}/index.html`, entryFile: 'index.html', entrySize: 1024, fileCount: 9, totalSize: 1024,
        })) }} />));
      const links = [...element.querySelectorAll<HTMLAnchorElement>('.hosted-share-member')];
      expect(links).toHaveLength(2);
      for (const [index, link] of links.entries()) {
        const url = new URL(link.href, 'https://map.example');
        expect(url.pathname).toBe('/s/wp/existing-token');
        expect(url.searchParams.get('siteId')).toBe(['first', 'second & extra'][index]);
        expect([...url.searchParams.keys()]).toEqual(['siteId']);
        expect(link.target).toBe('_blank');
        expect(link.rel).toContain('noopener');
      }
      expect(element.querySelector('a[href*="cos.example"]')).toBeNull();
      expect(element.querySelector('canvas')).toBeNull(); // reduced motion keeps readable content
      expect(element.textContent).toContain('9 个文件');
      act(() => element.querySelector('button')!.click());
      expect(save).toHaveBeenCalledOnce();
    } finally { act(() => root.unmount()); }
  });
});
