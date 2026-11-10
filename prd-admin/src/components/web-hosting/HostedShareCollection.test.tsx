// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HostedShareCollection from './HostedShareCollection';

vi.mock('@/components/reactbits/Threads', () => ({ default: () => <canvas /> }));
vi.mock('@/hooks/useDataTheme', () => ({ useDataTheme: () => 'dark' }));

afterEach(() => vi.unstubAllGlobals());

describe('合集成员沿用原分享的阅读骨架', () => {
  it('90 份目录分页、搜索和连续阅读保留原排序与分享凭证', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const element = document.createElement('div');
    document.body.append(element);
    const root = createRoot(element);
    try {
      act(() => root.render(<HostedShareCollection collectionPath="/s/wp/snapshot" data={{ title: '90 份资料', mainSiteId: '1', sites: Array.from({ length: 90 }, (_, i) => ({ id: String(i + 1), title: `资料 ${i + 1}`, siteUrl: 'https://cos.example/index.html', entryFile: 'index.html', entrySize: 1, fileCount: 1, totalSize: 1 })) }} />));
      const links = () => [...element.querySelectorAll<HTMLAnchorElement>('.hosted-share-member')];
      expect(links()).toHaveLength(30);
      expect(element.querySelector('.is-main')?.textContent).toContain('主文档');
      act(() => [...element.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '下一页目录')!.click());
      expect(new URL(links()[0].href).searchParams.get('siteId')).toBe('31');
      act(() => [...element.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '下一页目录')!.click());
      expect(links()).toHaveLength(30);
      const field = element.querySelector<HTMLInputElement>('[aria-label="查找合集文档"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '资料 90');
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(links()).toHaveLength(1);
      expect(links()[0].getAttribute('href')).toBe('/s/wp/snapshot?siteId=90');
      expect(element.textContent).toContain('第 1 / 1 页');
    } finally { act(() => root.unmount()); element.remove(); }
  });
  it('失效主文档不自动换成首项，不可用成员不挂载正文', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const element = document.createElement('div'); const root = createRoot(element);
    const data = { title: '历史合集', mainSiteId: 'deleted', sites: [{ id: 'a', title: '已失效成员', siteUrl: '', entryFile: 'index.html', entrySize: 1, fileCount: 1, totalSize: 1, unavailable: true }] };
    try {
      act(() => root.render(<HostedShareCollection data={data} collectionPath="/s/wp/original" />));
      expect(element.querySelector('.is-main')).toBeNull();
      expect(element.textContent).toContain('尚未指定可用的主文档');
      act(() => root.render(<HostedShareCollection data={data} collectionPath="/s/wp/original" selectedSiteId="a" reader={<p>不应暴露正文</p>} />));
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('文档暂不可用');
      expect(element.textContent).not.toContain('不应暴露正文');
    } finally { act(() => root.unmount()); }
  });
  it('同页切换正文保留目录筛选，普通链接仍保留原分享和成员凭证', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const element = document.createElement('div'); document.body.append(element);
    const root = createRoot(element); const select = vi.fn();
    const data = { title: '资料集', mainSiteId: '1', sites: Array.from({ length: 90 }, (_, index) => ({ id: String(index + 1), title: `资料 ${index + 1}`, siteUrl: 'https://cos.example/index.html', entryFile: 'index.html', entrySize: 1, fileCount: 1, totalSize: 1 })) };
    try {
      act(() => root.render(<HostedShareCollection data={data} collectionPath="/s/wp/original" onSelect={select} />));
      const field = element.querySelector<HTMLInputElement>('[aria-label="查找合集文档"]')!;
      act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '资料 90'); field.dispatchEvent(new Event('input', { bubbles: true })); });
      act(() => element.querySelector<HTMLAnchorElement>('.ledger-directory .hosted-share-member')!.click());
      expect(select).toHaveBeenCalledWith('90');
      act(() => root.render(<HostedShareCollection data={data} collectionPath="/s/wp/original" onSelect={select} selectedSiteId="90" reader={<p>第 90 篇正文</p>} />));
      expect(element.querySelector<HTMLInputElement>('[aria-label="查找合集文档"]')!.value).toBe('资料 90');
      expect(element.querySelector('.ledger-reader-content')!.textContent).toBe('第 90 篇正文');
      expect(element.querySelector<HTMLAnchorElement>('.ledger-reading-pager a')!.getAttribute('href')).toBe('/s/wp/original?siteId=89');
      expect(element.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe('/s/wp/original?siteId=90');
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
        expect(link.target).toBe('');
      }
      expect(element.querySelector('a[href*="cos.example"]')).toBeNull();
      expect(element.querySelector('canvas')).toBeNull(); // reduced motion keeps readable content
      expect(element.textContent).toContain('9 个文件');
      act(() => [...element.querySelectorAll('button')].find(button => button.textContent === '登录并保存')!.click());
      expect(save).toHaveBeenCalledOnce();
    } finally { act(() => root.unmount()); }
  });
});
