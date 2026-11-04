import type { Page } from '@playwright/test';

/** 隔离的组件验收数据；全部 API 被截获，不创建真实 Key、不下载生产文件。 */
export async function installMarketplaceFixture(page: Page) {
  const titles = ['语雀操作技能', 'goal-pipeline-board', 'monthly-report', '健康检查 SKILL', 'html-ppt-skill',
    'document-expression-optimizer', 'findmapskills · 海鲜市场操作技能', 'pm-starter · 产品经理入门套装',
    'dev-starter · 开发入门套装', 'qa-starter · 测试与验收入门套装', 'acceptance-checklist · 真人验收清单',
    'conflict-resolution · Git 冲突解决'];
  const items = Array.from({ length: 24 }, (_, i) => ({
    id: `fixture-skill-${i}`, title: `${titles[i % titles.length]}${i >= titles.length ? ' · 进阶' : ''}`,
    description: '按仓库实际约定完成任务，支持检查、交付与结果验证。',
    version: '1.0.0', iconEmoji: '', coverImageUrl: null, previewUrl: null,
    ownerUserId: i % 3 === 0 ? 'official' : 'fixture-author', ownerUserName: i % 3 === 0 ? '官方' : '技能作者',
    tags: i % 2 === 0 ? ['工具', '开发'] : ['分析', '文档'],
    roles: i % 3 === 0 ? ['pm'] : ['dev'], forkCount: i, downloadCount: i, shareCount: 0,
    favoriteCount: 0, isFavoritedByCurrentUser: false, hasSkillMd: true,
    zipUrl: '', zipSizeBytes: 0, originalFileName: 'fixture.zip',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  }));
  await page.addInitScript(() => localStorage.setItem('prd-admin-auth', JSON.stringify({
    state: { isAuthenticated: true, user: { userId: 'fixture-viewer', username: 'fixture-viewer', role: 'ADMIN' },
      token: 'fixture-not-a-real-token', isRoot: true, permissions: ['access'], permissionsLoaded: true,
      menuCatalog: [], menuCatalogLoaded: true }, version: 0,
  })));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let data: unknown = { items: [], total: 0, tags: [], folders: [], teams: [] };
    if (url.pathname === '/api/authz/me') data = { userId: 'fixture-viewer', isRoot: true, effectivePermissions: ['access'], menuCatalog: [] };
    else if (url.pathname.includes('/changelog/')) data = { fragments: [], releases: [], items: [], dataSourceAvailable: false, hasMore: false };
    else if (url.pathname === '/api/official-skills/bundles') data = { roleLabels: { pm: '产品经理', dev: '开发', qa: '测试与验收' } };
    else if (url.pathname === '/api/marketplace/skills/tags') data = { tags: [{ tag: '工具', count: 12 }, { tag: '分析', count: 12 }] };
    else if (url.pathname === '/api/marketplace/skills') data = { items, total: items.length };
    else if (url.pathname === '/api/agent-api-keys') data = route.request().method() === 'POST'
      ? { apiKey: 'fixture-only-non-secret-key', item: {} }
      : { items: [], allowedScopes: ['marketplace.skills:read'] };
    else if (/\/favorite$/.test(url.pathname)) data = { item: { ...items[0], favoriteCount: 1, isFavoritedByCurrentUser: true } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data, error: null }) });
  });
  return items;
}
