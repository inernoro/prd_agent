// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RelatedDocumentsBar from './RelatedDocumentsBar';
import { getCollectionContexts, getCollectionContextDocuments, getCollectionContextLinks, type CollectionContext } from '@/services/real/hostedCollections';
import { updateSite } from '@/services/real/webPages';
import { HOSTED_SITE_PERMISSIONS_CHANGED, getRelatedCandidates, getRelatedDocuments, previewRelatedPermissions, saveRelatedDocuments, syncRelatedPermissions,
  type RelatedDocuments, type RelatedPermissionPreview } from '@/services/real/relatedDocuments';

vi.mock('@/services/real/webPages', () => ({ updateSite: vi.fn() }));
vi.mock('@/components/SitePreview', () => ({ SitePreview: ({ url }: { url: string }) => <div data-page-preview={url} /> }));
vi.mock('@/services/real/relatedDocuments', async importOriginal => ({ ...await importOriginal<typeof import('@/services/real/relatedDocuments')>(), getRelatedCandidates: vi.fn(), getRelatedDocuments: vi.fn(), previewRelatedPermissions: vi.fn(), saveRelatedDocuments: vi.fn(), syncRelatedPermissions: vi.fn() }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (selector: (value: { token: string }) => unknown) => selector({ token: 'session' }) }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>正在加载</span> }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ open, title, content, actions }: { open: boolean; title: string; content: React.ReactNode; actions: React.ReactNode }) => open ? <section role="dialog" aria-label={title}>{content}{actions}</section> : null }));

