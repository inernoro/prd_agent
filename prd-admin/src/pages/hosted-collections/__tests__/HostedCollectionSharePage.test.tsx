// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HostedCollectionSharePage from '../HostedCollectionSharePage';
import { CollectionShell } from '../CollectionShell';
import type { HostedCollectionShare, HostedCollectionView } from '@/services/contracts/hostedCollections';

const api = vi.hoisted(() => ({ view: vi.fn(), shares: vi.fn(), permissions: vi.fn(), members: vi.fn(), create: vi.fn(), sync: vi.fn() }));
vi.mock('@/services/real/hostedCollections', () => ({ getHostedCollection: api.view, getHostedCollectionShares: api.shares,
  getHostedCollectionPermissions: api.permissions, findHostedCollectionMembers: api.members, createHostedCollectionShare: api.create,
  dissolveHostedCollection: vi.fn(), restoreHostedCollection: vi.fn(), stopHostedCollectionShares: vi.fn(), syncHostedCollectionPermissions: api.sync }));
vi.mock('@/services/real/webPages', () => ({ getSitesPrivateSources: vi.fn(), revokeShare: vi.fn() }));
vi.mock('@/components/web-hosting/privateSourceConfirm', () => ({ runWithPrivateSourceGate: async (options: { run: (fingerprint?: string) => Promise<unknown> }) => ({ status: 'done', res: await options.run() }) }));
vi.mock('../../document-store/writing/WritingThreads', () => ({ WritingThreads: () => <canvas data-background="threads" /> }));
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
  it('分享页使用原稿纯底，阅读页仍保留动态背景及控制', async () => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><CollectionShell mode="share" name="分享资料"><p>分享内容</p></CollectionShell></MemoryRouter>));
    expect(container.querySelector('[data-background="threads"]')).toBeNull();
    expect(container.querySelector('[aria-label="动态背景"]')).toBeNull();
    await act(async () => root.render(<MemoryRouter><CollectionShell mode="read" name="阅读资料"><p>阅读内容</p></CollectionShell></MemoryRouter>));
    expect(container.querySelector('[data-background="threads"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="动态背景"]')).toBeTruthy();
  });
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
  it('公开链接与原文权限比较明确分域，公开副文档同步到私有主文档时说明实际变化', async () => {
    api.view.mockResolvedValue(ok({ ...view, collection: { ...view.collection, siteIds: ['doc', 'public'] }, items: [...view.items, { id: 'public', title: '公开副文档', canShare: true, canEdit: true }] }));
    api.permissions.mockResolvedValue(ok({ fingerprint: 'rights', items: [{ id: 'doc', title: '私有主文档', visibility: 'private', canShare: true, canSync: true, matches: true }, { id: 'public', title: '公开副文档', visibility: 'public', canShare: true, canSync: true, matches: false, differences: ['关闭个人公开页展示'] }] }));
    await mount(oldLink({ accessLevel: 'public' })); await click('下一步');
    expect(container.textContent).toContain('本次链接按「获得链接的人」授权');
    expect(container.textContent).toContain('表格仅比较原文与主文档的权限');
    expect(container.textContent).toContain('比较基准：主文档「私有主文档」· 仅自己');
    expect(container.querySelector('.drow.mono')?.textContent).not.toContain('分享需要');
    expect(container.textContent).not.toContain('分享前需要处理');
    expect(container.textContent).toContain('关闭个人公开页展示');
    expect(container.querySelectorAll('.drow input:checked')).toHaveLength(0);
    await click('下一步'); await click('创建并复制链接');
    expect(api.sync).not.toHaveBeenCalled();
    expect(api.create).toHaveBeenCalledWith('c', expect.objectContaining({ visibility: 'public', siteIds: ['doc', 'public'] }));
  });
  it('权限元数据不可读时不把未知原文权限显示为仅自己', async () => {
    api.permissions.mockResolvedValue(ok({ fingerprint: 'rights', items: [{ id: 'doc', title: '不可用文档', canShare: false, canSync: false, matches: false }] }));
    await mount(oldLink({ accessLevel: 'public' })); await click('下一步');
    const row = container.querySelectorAll('.drow')[1];
    expect(row.textContent).toContain('不可读取');
    expect(row.textContent).not.toContain('仅自己');
    expect(container.textContent).toContain('权限暂不可读');
  });
});
