// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RelatedDocumentsBar from './RelatedDocumentsBar';
import { getRelatedCandidates, getRelatedDocuments, previewRelatedPermissions, saveRelatedDocuments, syncRelatedPermissions,
  type RelatedDocuments, type RelatedPermissionPreview } from '@/services/real/relatedDocuments';

vi.mock('@/services/real/relatedDocuments', () => ({ getRelatedCandidates: vi.fn(), getRelatedDocuments: vi.fn(), previewRelatedPermissions: vi.fn(), saveRelatedDocuments: vi.fn(), syncRelatedPermissions: vi.fn() }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (selector: (value: { token: string }) => unknown) => selector({ token: 'session' }) }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>正在加载</span> }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ open, title, content, actions }: { open: boolean; title: string; content: React.ReactNode; actions: React.ReactNode }) => open ? <section role="dialog" aria-label={title}>{content}{actions}</section> : null }));

let container: HTMLDivElement;
let root: Root;
const data: RelatedDocuments = {
  version: 3, mainSiteId: 'a', canManage: true, hasPermissionDifferences: true,
  items: [
    { id: 'a', title: '总体方案', isMain: true, href: '/web-pages?openSite=a' },
    { id: 'b', title: '技术设计', href: '/web-pages?openSite=b' },
  ],
};
const preview: RelatedPermissionPreview = {
  sourceId: 'a', sourceTitle: '总体方案', fingerprint: 'checked-version', canSync: true, canRevokeShares: true,
  shareNotice: '分享链接独立授权，不复制密码。',
  items: [
    { ...data.items[0], matches: true, differences: [], activeShareCount: 1 },
    { ...data.items[1], matches: false, differences: ['新增 1 个团队的访问权限'], activeShareCount: 2 },
  ],
};
const clickText = async (text: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
};
const open = async () => { await act(async () => container.querySelector<HTMLButtonElement>('.related-trigger')!.click()); };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.mocked(getRelatedDocuments).mockResolvedValue({ success: true, data, error: null });
  vi.mocked(getRelatedCandidates).mockResolvedValue({ success: true, data: { items: [...data.items, { id: 'c', title: '测试方案' }] }, error: null });
  vi.mocked(previewRelatedPermissions).mockResolvedValue({ success: true, data: preview, error: null });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('顶部关联文档', () => {
  it('展开服务端可见列表，跳转回调使用目标文档并标记当前页', async () => {
    const navigate = vi.fn();
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" onNavigate={navigate} />));
    await open();
    expect(document.querySelectorAll('.related-document-card')).toHaveLength(2);
    expect(document.querySelector('[aria-current="page"]')?.textContent).toContain('总体方案');
    await act(async () => document.querySelector<HTMLAnchorElement>('a[href="/web-pages?openSite=b"]')!.click());
    expect(navigate).toHaveBeenCalledWith(data.items[1]);
    expect(document.querySelector('.related-popover')).toBeNull();
  });
  it('只读访问不展示管理和权限差异入口，不推导隐藏数量', async () => {
    vi.mocked(getRelatedDocuments).mockResolvedValue({ success: true, data: { ...data, version: 0, canManage: false, mainSiteId: null, items: [data.items[1]] }, error: null });
    await act(async () => root.render(<RelatedDocumentsBar siteId="b" source={{ token: 'limited-share', password: 'password' }} />));
    await open();
    expect(getRelatedDocuments).toHaveBeenCalledWith('b', { token: 'limited-share', password: 'password' });
    expect(container.querySelector('.related-count')?.textContent).toBe('1');
    expect(document.body.textContent).not.toContain('总体方案');
    expect(document.body.textContent).not.toContain('管理关联');
    expect(document.body.textContent).not.toContain('权限不一致');
  });
  it('添加关联、更换主文档后提交完整选择及并发版本', async () => {
    vi.mocked(saveRelatedDocuments).mockResolvedValue({ success: true, data: { ...data, version: 4, mainSiteId: 'c' }, error: null });
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" />));
    await open(); await clickText('管理关联'); await clickText('测试方案');
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="设为主文档：测试方案"]')!.click());
    await clickText('保存关联');
    expect(saveRelatedDocuments).toHaveBeenCalledWith('a', { siteIds: ['a', 'b', 'c'], mainSiteId: 'c', version: 3 });
  });
  it('取消权限预览没有写操作，确认时使用后端指纹并默认保留分享链接', async () => {
    vi.mocked(syncRelatedPermissions).mockResolvedValue({ success: true, data: { results: [{ id: 'b', title: '技术设计', success: true, message: '页面权限已同步' }], sharesRevoked: 0 }, error: null });
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" />));
    await clickText('权限不一致');
    expect(document.body.textContent).toContain('新增 1 个团队');
    await clickText('取消');
    expect(syncRelatedPermissions).not.toHaveBeenCalled();
    await clickText('权限不一致'); await clickText('应用统一权限');
    expect(syncRelatedPermissions).toHaveBeenCalledWith('a', 'checked-version', false);
    expect(document.body.textContent).toContain('技术设计：页面权限已同步');
  });
  it('超过九份分页，切页后卡片仍保留真实地址', async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ id: `doc-${index}`, title: `文档 ${index}`, href: `/web-pages?openSite=doc-${index}` }));
    vi.mocked(getRelatedDocuments).mockResolvedValue({ success: true, data: { ...data, items }, error: null });
    await act(async () => root.render(<RelatedDocumentsBar siteId="doc-0" />));
    await open();
    expect(document.querySelectorAll('.related-document-card')).toHaveLength(9);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click());
    expect(document.querySelectorAll('.related-document-card')).toHaveLength(3);
    expect(document.querySelector('a[href="/web-pages?openSite=doc-11"]')).not.toBeNull();
  });
});
