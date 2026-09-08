import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { structuralSnapshot } from '@/lib/structuralSnapshot';
import { SiteCard } from '@/components/web-hosting/SiteCard';
import { SiteBatchPanel, SiteContextPanel, SiteSelectionPanel } from '@/components/web-hosting/SiteContextPanel';
import type { HostedSite, ShareLinkItem } from '@/services/real/webPages';
import type { SiteCaps } from '@/components/web-hosting/SiteCard';

/**
 * 热点组件的结构基线。
 *
 * 这些组件一改就同时影响好几屏，而改的人当场看不到影响面——只有验收甚至上线才发现某屏塌了。
 * 真实栽过的三次：hover 条以整条宽度接管指针把勾选框吞掉、卡片少了 h-full 高度不再一致、
 * 分享档整块摞到顶栏上面。三次都是「代码看着对、测试全绿、只有真人打开才看得见」。
 *
 * 基线只记**几何**（尺寸/弹性/定位/间距/溢出/对齐/可点可见）与契约属性，不记颜色圆角字号——
 * 记全了的话一次调色就是几十行 diff，人会开始无脑 -u，基线退化成会自动同意的橡皮图章。
 * 判据本身由 structuralSnapshot.test.ts 两头钉着（太宽太窄都有用例）。
 *
 * **看到 diff 怎么办**：先问「我这次是不是有意改布局」。
 *   是 → 跑 `pnpm vitest -u src/components/web-hosting/__snapshots__` 更新，
 *        并在 PR 里说明哪几屏会跟着变；
 *   否 → 你刚改坏了一处几何，diff 那几行就是现场。
 */

const site: HostedSite = {
  id: 'site-1',
  title: '多租户架构设计',
  description: '设计稿里的样例站点',
  sourceType: 'upload',
  cosPrefix: 'sites/site-1',
  entryFile: 'index.html',
  pdfAssetUrl: undefined,
  siteUrl: 'https://host.example/u/site-1/index.html',
  coverImageUrl: 'https://host.example/cover.png',
  files: [{ path: 'index.html', cosKey: 'sites/site-1/index.html', size: 11264, mimeType: 'text/html' }],
  totalSize: 11264,
  tags: ['架构'],
  folderCanonicalName: '',
  ownerUserId: 'user-1',
  viewCount: 9,
  visibility: 'private',
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
};

const caps: SiteCaps = { canEdit: true, canDelete: true, canShare: true, canSetVisibility: true };

const link: ShareLinkItem = {
  id: 'l1',
  token: 'NiJ22bUQOgM6',
  siteId: site.id,
  siteIds: [site.id],
  shareType: 'single',
  title: site.title,
  accessLevel: 'password',
  viewCount: 9,
  createdBy: 'user-1',
  createdAt: '2026-08-20T00:00:00.000Z',
  expiresAt: '2026-09-01T00:00:00.000Z',
  isRevoked: false,
  visibility: 'owner-only',
};

const noop = () => {};

/**
 * 时钟必须钉死。
 *
 * 卡片与右栏都渲染「更新于 N 小时前」，那是按 Date.now() 算的——不钉的话基线每过一小时
 * 就红一次。会因为无关变动变红的基线，很快就没人认真看了，下一次真的改坏几何时
 * 那行 diff 也会被顺手 -u 掉（这条不是假设：本文件第一版就是这么红的）。
 */
const FROZEN = new Date('2026-08-25T12:00:00.000Z');
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(FROZEN); });
afterAll(() => { vi.useRealTimers(); });

function snap(el: React.ReactElement) {
  return structuralSnapshot(renderToStaticMarkup(el));
}

describe('热点组件结构基线', () => {
  it('站点卡 · 中号', async () => {
    await expect(snap(
      <SiteCard
        site={site} size="medium" selected={false} shared caps={caps}
        shareStats={{ activeLinks: 1, lastViewedAt: '2026-08-25T10:00:00.000Z' }}
        onSelect={vi.fn()} onVisit={vi.fn()} onTogglePublic={vi.fn()} onEdit={vi.fn()}
        onDelete={vi.fn()} onShare={vi.fn()} onQrCode={vi.fn()} onTransferToLibrary={vi.fn()}
        onReplaceFile={vi.fn()}
      />,
    )).toMatchFileSnapshot('./site-card-medium.snap');
  });

  it('站点卡 · 小号（小号不渲染 hover 条，那条契约要在基线里看得见）', async () => {
    await expect(snap(
      <SiteCard
        site={site} size="small" selected={false} shared={false} caps={caps}
        onSelect={vi.fn()} onVisit={vi.fn()} onTogglePublic={vi.fn()} onEdit={vi.fn()}
        onDelete={vi.fn()} onShare={vi.fn()} onQrCode={vi.fn()} onTransferToLibrary={vi.fn()}
        onReplaceFile={vi.fn()}
      />,
    )).toMatchFileSnapshot('./site-card-small.snap');
  });

  it('右栏 · 选中一个站点', async () => {
    await expect(snap(
      <SiteSelectionPanel
        site={site} links={[link]} visitorCount={4}
        onGuestPreview={noop} onManageShares={noop} onCreateShare={noop} onClearSelection={noop}
      />,
    )).toMatchFileSnapshot('./rail-selection.snap');
  });

  it('右栏 · 选中一个站点但一条有效链接都没有（空态分支）', async () => {
    await expect(snap(
      <SiteSelectionPanel
        site={site} links={[]} onGuestPreview={noop} onManageShares={noop}
        onCreateShare={noop} onClearSelection={noop}
      />,
    )).toMatchFileSnapshot('./rail-selection-empty.snap');
  });

  it('右栏 · 批量', async () => {
    await expect(snap(
      <SiteBatchPanel
        count={3} canShare canDelete groupPicker={null}
        onBatchShare={noop} onBatchDelete={noop} onClearSelection={noop}
      />,
    )).toMatchFileSnapshot('./rail-batch.snap');
  });

  it('右栏 · 未选中（讲最近动过的那个站点）', async () => {
    await expect(snap(
      <SiteContextPanel
        site={site} links={[link]} visitorCount={4}
        pulse={[
          { key: 'new-sites', text: '本周新增 2 个站点', tone: 'success' },
          { key: 'new-links', text: '本周新建 4 条分享链接', tone: 'success' },
        ]}
        onCreateShare={noop} onManageShares={noop} onAnalytics={noop} onRenew={noop}
      />,
    )).toMatchFileSnapshot('./rail-context.snap');
  });

  it('右栏 · 一个站点都没有（空库）', async () => {
    await expect(snap(
      <SiteContextPanel
        site={null} links={[]} pulse={[]}
        onCreateShare={noop} onManageShares={noop} onAnalytics={noop} onRenew={noop}
      />,
    )).toMatchFileSnapshot('./rail-context-empty.snap');
  });
});
