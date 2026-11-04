import { expect, test } from '@playwright/test';

// 验证真实列表路由的生产组件；API 使用隔离测试数据，不操作用户站点。
for (const width of [390, 1440]) {
  for (const theme of ['light', 'dark'] as const) {
    for (const size of ['small', 'medium', 'large'] as const) {
      test(`托管真实列表 ${width}px ${theme} ${size} 统计对齐且不溢出`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 1000 });
        const date = new Date().toISOString();
        const titles = ['米多项目缺陷复发根因审查报告', '活动指南', '超长中文标题与LongUnbrokenEnglishTitle用于验证省略和新标记', '图书角'];
        const counts = [3, 0, 987654321, 0];
        const views = [8, 0, 987654321, 0];
        const cover = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="190"><rect width="360" height="190" fill="#e1e8ef"/></svg>');
        const sites = titles.map((title, i) => ({
          id: `layout-${i}`, title, sourceType: 'upload', cosPrefix: '', entryFile: 'index.html', siteUrl: '',
          files: Array.from({ length: i === 2 ? 3 : 1 }, (_, n) => ({ path: n ? `page-${n}.html` : 'index.html', cosKey: '', size: 1024, mimeType: 'text/html' })),
          coverImageUrl: cover, totalSize: [349901, 242278, 591872, 45056][i], tags: [], folderCanonicalName: '',
          ownerUserId: 'qa-layout-user', viewCount: views[i], visibility: 'private',
          description: i === 2 ? '用于检查长描述的底部统计是否和短描述对齐。'.repeat(5) : '测试描述',
          createdAt: date, updatedAt: date,
        }));
        const activity = Object.fromEntries(sites.map((site, i) => [site.id, { editCount: counts[i], isNew: i === 1 || i === 2 }]));
        await page.addInitScript(({ size }) => {
          localStorage.setItem('webpages.pref.cardSize', size);
          localStorage.setItem('webpages.pref.viewMode', 'grid');
          localStorage.setItem('webpages.pref.groupMode', 'time');
          localStorage.setItem('prd-admin-auth', JSON.stringify({ state: {
            isAuthenticated: true, user: { userId: 'qa-layout-user', username: 'qa-layout-user', displayName: '布局验收', role: 'ADMIN' },
            token: 'qa-layout-token', refreshToken: 'qa-layout-refresh', sessionKey: 'qa-layout-session',
            permissions: ['access', 'web-pages.read'], permissionsLoaded: true, isRoot: false,
            menuCatalog: [], menuCatalogLoaded: true, cdnBaseUrl: '', permFingerprint: 'qa-layout',
          }, version: 0 }));
        }, { size });
        await page.route('**/api/**', async route => {
          const path = new URL(route.request().url()).pathname;
          let data: unknown = { items: [], total: 0, folders: [], tags: [], teams: [] };
          if (path === '/api/web-pages') data = { items: sites, total: sites.length, activity,
            visitors: Object.fromEntries(sites.map((site, i) => [site.id, views[i]])) };
          else if (path === '/api/authz/me') data = { effectivePermissions: ['access', 'web-pages.read'], menuCatalog: [], isRoot: false };
          else if (path === '/api/web-pages/shares') data = { items: [0, 2].map(i => ({ id: `layout-share-${i}`, token: `layout-share-${i}`, siteId: sites[i].id,
            siteIds: [sites[i].id], shareType: 'single', createdAt: date, expiresAt: null, isRevoked: false, viewCount: 0 })) };
          else if (path === '/api/changelog/current-week') data = { weekStart: date, weekEnd: date, fetchedAt: date,
            dataSourceAvailable: true, source: 'local', totalDays: 0, totalEntries: 0, daysOffset: 0, hasMore: false, fragments: [] };
          await route.fulfill({ json: { success: true, data, error: null } });
        });
        await page.goto('/web-pages');
        const cards = page.locator('[data-tour-id="webpages-card"]');
        await expect(cards).toHaveCount(4);
        await expect(page.getByLabel('已编辑 987654321 次', { exact: true })).toBeAttached();
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.evaluate(() => document.fonts.ready);
        const metrics = await cards.evaluateAll(elements => elements.map(card => {
          const bounds = card.getBoundingClientRect();
          const stats = card.querySelector<HTMLElement>('[data-site-card-stats]')!;
          const statsBounds = stats.getBoundingClientRect();
          const editBounds = card.querySelector('[data-site-edit-badge]')?.getBoundingClientRect();
          const thumbBounds = card.querySelector('[data-site-card-thumbnail]')!.getBoundingClientRect();
          const sharedBounds = card.querySelector('[data-site-shared-badge]')?.getBoundingClientRect();
          const titleBounds = card.querySelector('h3')!.getBoundingClientRect();
          const badge = card.querySelector('[aria-label="新创建，尚未打开"]');
          const badgeBounds = badge?.getBoundingClientRect();
          const slots = Array.from(stats.children).map(child => child.getBoundingClientRect()).filter(rect => rect.height > 0);
          return {
            title: card.querySelector('h3')!.textContent, cardHeight: bounds.height,
            statsHeight: statsBounds.height,
            editInThumbnail: !editBounds || (editBounds.top >= thumbBounds.top && editBounds.bottom <= thumbBounds.bottom && editBounds.right <= thumbBounds.right),
            editBottom: editBounds ? thumbBounds.bottom - editBounds.bottom : null,
            editRight: editBounds ? thumbBounds.right - editBounds.right : null,
            shareGap: editBounds && sharedBounds ? editBounds.left - sharedBounds.right : null,
            metaFits: card.querySelector('[data-site-thumbnail-meta]')!.scrollWidth <= card.querySelector('[data-site-thumbnail-meta]')!.clientWidth,
            overflow: slots.some(rect => rect.left < bounds.left || rect.right > bounds.right),
            wrapped: slots.some(rect => rect.height > 16.5),
            badgeGap: badgeBounds ? badgeBounds.left - titleBounds.right : null,
            badgeInCard: !badgeBounds || badgeBounds.right <= bounds.right,
            titleLineHeight: card.querySelector('[data-site-card-title]')!.getBoundingClientRect().height,
          };
        }));
        for (const metric of metrics) {
          expect(metric.overflow, JSON.stringify(metric)).toBe(false);
          expect(metric.wrapped, JSON.stringify(metric)).toBe(false);
          expect(metric.statsHeight).toBeCloseTo(16, 0);
          expect(metric.editInThumbnail).toBe(true);
          expect(metric.metaFits, JSON.stringify(metric)).toBe(true);
          if (metric.editRight !== null) expect(metric.editRight).toBeCloseTo(8, 0);
          if (metric.editBottom !== null) expect(metric.editBottom).toBeGreaterThanOrEqual(8);
          if (metric.shareGap !== null) expect(metric.shareGap).toBeCloseTo(4, 0);
          expect(metric.badgeInCard).toBe(true);
          expect(metric.titleLineHeight).toBeCloseTo(20, 0);
          if (metric.badgeGap !== null) {
            expect(metric.badgeGap).toBeGreaterThanOrEqual(5);
            expect(metric.badgeGap).toBeLessThanOrEqual(7);
          }
        }
        await expect(cards.locator('[data-site-edit-badge]')).toHaveCount(2);
        await expect(page.getByLabel('已编辑 0 次', { exact: true })).toHaveCount(0);
        expect(Math.max(...metrics.map(m => m.cardHeight)) - Math.min(...metrics.map(m => m.cardHeight))).toBeLessThan(1);
        const shortTitle = cards.filter({ hasText: '活动指南' });
        await shortTitle.scrollIntoViewIfNeeded();
        const rightGap = await shortTitle.evaluate(card => card.getBoundingClientRect().right - card.querySelector('[aria-label="新创建，尚未打开"]')!.getBoundingClientRect().right);
        expect(rightGap).toBeGreaterThan(20);
        await expect(cards.first().locator('[data-site-shared-badge]')).toBeVisible();
        await expect(cards.locator('[title="我创建的"]')).toHaveCount(0);
        const editBadge = cards.first().locator('[data-site-edit-badge]');
        await editBadge.hover();
        await expect(editBadge).toBeVisible();
        // 鼠标真实命中徽标，不能被浮出的操作条盖住，否则悬浮说明不可达。
        await expect.poll(() => editBadge.evaluate(el => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        })).toBe(true);
        await expect(editBadge).toHaveAttribute('title', /成功发布 3 次内容修改/);
        await page.mouse.move(0, 0);
        const image = await cards.first().locator('..').screenshot();
        await testInfo.attach(`真实列表-${width}-${theme}-${size}`, { body: image, contentType: 'image/png' });
        await testInfo.attach('布局测量', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
      });
    }
  }
}