vi.mock('@/services/real/hostedCollections', async importOriginal => ({ ...await importOriginal<typeof import('@/services/real/hostedCollections')>(), getCollectionContexts: vi.fn(), getCollectionContextDocuments: vi.fn(), getCollectionContextLinks: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
const data: RelatedDocuments = {
  version: 3, mainSiteId: 'a', canManage: true, hasPermissionDifferences: true,
  items: [
    { id: 'a', title: '总体方案', isMain: true, href: '/web-pages?openSite=a' },
    { id: 'b', title: '技术设计', href: '/web-pages?openSite=b' },
  ],
};
const makeContext = (id: string, shareCount: number): CollectionContext => ({ id: 'collection:' + id, title: '合集 ' + id, memberCount: 2, updatedAt: '2026-11-11T10:00:00Z', collectionId: id, legacyShareId: null, shareCount, primaryLink: shareCount ? { id: 'link-' + id, title: id, shareUrl: '/s/wp/' + id, createdAt: '2026-11-11T10:00:00Z', accessLevel: 'public', memberCount: 2, isActive: true, statusLabel: '有效' } : null });
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
  vi.mocked(getCollectionContexts).mockResolvedValue({ success: true, data: { items: [], total: 0, totalContexts: 0, page: 1, pageSize: 20 }, error: null });
  vi.mocked(getCollectionContextDocuments).mockResolvedValue({ success: true, data: { ...data, canManage: false }, error: null });
  localStorage.clear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.mocked(getRelatedDocuments).mockResolvedValue({ success: true, data, error: null });
  vi.mocked(getRelatedCandidates).mockResolvedValue({ success: true, data: { items: [...data.items, { id: 'c', title: '测试方案' }] }, error: null });
  vi.mocked(previewRelatedPermissions).mockResolvedValue({ success: true, data: preview, error: null });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('顶部关联文档', () => {
  it('卡片只保留一个悬浮入口，没有合集时直接显示文档', async () => {
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" variant="badge" collectionNavigation siteTitle="总体方案" summary={{ count: 1, isMain: true, titles: ['技术设计'] }} />));
    expect(getCollectionContexts).not.toHaveBeenCalled();
    const trigger = container.querySelector<HTMLButtonElement>('.related-trigger')!;
    const enter = new Event('pointerover', { bubbles: true }); Object.defineProperty(enter, 'pointerType', { value: 'mouse' });
    await act(async () => trigger.dispatchEvent(enter));
    expect(getCollectionContexts).toHaveBeenCalledWith('a', 1, '');
    expect(document.querySelectorAll('.related-popover')).toHaveLength(1);
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(document.querySelector('[aria-label="所属合集"]')).toBeNull();
    expect(document.querySelectorAll('.related-document-card')).toHaveLength(2);
    expect(document.querySelector('[aria-label="文档关系类型"]')).toBeNull();
    expect(saveRelatedDocuments).not.toHaveBeenCalled();
  });
  it('单个合集直接展示文档和原链接，多条分享不会增加合集选择栏', async () => {
    const context = makeContext('one', 3);
    vi.mocked(getCollectionContexts).mockResolvedValue({ success: true, data: { items: [context], total: 1, totalContexts: 1, page: 1, pageSize: 20 }, error: null });
    vi.mocked(getCollectionContextLinks).mockResolvedValue({ success: true, data: { items: [context.primaryLink!], total: 3, page: 1, pageSize: 20 }, error: null });
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" variant="badge" collectionNavigation />)); await open();
    expect(document.querySelector('[data-collection-layout="single"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="所属合集"]')).toBeNull();
    expect(getCollectionContextDocuments).toHaveBeenCalledWith('a', 'collection:one');
    expect(getRelatedDocuments).not.toHaveBeenCalled();
    const footer = document.querySelector<HTMLElement>('[aria-label="合集链接操作"]')!;
    expect(footer).toBe(document.querySelector('.collection-context-panel')?.lastElementChild);
    expect(footer.querySelector<HTMLInputElement>('[aria-label="合集完整地址"]')?.value).toBe(window.location.origin + '/s/wp/one');
    expect(footer.querySelector('a')?.getAttribute('href')).toBe(window.location.origin + '/s/wp/one');
    expect(footer.querySelector('a')?.getAttribute('target')).toBe('_blank');
    expect(document.querySelectorAll('.related-document-card')).toHaveLength(2);
    const modernCopy = vi.fn().mockRejectedValue(new Error('clipboard permission denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText: modernCopy } }); vi.stubGlobal('isSecureContext', true);
    let copiedText = '';
    const legacyCopy = vi.fn(() => { copiedText = document.querySelector('textarea')?.value ?? ''; return true; });
    const originalCopy = Object.getOwnPropertyDescriptor(document, 'execCommand');
    Object.defineProperty(document, 'execCommand', { value: legacyCopy, configurable: true });
    try {
      await clickText('复制合集链接');
      expect(modernCopy).toHaveBeenCalledWith(new URL('/s/wp/one', window.location.origin).href);
      expect(legacyCopy).toHaveBeenCalledWith('copy');
      expect(copiedText).toBe(new URL('/s/wp/one', window.location.origin).href);
    } finally {
      if (originalCopy) Object.defineProperty(document, 'execCommand', originalCopy); else Reflect.deleteProperty(document, 'execCommand');
    }
    await clickText('查看全部 3 条链接');
    expect(getCollectionContextLinks).toHaveBeenCalledWith('a', 'collection:one', 1);
    expect(document.querySelector('[aria-label="所属合集"]')).toBeNull();
  });
  it('多个合集左侧切换，右侧读取对应文档，未分享合集也可选择', async () => {
    const contexts = [makeContext('one', 2), makeContext('two', 1), makeContext('unshared', 0)];
    vi.mocked(getCollectionContexts).mockResolvedValue({ success: true, data: { items: contexts, total: 3, totalContexts: 3, page: 1, pageSize: 20 }, error: null });
    vi.mocked(getCollectionContextDocuments).mockImplementation(async (_site, contextId) => ({ success: true, data: { ...data, canManage: false, items: [{ id: contextId, title: contextId, href: '/web-pages?openSite=' + contextId }] }, error: null }));
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" variant="badge" collectionNavigation />)); await open();
    expect(document.querySelector('[data-collection-layout="split"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="所属合集"] a')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('[aria-label="合集完整地址"]')?.value).toBe(window.location.origin + '/s/wp/one');
    await act(async () => document.querySelectorAll<HTMLButtonElement>('.collection-context-select')[1].click());
    expect(getCollectionContextDocuments).toHaveBeenLastCalledWith('a', 'collection:two');
    expect(document.querySelector('.related-document-card')?.textContent).toContain('collection:two');
    expect(document.querySelector<HTMLInputElement>('[aria-label="合集完整地址"]')?.value).toBe(window.location.origin + '/s/wp/two');
    expect(document.querySelector('[aria-label="合集链接操作"] a')?.getAttribute('href')).toBe(window.location.origin + '/s/wp/two');
    await act(async () => document.querySelectorAll<HTMLButtonElement>('.collection-context-select')[2].click());
    expect(document.querySelector<HTMLInputElement>('[aria-label="合集完整地址"]')?.value).toBe('');
    expect([...document.querySelectorAll<HTMLButtonElement>('.collection-context-link-actions button')].every(button => button.disabled)).toBe(true);
    expect(saveRelatedDocuments).not.toHaveBeenCalled();
  });
  it('底部切换同一合集的其他原链接，失效链接可复制但不能打开', async () => {
    const context = makeContext('one', 2);
    const inactive = { ...context.primaryLink!, id: 'revoked', shareUrl: '/s/wp/revoked', isActive: false, statusLabel: '已撤销' };
    vi.mocked(getCollectionContexts).mockResolvedValue({ success: true, data: { items: [context], total: 1, totalContexts: 1, page: 1, pageSize: 20 }, error: null });
    vi.mocked(getCollectionContextLinks).mockResolvedValue({ success: true, data: { items: [context.primaryLink!, inactive], total: 2, page: 1, pageSize: 20 }, error: null });
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" variant="badge" collectionNavigation />)); await open();
    await clickText('查看全部 2 条链接');
    await act(async () => document.querySelectorAll<HTMLButtonElement>('.collection-context-link-option')[1].click());
    const footer = document.querySelector<HTMLElement>('[aria-label="合集链接操作"]')!;
    expect(footer.querySelector<HTMLInputElement>('input')?.value).toBe(window.location.origin + '/s/wp/revoked');
    expect(footer.textContent).toContain('已撤销');
    expect(footer.querySelector('a')).toBeNull();
    expect([...footer.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '打开合集')?.disabled).toBe(true);
    expect([...footer.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '复制合集链接')?.disabled).toBe(false);
  });
  it('切换合集后不展示延迟返回的旧合集链接', async () => {
    const contexts = [makeContext('one', 2), makeContext('two', 1)];
    vi.mocked(getCollectionContexts).mockResolvedValue({ success: true, data: { items: contexts, total: 2, totalContexts: 2, page: 1, pageSize: 20 }, error: null });
    let resolve!: (value: Awaited<ReturnType<typeof getCollectionContextLinks>>) => void;
    vi.mocked(getCollectionContextLinks).mockReturnValue(new Promise(done => { resolve = done; }));
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" variant="badge" collectionNavigation />)); await open();
    await clickText('查看全部 2 条链接');
    await act(async () => document.querySelectorAll<HTMLButtonElement>('.collection-context-select')[1].click());
    await act(async () => resolve({ success: true, data: { items: [contexts[0].primaryLink!], total: 1, page: 1, pageSize: 20 }, error: null }));
    expect(document.querySelector<HTMLInputElement>('[aria-label="合集完整地址"]')?.value).toBe(window.location.origin + '/s/wp/two');
    expect(document.querySelector('.collection-context-link-options')).toBeNull();
  });
  it('合集搜索覆盖服务器全部记录，翻页稳定，筛成一项仍保留选择栏', async () => {
    vi.mocked(getCollectionContexts).mockImplementation(async (_site, page = 1, keyword = '') => ({ success: true, data: { items: keyword ? [makeContext('matched', 1)] : Array.from({ length: 20 }, (_, i) => makeContext(String((page - 1) * 20 + i), 1)), total: keyword ? 1 : 45, totalContexts: 45, page, pageSize: 20 }, error: null }));
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" variant="badge" collectionNavigation />)); await open();
    const nav = document.querySelector('[aria-label="合集分页"]')!;
    await act(async () => [...nav.querySelectorAll('button')].find(button => button.textContent === '下一页')!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(getCollectionContexts).toHaveBeenLastCalledWith('a', 2, '');
    const input = document.querySelector<HTMLInputElement>('[aria-label="搜索所属合集"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'matched'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(getCollectionContexts).toHaveBeenLastCalledWith('a', 1, 'matched');
    expect(document.querySelectorAll('.collection-context-select')).toHaveLength(1);
    expect(document.querySelector('[aria-label="所属合集"]')).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="清除合集搜索"]')!.click());
    expect(getCollectionContexts).toHaveBeenLastCalledWith('a', 1, '');
  });
  it('读取失败显示重试，不误判成没有合集，也不读取无关文档', async () => {
    vi.mocked(getCollectionContexts).mockResolvedValueOnce({ success: false, data: null as never, error: { code: 'FAILED', message: '合集暂时无法读取' } });
    await act(async () => root.render(<RelatedDocumentsBar siteId="a" variant="badge" collectionNavigation />)); await open();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('合集暂时无法读取');
    expect(getRelatedDocuments).not.toHaveBeenCalled();
    await clickText('重试');
    expect(document.querySelectorAll('.related-document-card')).toHaveLength(2);
  });

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
  it('权限同步含部分成功时通知列表重读实际权限，取消和失败不发布成功通知', async () => {
    const changed = vi.fn();
    window.addEventListener(HOSTED_SITE_PERMISSIONS_CHANGED, changed);
    try {
      await act(async () => root.render(<RelatedDocumentsBar siteId="a" />));
      await clickText('权限不一致'); await clickText('取消');
      expect(changed).not.toHaveBeenCalled();
      vi.mocked(syncRelatedPermissions).mockResolvedValueOnce({ success: false, data: null as never, error: { code: 'CONFLICT', message: '权限已变化' } });
      await clickText('权限不一致'); await clickText('应用统一权限');
      expect(changed).not.toHaveBeenCalled();
      vi.mocked(syncRelatedPermissions).mockResolvedValueOnce({ success: true, data: { results: [
        { id: 'b', title: '技术设计', success: true, message: '页面权限已同步' },
        { id: 'c', title: '测试方案', success: false, message: '已无权限' },
      ], sharesRevoked: 1 }, error: null });
      await clickText('应用统一权限');
      expect(changed).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain('技术设计：页面权限已同步');
      expect(document.body.textContent).toContain('测试方案：已无权限');
    } finally { window.removeEventListener(HOSTED_SITE_PERMISSIONS_CHANGED, changed); }
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
