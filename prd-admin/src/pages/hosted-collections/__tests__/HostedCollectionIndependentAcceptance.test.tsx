// @vitest-environment jsdom
// Component/transport contract evidence, not preview-live business acceptance.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostedCollectionManage } from '../HostedCollectionManage';
import HostedCollectionSharePage from '../HostedCollectionSharePage';
import HostedCollectionPage from '../HostedCollectionPage';
import type { HostedCollectionView, SaveHostedCollection } from '@/services/contracts/hostedCollections';
const api = vi.hoisted(() => ({ request: vi.fn(), sources: vi.fn() }));
vi.mock('@/services/real/apiClient', () => ({ apiRequest: api.request, resolveApiUrl: (url: string) => url }));
vi.mock('@/services/real/webPages', () => ({ getSitesPrivateSources: api.sources, revokeShare: vi.fn() }));
vi.mock('../CollectionShell', () => ({ CollectionShell: ({ children }: { children: ReactNode }) => <div>{children}</div>, collectionDate: () => '11-14' }));
vi.mock('../HostedCollectionDocument', () => ({ HostedCollectionDocument: () => <div>正文</div> }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => <p>正在读取</p>, MapSpinner: () => <span>正在读取</span> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ok = <T,>(data: T) => ({ success: true, data });
const view: HostedCollectionView = { collection: { id: 'c', name: '独立验收合集', description: '', siteIds: ['main', 'a', 'b'], mainSiteId: 'main', sections: [{ id: 'chapter', title: '执行章节', siteIds: ['a', 'b'] }], version: 1 }, items: ['main', 'a', 'b'].map(id => ({ id, title: id, canShare: true, canEdit: true })), canManage: true };
let root: Root | undefined, container: HTMLDivElement;
let saved: SaveHostedCollection | undefined;
let syncCalls: Record<string, unknown>[], shareCalls: unknown[];
let tightening: boolean, legacyOrder: boolean;
async function click(text: string) { const b = [...document.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent === text); expect(b, text).toBeTruthy(); await act(async () => b!.click()); }
async function mount(element: ReactNode) { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); await act(async () => root!.render(<MemoryRouter initialEntries={['/web-pages/collections/c/share']}><Routes><Route path="/web-pages/collections/:collectionId/share" element={element} /></Routes></MemoryRouter>)); }
beforeEach(() => {
  vi.clearAllMocks(); saved = undefined; syncCalls = []; shareCalls = []; tightening = false; legacyOrder = false;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.sources.mockResolvedValue(ok({ requiresConfirmation: true, fingerprint: 'private-fingerprint', items: [{ siteId: 'a', entryId: 'source', title: '私有原始资料', scopeLabel: '仅自己' }] }));
  api.request.mockImplementation(async (url: string, options?: { body?: Record<string, unknown> }) => {
    if (url.endsWith('/candidates')) return ok({ items: view.items, templates: [], legacy: [] });
    if (url.includes('/members?')) return ok({ items: [] });
    if (url.endsWith('/permissions/sync')) {
      const body = options!.body!; syncCalls.push(body);
      // Mirrors the server gate contract; missing confirmation must fail.
      if (!tightening && body.confirmedPrivateSourceFingerprint !== 'private-fingerprint') return { success: false, error: { code: 'HOSTED_SITE_PRIVATE_SOURCE_CONFIRMATION_REQUIRED', message: '私有资料需要确认' } };
      return ok({ results: [{ id: 'a', success: true, message: '页面权限已同步' }], fingerprint: 'rights' });
    }
    if (url.endsWith('/permissions')) return ok({ fingerprint: 'rights', items: view.items.map(item => ({ id: item.id, title: item.title, visibility: tightening ? item.id === 'a' ? 'public' : 'private' : item.id === 'main' ? 'public' : 'private', canShare: true, canSync: true, matches: item.id !== 'a', differences: ['将原文设为公开'] })) });
    if (url.endsWith('/shares')) { if (options?.body) { shareCalls.push(options.body); return ok({ id: 'new', token: 'new', shareUrl: '/s/collection/new' }); } return ok({ items: [] }); }
    if (options?.body) { saved = options.body as unknown as SaveHostedCollection; return ok({ ...view, collection: { ...view.collection, ...saved } }); }
    return ok({ ...structuredClone(view), collection: { ...structuredClone(view.collection), siteIds: legacyOrder ? ['main', 'b', 'a'] : view.collection.siteIds } });
  });
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); vi.restoreAllMocks(); });
it('作者移动章节成员后保存的章节顺序与全局阅读顺序一致', async () => {
  await mount(<HostedCollectionManage data={structuredClone(view)} onClose={() => undefined} onSaved={() => undefined} />);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="上移b"]')!.click()); await click('保存修改');
  expect(saved?.siteIds).toEqual(['main', 'b', 'a']); expect(saved?.sections[0].siteIds).toEqual(['b', 'a']);
});
it('同步含私有来源的原文为公开时先确认，再携带确认执行并完成分享', async () => {
  await mount(<HostedCollectionSharePage />); await click('下一步');
  await act(async () => container.querySelector<HTMLInputElement>('.drow input[type="checkbox"]')!.click());
  await click('下一步'); await click('创建并复制链接');
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('私有原始资料'));
  expect(syncCalls).toContainEqual(expect.objectContaining({ siteIds: ['a'], confirmedPrivateSourceFingerprint: 'private-fingerprint' }));
  expect(shareCalls).toHaveLength(1); expect(container.textContent).toContain('链接已创建');
});

