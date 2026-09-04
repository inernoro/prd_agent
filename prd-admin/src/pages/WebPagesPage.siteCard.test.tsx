import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SiteCard } from './WebPagesPage';
import type { HostedSite } from '@/services/real/webPages';
import { buildCardActionLayers, canDragSiteCard } from '@/components/web-hosting/SiteCard';
import type { SiteCaps, SiteCardSize, SiteShareStats } from '@/components/web-hosting/SiteCard';

const baseSite: HostedSite = {
  id: 'site-1',
  title: '分支发展图谱',
  description: '测试网页',
  sourceType: 'upload',
  cosPrefix: 'sites/site-1',
  entryFile: 'index.html',
  siteUrl: 'https://example.test/site-1',
  pdfAssetUrl: undefined,
  coverImageUrl: 'https://example.test/cover.png',
  files: [{ path: 'index.html', cosKey: 'sites/site-1/index.html', size: 1024, mimeType: 'text/html' }],
  totalSize: 1024,
  tags: [],
  folderCanonicalName: '',
  ownerUserId: 'user-1',
  viewCount: 3,
  visibility: 'private',
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
};

const ownerCaps: SiteCaps = { canEdit: true, canDelete: true, canShare: true, canSetVisibility: true };

function renderSiteCard(
  site: HostedSite = baseSite,
  caps: SiteCaps = ownerCaps,
  shared = false,
  size: SiteCardSize = 'medium',
  shareStats?: SiteShareStats,
  selected = false,
) {
  return renderToStaticMarkup(
    <SiteCard
      site={site}
      size={size}
      selected={selected}
      shared={shared}
      shareStats={shareStats}
      caps={caps}
      onSelect={vi.fn()}
      onVisit={vi.fn()}
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
  it('把高频操作放在常驻层，低频操作留在更多菜单', () => {
    const html = renderSiteCard();

    // 常驻：预览 + 分享 + 更多
    expect(html).toContain('aria-label="预览"');
    expect(html).toContain('aria-label="分享"');
    expect(html).toContain('aria-label="更多设置"');
    // 低频配置不常驻（它们在菜单里，菜单未展开时不渲染）
    expect(html).not.toContain('aria-label="发布到公开页"');
    expect(html).not.toContain('aria-label="转存到知识库"');
  });

  it('hover 层不显形时不可点', () => {
    const html = renderSiteCard();

    // 编辑/替换/二维码属于 hover 层：渲染了但不可点，hover 或键盘 focus 才展开
    expect(html).toContain('aria-label="编辑信息"');
    expect(html).toContain('pointer-events-none');
    // 容器**不能**在 hover 时整条变可点：它以整条宽度盖住左下角的批量勾选框，
    // 一旦接管指针，勾选框就看得见点不动（2026-08-25 实测，只有真实指针序列会红）。
    // 可点的只能是里面的按钮，它们自带 pointer-events-auto。
    expect(html).not.toContain('group-hover:pointer-events-auto');
    expect(html).toContain('pointer-events-auto inline-flex');
    // 键盘 focus 走同一条路：容器只负责显形（opacity/位移），可点性始终在按钮身上
    expect(html).not.toContain('group-focus-within:pointer-events-auto');
    expect(html).toContain('group-focus-within:opacity-100');
  });

  it('hover 层的每一项都必须在更多菜单里有等价入口（触屏与键盘可达）', () => {
    // 桌面 hover 条在 sm 断点以下不渲染，触屏用户只剩 kebab 这一条路。
    // 任何一项只挂在 hover 层、没进菜单，就是把触屏用户挡在门外。
    for (const caps of [
      ownerCaps,
      { canEdit: true, canDelete: false, canShare: true, canSetVisibility: false },
      { canEdit: false, canDelete: false, canShare: true, canSetVisibility: false },
    ] satisfies SiteCaps[]) {
      const { hover, menu } = buildCardActionLayers({
        site: baseSite,
        caps,
        onEdit: vi.fn(),
        onQrCode: vi.fn(),
        onTogglePublic: vi.fn(),
        onTransferToLibrary: vi.fn(),
        onDelete: vi.fn(),
      });
      const menuLabels = menu.map((a) => a.label);
      for (const a of hover) expect(menuLabels).toContain(a.label);
      // 且置顶：CardMoreButton 按 hover 条数画分隔线，顺序错位分隔线就画在错的地方
      expect(menuLabels.slice(0, hover.length)).toEqual(hover.map((a) => a.label));
    }
  });

  it('破坏性操作只在菜单里，不进 hover 层', () => {
    const { hover, menu } = buildCardActionLayers({
      site: baseSite,
      caps: ownerCaps,
      onEdit: vi.fn(),
      onQrCode: vi.fn(),
      onTogglePublic: vi.fn(),
      onTransferToLibrary: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(hover.some((a) => a.danger)).toBe(false);
    expect(menu.some((a) => a.danger && a.label === '删除')).toBe(true);
  });

  it('已分享时常驻按钮转为管理分享并带上有效链接条数', () => {
    const html = renderSiteCard(baseSite, ownerCaps, true, 'medium', { activeLinks: 2 });

    expect(html).toContain('aria-label="管理分享 · 2"');
    expect(html).toContain('已分享');
    expect(html).not.toContain('aria-label="分享"');
  });

  it('缩略图层只放「这是什么」，信息层只放「它现在怎么样」', () => {
    const html = renderSiteCard({ ...baseSite, visibility: 'public', sharedTeamIds: ['team-1'] }, ownerCaps, true, 'medium', {
      activeLinks: 3,
    });

    // 形态与来源（缩略图层两角）
    expect(html).toContain('HTML');
    expect(html).toContain('手动上传');
    // 状态（信息层一行，四种同时成立也不挤进缩略图角落）
    expect(html).toContain('已公开');
    expect(html).toContain('团队共享');
  });

  it('形态角标只在有真实数据时出现', () => {
    // 单页 HTML：有「单页」角标
    expect(renderSiteCard()).toContain('单页');

    // 视频包装站：前端拿不到时长，不编一个空角标
    const video = renderSiteCard({ ...baseSite, wrappedAssetType: 'video', coverImageUrl: undefined });
    expect(video).toContain('视频');
    expect(video).not.toContain('单页');

    // ZIP 站：角标是真实文件数
    const zip = renderSiteCard({
      ...baseSite,
      coverImageUrl: undefined,
      files: [
        { path: 'index.html', cosKey: 'k1', size: 1, mimeType: 'text/html' },
        { path: 'a.js', cosKey: 'k2', size: 1, mimeType: 'text/javascript' },
      ],
    });
    expect(zip).toContain('ZIP 站');
    expect(zip).toContain('2 文件');
  });

  it('小卡保留分享状态与操作入口', () => {
    const html = renderSiteCard(baseSite, ownerCaps, true, 'small', { activeLinks: 1 });

    // 小卡放不下常驻按钮条，但 kebab 必须在，否则小卡视图下无法操作
    expect(html).toContain('aria-label="更多设置"');
    // 分享状态：小卡是「绿点 + 已分享」独占一行（设计稿屏 2 小卡形态），
    // 条数收进 title——不能因为卡片小就把这个状态整个丢掉
    expect(html).toContain('已分享');
    expect(html).toContain('已分享 1 条链接');
  });

  it('小卡的 kebab 压在缩略图上，不在正文里占一行（下巴）', () => {
    const html = renderSiteCard(baseSite, ownerCaps, true, 'small', { activeLinks: 1 });

    const infoLayerAt = html.indexOf('flex flex-1 flex-col');
    const kebabAt = html.indexOf('aria-label="更多设置"');
    expect(infoLayerAt).toBeGreaterThanOrEqual(0);
    expect(kebabAt).toBeGreaterThanOrEqual(0);

    // 信息层是卡片的最后一段，所以「kebab 在信息层之前」等价于「kebab 不是正文的流内子节点」。
    // 一旦有人把它挪回正文（哪怕仍然是 opacity-0），它就会永久占掉 28px 一行、
    // 在每张小卡正文底下留一截空白——这条断言当场变红。
    expect(kebabAt).toBeLessThan(infoLayerAt);

    // 平时透明、hover / focus 才显形；触屏没有 hover，必须常显，
    // 否则小卡（不渲染 hover 条）在触屏上一个操作入口都没有。
    expect(html).toContain('[@media(hover:none)]:opacity-100');
  });

  it('选中态只有一个圆角矩形，不套第二个轮廓', () => {
    const html = renderSiteCard(baseSite, ownerCaps, false, 'small', undefined, true);

    // 曾经：根节点 outline(2px, 半径 20, offset 3) + 内框 accent 边框(半径 10)，
    // 两个不同半径的硬轮廓套在一起 = 用户看到的「两条线」。
    expect(html).not.toContain('outline:');

    // 半径必须处处一致：`.site-card-fresh::before` 的光环走 border-radius:inherit，
    // 根节点与内框不同半径时，那圈光环也会错开。
    const radii = [...html.matchAll(/border-radius:\s*([0-9]+)px/g)].map((m) => m[1]);
    expect(radii.length).toBeGreaterThanOrEqual(2);
    expect(new Set(radii).size).toBe(1);
  });

  it('大卡的成果数据不把体积当 KPI', () => {
    const html = renderSiteCard(baseSite, ownerCaps, true, 'large', { activeLinks: 2, lastViewedAt: baseSite.updatedAt });

    expect(html).toContain('有效链接');
    expect(html).toContain('最近访问');
    // 体积只出现在元信息行（1.0 KB），不作为 KPI 标签
    expect(html).not.toContain('>体积<');
  });

  it('团队 viewer 无编辑权时不出现编辑与替换入口', () => {
    const html = renderSiteCard(baseSite, { canEdit: false, canDelete: false, canShare: true, canSetVisibility: false });

    expect(html).toContain('aria-label="分享"');
    expect(html).not.toContain('aria-label="编辑信息"');
    expect(html).not.toContain('aria-label="替换内容"');
  });

  it('团队 viewer 不能拖动别人的站点触发错误投放高亮', () => {
    const viewerCaps = { canEdit: false, canDelete: false, canShare: false, canSetVisibility: false };
    const html = renderSiteCard(baseSite, viewerCaps);

    expect(canDragSiteCard(viewerCaps)).toBe(false);
    expect(html).toContain('data-dock-draggable="false"');
    expect(html).toContain('cursor-default');
    expect(html).not.toContain('cursor-grab');
  });
});
