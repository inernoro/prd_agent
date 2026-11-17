// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WritingPublicationActions } from '../WritingPublicationActions';
const auth = vi.hoisted(() => ({ isAuthenticated: true, isRoot: false, permissions: ['document-store.read'], token: null as string | null, authSessionEpoch: 0 }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: Object.assign((select: (state: typeof auth) => unknown) => select(auth), { getState: () => auth }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, container: HTMLDivElement;
async function mount(props: { storeId?: string; entryId?: string; hasPublication?: boolean; publicStore?: boolean } = { storeId: 'store', entryId: 'doc', hasPublication: true }) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter><WritingPublicationActions {...props} /></MemoryRouter>));
}
beforeEach(() => { auth.isAuthenticated = true; auth.isRoot = false; auth.permissions = ['document-store.read']; });
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); vi.unstubAllGlobals(); });
describe('发布阅读入口的认证与授权边界', () => {
  it('全局只读者可以阅读与学习，入口不依赖写权限', async () => {
    await mount(); expect(container.querySelectorAll('a')).toHaveLength(2);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/document-store/store/write/doc/read');
  });
  it('仅有写权不能作为已有读权证明', async () => {
    auth.permissions = ['document-store.write']; await mount(); expect(container.querySelector('a')).toBeNull();
  });
  it('匿名私库不会得到原库深链或登录诱导', async () => {
    auth.isAuthenticated = false; auth.permissions = []; await mount(); expect(container.querySelector('a')).toBeNull();
  });
  it('公共库匿名用户明确先登录，returnUrl保留编码后的目标', async () => {
    auth.isAuthenticated = false; auth.permissions = [];
    await mount({ storeId: 'store', entryId: 'doc', hasPublication: true, publicStore: true });
    const links = [...container.querySelectorAll('a')]; expect(links.every(a => a.textContent?.startsWith('登录后'))).toBe(true);
    expect(links[1].getAttribute('href')).toBe('/login?returnUrl=%2Fdocument-store%2Fstore%2Fwrite%2Fdoc%2Flearn');
  });
  it('没有发布快照或没有显式原库上下文时没有入口', async () => {
    await mount({ storeId: 'store', entryId: 'doc', hasPublication: false, publicStore: true }); expect(container.querySelector('a')).toBeNull();
    await act(async () => root.render(<MemoryRouter><WritingPublicationActions entryId="doc" hasPublication publicStore /></MemoryRouter>));
    expect(container.querySelector('a')).toBeNull();
  });
});


describe('正常公库读取不能在客户端强制要求登录', () => {
  it('四个匿名GET实际发出请求，私库分享创建仍需登录', async () => {
    auth.isAuthenticated = false; auth.permissions = []; auth.token = null;
    await mount({ hasPublication: false });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { items: [], total: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const service = await import('@/services/real/documentStore');
    const reads = await Promise.all([service.listPublicDocumentStores(), service.getPublicDocumentStore('store'), service.listPublicStoreEntries('store'), service.getPublicEntryContent('doc')]);
    expect(reads.every(result => result.success)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const call of fetcher.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[1].method).toBe('GET');
      expect(new Headers(call[1].headers).has('Authorization')).toBe(false);
    }
    const write = await service.createShareLink('store', { title: '不能匿名创建分享' });
    expect(write.success).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
