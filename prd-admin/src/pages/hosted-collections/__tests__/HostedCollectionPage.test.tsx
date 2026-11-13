// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HostedCollectionPage from '../HostedCollectionPage';
import type { HostedCollectionItem, HostedCollectionView } from '@/services/contracts/hostedCollections';

const api = vi.hoisted(() => ({ get: vi.fn(), share: vi.fn() }));
vi.mock('@/services/real/hostedCollections', () => ({ getHostedCollection: api.get, readHostedCollectionShare: api.share }));
vi.mock('../CollectionShell', () => ({ CollectionShell: ({ children, shareHref }: { children: ReactNode; shareHref?: string }) => <div data-shell-share-href={shareHref}>{children}</div>, collectionDate: () => '11-13' }));
vi.mock('../HostedCollectionManage', () => ({ HostedCollectionManage: ({ data, onSaved }: { data: HostedCollectionView; onSaved: (data: HostedCollectionView) => void }) => <div role="dialog" aria-label="管理合集">{data.collection.name}{data.collection.siteIds.length === 0 && <button onClick={() => onSaved({ ...data, collection: { ...data.collection, siteIds: ['restored-first'], mainSiteId: 'restored-first', version: data.collection.version + 1 }, items: [{ id: 'restored-first', title: '恢复首份文档', canEdit: true, canShare: true }] })}>添加首份并保存</button>}<button onClick={() => onSaved({ ...data, collection: { ...data.collection, siteIds: data.collection.siteIds.filter(id => !data.items.find(item => item.id === id)?.unavailable) }, items: data.items.filter(item => !item.unavailable) })}>保存移出不可用文档</button></div> }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => <p>正在读取</p> }));
vi.mock('../HostedCollectionDocument', () => ({ HostedCollectionDocument: ({ item, items, onNavigate, onBack, onManage }: { item?: HostedCollectionItem; items: HostedCollectionItem[]; onNavigate: (id: string) => void; onBack: () => void; onManage?: () => void }) => <div data-reading><p>{item?.title ?? '错误：继承了其他合集的文档'}</p>{item?.unavailable && onManage && <button onClick={onManage}>从合集移出</button>}<button onClick={() => { const i = items.findIndex(x => x.id === item?.id); if (items[i + 1]) onNavigate(items[i + 1].id); }}>下一篇</button><button onClick={onBack}>返回目录</button></div> }));
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
  it.each(['NOT_FOUND', 'visibility_denied', 'expired', 'NETWORK_ERROR', 'RATE_LIMITED'])('匿名分享的 %s 不能暗示输入密码可以恢复', async code => {
    api.share.mockResolvedValue({ success: false, error: { code, message: '访问边界错误' } });
    await mount('/s/collection/token');
    expect(container.textContent).toContain('访问边界错误');
    expect(container.querySelector('input[type=password]')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).not.toContain('打开合集');
    expect(button('重试')).toBeTruthy();
  });
  it('实际密码门 UNAUTHORIZED 保留密码输入及重新提交能力', async () => {
    api.share.mockResolvedValue({ success: false, error: { code: 'UNAUTHORIZED', message: '需要提供正确的访问密码' } });
    await mount('/s/collection/token');
    expect(container.querySelector('input[type=password]')).toBeTruthy();
    expect(button('打开合集')).toBeTruthy();
  });
  it('owner从不可用项可打开既有管理器，仍保留全部成员等待用户确认', async () => {
    const data = fixture('a', 3); data.items[1].unavailable = true; api.get.mockResolvedValue(ok(data));
    await mount(); await act(async () => (container.querySelector('[data-member="a-1"]') as HTMLButtonElement).click());
    await click('从合集移出');
    expect(container.querySelector('[role="dialog"][aria-label="管理合集"]')).toBeTruthy();
    expect(data.collection.siteIds).toEqual(['a-0', 'a-1', 'a-2']);
    await click('保存移出不可用文档');
    expect(container.querySelector('[data-reading]')).toBeNull();
    expect([...container.querySelectorAll('h1')].some(heading => heading.textContent === 'a合集')).toBe(true);
  });
  it('匿名分享的不可用项不提供作者移出入口', async () => {
    const data = fixture('shared', 3); data.canManage = false; data.items[1].unavailable = true; api.share.mockResolvedValue(ok(data));
    await mount('/s/collection/token'); await act(async () => (container.querySelector('[data-member="shared-1"]') as HTMLButtonElement).click());
    expect(container.querySelector('[data-reading]')?.textContent).not.toContain('从合集移出');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
  it('连续提交访问密码时，旧失败不能覆盖较新的成功', async () => {
    const slow = deferred<{ success: false; error: { code: string; message: string } }>();
    api.share.mockImplementation((_token, password) => password === 'bad' ? slow.promise : Promise.resolve(password === 'good' ? ok(fixture('shared', 3)) : { success: false, error: { code: 'UNAUTHORIZED', message: '请提供密码' } }));
    await mount('/s/collection/token');
    async function submit(value: string) {
      await act(async () => { const e = container.querySelector<HTMLInputElement>('input[type=password]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); });
      await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    }
    await submit('bad'); await submit('good');
    await act(async () => slow.resolve({ success: false, error: { code: 'UNAUTHORIZED', message: '旧密码错误' } }));
    expect(container.textContent).toContain('shared合集');
    expect(container.textContent).not.toContain('旧密码错误');
  });
  it('legacy零成员读取引导添加并禁分享，既有管理保存首份后恢复正常阅读', async () => {
    const data = fixture('a', 1); data.collection.siteIds = []; data.collection.mainSiteId = ''; data.items = [];
    api.get.mockResolvedValue(ok(data));
    await mount();
    expect(container.textContent).toContain('0 份文档');
    expect(container.textContent).toContain('还没有文档');
    expect(container.textContent).toContain('第一份会成为主文档');
    expect(container.textContent).toContain('合集在添加成员前不可分享');
    expect(container.querySelector('[data-shell-share-href]')).toBeNull();
    expect(container.querySelector('.hc-primary')).toBeNull();
    expect(container.querySelector('.hc-read-actions')?.textContent).not.toContain('从主文档开始阅读');
    await click('添加文档');
    expect(container.querySelector('[role="dialog"][aria-label="管理合集"]')).toBeTruthy();
    await click('添加首份并保存');
    expect(container.textContent).not.toContain('还没有文档');
    expect(container.querySelector('.hc-primary h2')?.textContent).toBe('恢复首份文档');
    expect(container.querySelector('[data-shell-share-href]')?.getAttribute('data-shell-share-href')).toBe('/web-pages/collections/a/share');
    await act(async () => (container.querySelector('.hc-primary .hc-mobile-read') as HTMLButtonElement).click());
    expect(container.querySelector('[data-reading] p')?.textContent).toBe('恢复首份文档');
  });
  it('主文档读后返回，手机主卡不再提供同目标继续01', async () => {
    await mount();
    await act(async () => (container.querySelector('.hc-primary .hc-mobile-read') as HTMLButtonElement).click());
    await click('返回目录');
    expect(localStorage.getItem('hosted-collection:last:a')).toBe('a-0');
    expect([...container.querySelectorAll('.hc-primary .hc-mobile-read')].map(e => e.textContent)).toEqual(['从主文档开始阅读']);
  });
  it('真实下一篇后仍提供手机继续02并回到该份文档', async () => {
    await mount();
    await act(async () => (container.querySelector('.hc-primary .hc-mobile-read') as HTMLButtonElement).click());
    await click('下一篇'); await click('返回目录');
    expect(localStorage.getItem('hosted-collection:last:a')).toBe('a-1');
    const actions = [...container.querySelectorAll<HTMLButtonElement>('.hc-primary .hc-mobile-read')];
    expect(actions.map(e => e.textContent)).toEqual(['从主文档开始阅读', '继续 · 02']);
    await act(async () => actions[1].click());
    expect(container.querySelector('[data-reading] p')?.textContent).toBe('a文档2');
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
