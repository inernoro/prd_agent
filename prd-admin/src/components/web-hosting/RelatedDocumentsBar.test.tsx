// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RelatedDocumentsBar from './RelatedDocumentsBar';
import { updateSite } from '@/services/real/webPages';
import { getRelatedCandidates, getRelatedDocuments, previewRelatedPermissions, saveRelatedDocuments, syncRelatedPermissions,
  type RelatedDocuments, type RelatedPermissionPreview } from '@/services/real/relatedDocuments';

vi.mock('@/services/real/webPages', () => ({ updateSite: vi.fn() }));
vi.mock('@/components/SitePreview', () => ({ SitePreview: ({ url }: { url: string }) => <div data-page-preview={url} /> }));
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
  localStorage.clear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.mocked(getRelatedDocuments).mockResolvedValue({ success: true, data, error: null });
  vi.mocked(getRelatedCandidates).mockResolvedValue({ success: true, data: { items: [...data.items, { id: 'c', title: '测试方案' }] }, error: null });
  vi.mocked(previewRelatedPermissions).mockResolvedValue({ success: true, data: preview, error: null });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('顶部关联文档', () => {
  it('Escape 先关闭关联浮层并归还焦点，再按一次才交给父阅读器', async () => {
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" variant="toolbar" />));
    const parentEscape = vi.fn();
    document.addEventListener('keydown', parentEscape, true);
    try {
      await open();
      const anchor = container.querySelector<HTMLButtonElement>('.related-trigger')!;
      const first = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      await act(async () => anchor.dispatchEvent(first));
      expect(document.querySelector('.related-popover')).toBeNull();
      expect(first.defaultPrevented).toBe(true);
      expect(parentEscape).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(anchor);
      await act(async () => anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      expect(parentEscape).toHaveBeenCalledTimes(1);
    } finally { document.removeEventListener('keydown', parentEscape, true); }
  });
  it('列表关联标记先展示摘要，点击才读取完整关联与预览', async () => {
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" variant="badge" summary={{ count: 1, isMain: true, mainTitle: '总体方案', titles: ['技术设计'] }} />));
    expect(getRelatedDocuments).not.toHaveBeenCalled();
    expect(container.querySelector('.related-trigger')?.getAttribute('title')).toContain('技术设计');
    await open();
    expect(getRelatedDocuments).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.related-document-card')).toHaveLength(2);
  });
  it('紧凑工具栏把主文档和权限说明放进浮层，并提供独立标签页入口', async () => {
    const navigate = vi.fn();
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" variant="toolbar" onNavigate={navigate} />));
    expect(container.querySelector('.related-main-label')).toBeNull();
    expect(container.querySelector('.related-permission-hint')).toBeNull();
    expect(container.querySelector('[data-permission-warning]')).not.toBeNull();
    expect(container.querySelector('.related-trigger')?.getAttribute('title')).toContain('权限不一致');
    await open();
    expect(document.querySelector('.related-context-row')?.textContent).toContain('总体方案');
    expect(document.querySelector('.related-context-row')?.textContent).toContain('权限不一致');
    const external = document.querySelector<HTMLAnchorElement>('[aria-label="在新标签页打开：技术设计"]')!;
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('href')).toBe('/web-pages?openSite=b');
    expect(external.rel).toContain('noopener');
    expect(external.closest('.related-document-card')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });


  it('真实页面预览接入，并支持列表与卡片视图切换和记忆', async () => {
    const previewItem = { ...data.items[1], preview: { id: 'b', siteUrl: 'https://assets.test/b.html', entryFile: 'index.html', useShareAccess: false } };
    vi.mocked(getRelatedDocuments).mockResolvedValue({ success: true, data: { ...data, items: [previewItem] }, error: null });
    await act(async () => root.render(<RelatedDocumentsBar siteId="b" />)); await open();
    expect(document.querySelector('[data-page-preview="https://assets.test/b.html"]')).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="列表视图"]')!.click());
    expect(document.querySelector('.related-document-grid')?.classList.contains('is-list')).toBe(true);
    expect(localStorage.getItem('hosted-related-view')).toBe('list');
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="卡片视图"]')!.click());
    expect(document.querySelector('.related-document-grid')?.classList.contains('is-list')).toBe(false);
  });
  it('评论来源与自定义标签可见，自动引用不会被管理面板当作手动关联保存', async () => {
    const automatic = { id: 'c', title: '评论提到的方案', isManual: false, tags: ['设计'], mentions: [{ commentId: 'comment-1', authorName: '小林', sourceSiteId: 'a', sourceTitle: '总体方案', label: '评论区小林提到' }] };
    vi.mocked(getRelatedDocuments).mockResolvedValue({ success: true, data: { ...data, items: [...data.items, automatic] }, error: null });
    vi.mocked(saveRelatedDocuments).mockResolvedValue({ success: true, data, error: null });
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" />));await open();
    expect(document.body.textContent).toContain('评论区小林提到');
    await clickText('设计');
    expect(document.querySelectorAll('.related-document-card')).toHaveLength(1);
    await clickText('管理关联');await clickText('保存关联');
    expect(saveRelatedDocuments).toHaveBeenCalledWith('a', { siteIds: ['a', 'b'], mainSiteId: 'a', version: 3 });
  });
  it('文档标签通过现有文档接口保存，并在评论变化后重新读取关联列表', async () => {
    vi.mocked(getRelatedDocuments).mockResolvedValue({ success: true, data: { ...data, items: [{ ...data.items[0], canEditTags: true, tags: ['原标签'] }] }, error: null });
    vi.mocked(updateSite).mockResolvedValue({ success: true, data: {} as never, error: null });
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" />)); await open();
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="编辑标签：总体方案"]')!.click());
    await clickText('保存标签');
    expect(updateSite).toHaveBeenCalledWith('a', { tags: ['原标签'] });
    const before = vi.mocked(getRelatedDocuments).mock.calls.length;
    await act(async () => window.dispatchEvent(new Event('hosted-comments-changed')));
    expect(vi.mocked(getRelatedDocuments).mock.calls.length).toBeGreaterThan(before);
  });

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
