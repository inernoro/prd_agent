// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CollectionReaderRelations } from './CollectionReaderRelations';
import { getRelatedDocuments } from '@/services/real/relatedDocuments';
import { getCollectionContexts } from '@/services/real/hostedCollections';

vi.mock('@/services/real/relatedDocuments', () => ({ getRelatedDocuments: vi.fn() }));
vi.mock('@/services/real/hostedCollections', () => ({ getCollectionContexts: vi.fn() }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('使用当前成员的原分享凭证，保留引用来源且不向访客读取作者合集', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(getRelatedDocuments).mockResolvedValue({ success: true, error: null, data: { version: 1, mainSiteId: 'main', canManage: false, hasPermissionDifferences: false, items: [
    { id: 'main', title: '同合集成员', isManual: true, href: '/s/wp/original?siteId=main' },
    { id: 'outside', title: '合集之外的手动文档', isManual: true, href: '/s/wp/original?siteId=outside' },
    { id: 'cited', title: '引用的文档', isManual: false, href: '/s/wp/original?siteId=cited', mentions: [{ commentId: 'comment', authorName: '作者', sourceSiteId: 'current', sourceTitle: '当前文档', label: '原评论的引用来源' }] },
  ] } });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container); const navigate = vi.fn();
  try {
    await act(async () => root.render(<CollectionReaderRelations siteId="current" token="original" password="original-password" scope={{ memberIds: ['main', 'current'] }} canViewCollections={false} onNavigate={navigate} />));
    expect(getRelatedDocuments).toHaveBeenCalledWith('current', { token: 'original', password: 'original-password' });
    expect(getCollectionContexts).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="也收录于"]')).toBeNull();
    expect(container.querySelector('[aria-label="手动关联"]')?.textContent).toContain('合集之外的手动文档');
    expect(container.querySelector('[aria-label="手动关联"]')?.textContent).not.toContain('同合集成员');
    expect(container.querySelector('[aria-label="评论引用"]')?.textContent).toContain('原评论的引用来源');
    await act(async () => container.querySelector<HTMLAnchorElement>('[aria-label="手动关联"] a')!.click());
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'outside', href: '/s/wp/original?siteId=outside' }));
  } finally { await act(async () => root.unmount()); container.remove(); }
});
