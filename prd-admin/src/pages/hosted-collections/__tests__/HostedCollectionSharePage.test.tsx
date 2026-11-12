// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HostedCollectionSharePage from '../HostedCollectionSharePage';
import type { HostedCollectionShare, HostedCollectionView } from '@/services/contracts/hostedCollections';

const api = vi.hoisted(() => ({ view: vi.fn(), shares: vi.fn(), permissions: vi.fn(), members: vi.fn(), create: vi.fn() }));
vi.mock('@/services/real/hostedCollections', () => ({ getHostedCollection: api.view, getHostedCollectionShares: api.shares,
  getHostedCollectionPermissions: api.permissions, findHostedCollectionMembers: api.members, createHostedCollectionShare: api.create,
  dissolveHostedCollection: vi.fn(), restoreHostedCollection: vi.fn(), stopHostedCollectionShares: vi.fn(), syncHostedCollectionPermissions: vi.fn() }));
vi.mock('@/services/real/webPages', () => ({ getSitesPrivateSources: vi.fn(), revokeShare: vi.fn() }));
vi.mock('@/components/web-hosting/privateSourceConfirm', () => ({ runWithPrivateSourceGate: async (options: { run: (fingerprint?: string) => Promise<unknown> }) => ({ status: 'done', res: await options.run() }) }));
vi.mock('../CollectionShell', () => ({ CollectionShell: ({ children }: { children: ReactNode }) => <div>{children}</div>, collectionDate: () => '11-13' }));
vi.mock('../HostedCollectionManage', () => ({ HostedCollectionManage: () => null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => <p>正在读取</p> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ok = <T,>(data: T) => ({ success: true, data });
let root: Root, container: HTMLDivElement;
const view: HostedCollectionView = { collection: { id: 'c', name: '交接资料', description: '', siteIds: ['doc'], mainSiteId: 'doc', sections: [], version: 2 }, items: [{ id: 'doc', title: '交接说明', canShare: true, canEdit: true }], canManage: true };
const oldLink = (values: Partial<HostedCollectionShare> = {}): HostedCollectionShare => ({ id: 'old', token: 'token', title: '评审用链接', visibility: 'public', accessLevel: 'password', createdAt: '2026-11-01T00:00:00Z', viewCount: 0, isRevoked: false, shareUrl: '/s/collection/token', snapshot: { collectionId: 'c', version: 1, name: '交接资料', description: '', siteIds: ['doc'], mainSiteId: 'doc', sections: [] }, ...values });
function button(text: string) { const b = [...container.querySelectorAll('button')].find(e => e.textContent === text); expect(b, text).toBeTruthy(); return b!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function mount(link = oldLink()) {
  api.shares.mockResolvedValue(ok({ items: [link] }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={['/web-pages/collections/c/share']}><Routes><Route path="/web-pages/collections/:collectionId/share" element={<HostedCollectionSharePage />} /></Routes></MemoryRouter>));
  await click('按当前成员重新分享');
}
beforeEach(() => {
  vi.clearAllMocks(); api.view.mockResolvedValue(ok(view)); api.permissions.mockResolvedValue(ok({ fingerprint: 'rights', items: [{ id: 'doc', title: '交接说明', canShare: true, canSync: true, matches: true }] }));
  api.members.mockResolvedValue(ok({ items: [] })); api.create.mockResolvedValue(ok({ id: 'new', token: 'new', shareUrl: '/s/collection/new' }));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });

describe('重新分享必须保留原有访问约束', () => {
  it('原密码链默认仍要求密码，未重新填写前不能进入下一步，也不回显旧密码', async () => {
    await mount();
    expect(button('设置').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector<HTMLInputElement>('[aria-label="访问密码"]')?.value).toBe('');
    await click('下一步');
    expect(container.textContent).toContain('请填写访问密码');
    expect(api.create).not.toHaveBeenCalled();
  });
  it('指定名单直接带入重新分享，创建请求保留原成员ID，不扩成全体登录用户', async () => {
    await mount(oldLink({ accessLevel: 'public', visibility: 'logged-in', snapshot: { ...oldLink().snapshot, accessUserIds: ['member-a', 'member-b'] } }));
    await click('下一步'); await click('下一步'); await click('创建并复制链接');
    expect(api.create).toHaveBeenCalledWith('c', expect.objectContaining({ accessUserIds: ['member-a', 'member-b'], visibility: 'logged-in' }));
  });
  it('密码与指定名单同时存在时，重新分享同时保留两种约束并显示真实成员名', async () => {
    await mount(Object.assign(oldLink({ visibility: 'logged-in', snapshot: { ...oldLink().snapshot, accessUserIds: ['member-a'] } }), { accessMembers: [{ id: 'member-a', name: '陈甲' }] }));
    expect(container.textContent).toContain('陈甲');
    await act(async () => { const e = container.querySelector<HTMLInputElement>('[aria-label="访问密码"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(e, 'reentered-test-only'); e.dispatchEvent(new Event('input', { bubbles: true })); });
    await click('下一步'); await click('下一步'); await click('创建并复制链接');
    expect(api.create).toHaveBeenCalledWith('c', expect.objectContaining({ accessUserIds: ['member-a'], password: 'reentered-test-only', visibility: 'logged-in' }));
  });
  it('仅自己与指定名单是叠加约束，重新分享必须同时保留', async () => {
    await mount(oldLink({ accessLevel: 'public', visibility: 'owner-only', snapshot: { ...oldLink().snapshot, accessUserIds: ['old-member'] } }));
    expect(button('仅自己').getAttribute('aria-pressed')).toBe('true');
    await click('下一步'); await click('下一步'); await click('创建并复制链接');
    expect(api.create).toHaveBeenCalledWith('c', expect.objectContaining({ visibility: 'owner-only', accessUserIds: ['old-member'] }));
  });
  it('无密码的旧链接不会被误判成需要密码' , async () => {
    await mount(oldLink({ accessLevel: 'public' }));
    expect(button('不设置').getAttribute('aria-pressed')).toBe('true');
    await click('下一步');
    expect(container.textContent).not.toContain('请填写访问密码');
  });
});
