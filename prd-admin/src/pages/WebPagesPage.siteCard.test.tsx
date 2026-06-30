import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SiteCard } from './WebPagesPage';
import type { HostedSite } from '@/services/real/webPages';
import type { SiteCaps } from './WebPagesPage';

const baseSite: HostedSite = {
  id: 'site-1',
  title: '分支发展图谱',
  description: '测试网页',
  sourceType: 'upload',
  cosPrefix: 'sites/site-1',
  entryFile: 'index.html',
  siteUrl: 'https://example.test/site-1',
  coverImageUrl: 'https://example.test/cover.png',
  files: [{ path: 'index.html', cosKey: 'sites/site-1/index.html', size: 1024, mimeType: 'text/html' }],
  totalSize: 1024,
  tags: [],
  ownerUserId: 'user-1',
  viewCount: 3,
  visibility: 'private',
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
};

const ownerCaps: SiteCaps = { canEdit: true, canDelete: true, canShare: true, canSetVisibility: true };

function renderSiteCard(site: HostedSite = baseSite, caps: SiteCaps = ownerCaps) {
  return renderToStaticMarkup(
    <SiteCard
      site={site}
      selected={false}
      shared={false}
      caps={caps}
      onSelect={vi.fn()}
      onTogglePublic={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onShare={vi.fn()}
      onQrCode={vi.fn()}
      onTransferToLibrary={vi.fn()}
      onReplaceFile={vi.fn()}
    />,
  );
}

describe('WebPagesPage SiteCard', () => {
  it('changes the private quick-public action into a visible share action', () => {
    const html = renderSiteCard();

    expect(html).not.toContain('设为公开');
    expect(html).not.toContain('>公开<');
    expect(html).toContain('>分享<');
    expect(html).toContain('aria-label="分享"');
    expect(html).toContain('aria-label="发布到公开页"');
  });

  it('shows the private share action for team editors without visibility permission', () => {
    const html = renderSiteCard(baseSite, {
      canEdit: true,
      canDelete: true,
      canShare: true,
      canSetVisibility: false,
    });

    expect(html).toContain('>分享<');
    expect(html).toContain('aria-label="分享"');
    expect(html).not.toContain('设为公开');
    expect(html).not.toContain('aria-label="发布到公开页"');
  });
});
