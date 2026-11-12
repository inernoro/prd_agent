// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HostedCollectionPage from '../HostedCollectionPage';
import type { HostedCollectionItem, HostedCollectionView } from '@/services/contracts/hostedCollections';

const api = vi.hoisted(() => ({ get: vi.fn(), share: vi.fn() }));
vi.mock('@/services/real/hostedCollections', () => ({ getHostedCollection: api.get, readHostedCollectionShare: api.share }));
vi.mock('../CollectionShell', () => ({ CollectionShell: ({ children }: { children: ReactNode }) => <div>{children}</div>, collectionDate: () => '11-13' }));
vi.mock('../HostedCollectionManage', () => ({ HostedCollectionManage: () => null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => <p>正在读取</p> }));
vi.mock('../HostedCollectionDocument', () => ({ HostedCollectionDocument: ({ item, items, onNavigate, onBack }: { item?: HostedCollectionItem; items: HostedCollectionItem[]; onNavigate: (id: string) => void; onBack: () => void }) => <div data-reading><p>{item?.title ?? '错误：继承了其他合集的文档'}</p><button onClick={() => { const i = items.findIndex(x => x.id === item?.id); if (items[i + 1]) onNavigate(items[i + 1].id); }}>下一篇</button><button onClick={onBack}>返回目录</button></div> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ok = <T,>(data: T) => ({ success: true, data });
function fixture(id = 'a', count = 90): HostedCollectionView {
  const items = Array.from({ length: count }, (_, i) => ({ id: `${id}-${i}`, title: `${id}文档${i + 1}`, canEdit: true, canShare: true }));
  return { collection: { id, name: `${id}合集`, description: '', siteIds: items.map(x => x.id), mainSiteId: items[0].id, sections: [], version: 1 }, items, canManage: true };
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
let root: Root, container: HTMLDivElement;
function Navigation() { const go = useNavigate(); return <button onClick={() => go('/web-pages/collections/b')}>切换到B</button>; }
async function mount(path = '/web-pages/collections/a') {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={[path]}><Navigation /><Routes><Route path="/web-pages/collections/:collectionId" element={<HostedCollectionPage />} /><Route path="/s/collection/:token" element={<HostedCollectionPage />} /></Routes></MemoryRouter>));
}
function button(text: string) { const b = [...container.querySelectorAll('button')].find(e => e.textContent === text); expect(b, text).toBeTruthy(); return b!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function typeSearch(value: string) {
  await act(async () => { const e = container.querySelector<HTMLInputElement>('[aria-label="在合集中查找"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); });
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); api.get.mockImplementation(async id => ok(fixture(id, id === 'a' ? 90 : 3)));
  Element.prototype.scrollTo = vi.fn(); Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); vi.unstubAllGlobals(); });

describe('合集阅读游标必须跟随文档与路由', () => {
  it('连续提交访问密码时，旧失败不能覆盖较新的成功', async () => {
    const slow = deferred<{ success: false; error: { code: string; message: string } }>();
    api.share.mockImplementation((_token, password) => password === 'bad' ? slow.promise : Promise.resolve(password === 'good' ? ok(fixture('shared', 3)) : { success: false, error: { code: 'PASSWORD_REQUIRED', message: '请提供密码' } }));
    await mount('/s/collection/token');
    async function submit(value: string) {
      await act(async () => { const e = container.querySelector<HTMLInputElement>('input[type=password]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); });
      await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    }
    await submit('bad'); await submit('good');
    await act(async () => slow.resolve({ success: false, error: { code: 'PASSWORD_INVALID', message: '旧密码错误' } }));
    expect(container.textContent).toContain('shared合集');
    expect(container.textContent).not.toContain('旧密码错误');
  });
  it('第31篇跳到第32篇再返回目录，应进入第2页并显示刚读过的文档', async () => {
    await mount(); await act(async () => (container.querySelector('[data-member="a-30"]') as HTMLButtonElement).click());
    await click('下一篇'); await click('返回目录');
    expect(container.querySelector('.pg[aria-current="true"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-member="a-31"]')?.classList.contains('last')).toBe(true);
  });
  it('切换合集不能沿用旧合集的查找、当前文档和分页', async () => {
    await mount(); await typeSearch('a文档31'); await act(async () => (container.querySelector('[data-member="a-30"]') as HTMLButtonElement).click());
    await click('切换到B');
    expect(container.querySelector('[data-reading]')).toBeNull();
    expect([...container.querySelectorAll('h1')].some(h => h.textContent === 'b合集')).toBe(true);
    expect((container.querySelector('[aria-label="在合集中查找"]') as HTMLInputElement)?.value).toBe('');
  });
  it('旧合集的慢回包不能覆盖已打开的新合集', async () => {
    const slow = deferred<ReturnType<typeof ok<HostedCollectionView>>>();
    api.get.mockImplementation(id => id === 'a' ? slow.promise : Promise.resolve(ok(fixture('b', 3))));
    await mount(); await click('切换到B');
    await act(async () => slow.resolve(ok(fixture('a'))));
    expect([...container.querySelectorAll('h1')].some(h => h.textContent === 'b合集')).toBe(true);
    expect(container.textContent).not.toContain('a合集');
  });
  it('新合集读取失败时，不应继续显示上一合集并允许操作', async () => {
    api.get.mockImplementation(async id => id === 'a' ? ok(fixture('a')) : { success: false, error: { code: 'FORBIDDEN', message: '无权访问B' } });
    await mount(); await click('切换到B');
    expect(container.textContent).toContain('无权访问B');
    expect(container.textContent).not.toContain('a合集');
    expect(container.querySelector('[data-member="a-0"]')).toBeNull();
  });
});