async function selectSyncAndSubmit() {
  await click('下一步');
  await act(async () => container.querySelector<HTMLInputElement>('.drow input[type="checkbox"]')!.click());
  await click('下一步'); await click('创建并复制链接');
}
it('取消原文公开确认不执行同步或创建分享', async () => {
  vi.mocked(window.confirm).mockReturnValue(false);
  await mount(<HostedCollectionSharePage />); await selectSyncAndSubmit();
  expect(window.confirm).toHaveBeenCalled(); expect(syncCalls).toHaveLength(0); expect(shareCalls).toHaveLength(0);
});
it('确认过期后重新核查并确认，不把旧指纹重用于新的私有来源集合', async () => {
  api.sources.mockResolvedValueOnce(ok({ requiresConfirmation: true, fingerprint: 'old-fingerprint', items: [{ title: '旧私有资料', scopeLabel: '仅自己' }] }));
  await mount(<HostedCollectionSharePage />); await selectSyncAndSubmit();
  expect(syncCalls.map(body => body.confirmedPrivateSourceFingerprint)).toEqual(['old-fingerprint', 'private-fingerprint']);
  expect(api.sources).toHaveBeenNthCalledWith(1, ['a']); expect(api.sources).toHaveBeenNthCalledWith(2, ['a']);
  expect(shareCalls).toHaveLength(1);
});
it('收紧原文权限免除公开确认，创建分享仍独立执行自己的来源确认', async () => {
  tightening = true;
  await mount(<HostedCollectionSharePage />); await selectSyncAndSubmit();
  expect(syncCalls).toHaveLength(1); expect(syncCalls[0].confirmedPrivateSourceFingerprint).toBeUndefined();
  expect(api.sources).toHaveBeenCalledTimes(1); expect(api.sources).toHaveBeenCalledWith(['main', 'a', 'b']);
  expect(shareCalls).toHaveLength(1);
});

it('旧数据章节数组逆序时目录仍遵循作者保存的全局顺序', async () => {
  legacyOrder = true;
  await mount(<HostedCollectionPage />);
  expect([...container.querySelectorAll<HTMLElement>('.hc-mobile-directory [data-member]')].map(row => row.dataset.member)).toEqual(['b', 'a']);
});
