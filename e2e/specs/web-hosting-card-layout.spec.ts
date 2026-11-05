import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// 验证真实列表路由的生产组件；API 使用隔离测试数据，不操作用户站点。
for (const width of [390, 1440]) {
  for (const theme of ['light', 'dark'] as const) {
    for (const size of ['small', 'medium', 'large'] as const) {
      test(`托管真实列表 ${width}px ${theme} ${size} 统计对齐且不溢出`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 1000 });
        const date = new Date().toISOString();
        const tagNames = ['知识生成', 'opendesign-e4', 'HTML PPT', 'qa-webask-20261103', '验收', 'CDS', '每日验收-2026-09-06-网页托管-复测', '知识事实', 'LongUnbrokenTagNameForOverflowVerification', '归档', '设计', '研发', '周报'];
        const tagCounts = [64, 20, 6, 5, 4, 3, 3, 2, 123456, 2, 1, 1, 1];
        const titles = ['米多项目缺陷复发根因审查报告', '活动指南', '超长中文标题与LongUnbrokenEnglishTitle用于验证省略和新标记', '图书角'];
        const counts = [3, 0, 987654321, 0];
        const views = [8, 0, 987654321, 1];
        const cover = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="190"><rect width="360" height="190" fill="#e1e8ef"/></svg>');
        const sites = titles.map((title, i) => ({
          id: `layout-${i}`, title, sourceType: 'upload', cosPrefix: '', entryFile: 'index.html', siteUrl: '',
          files: Array.from({ length: i === 2 ? 103 : 1 }, (_, n) => ({ path: n ? `page-${n}.html` : 'index.html', cosKey: '', size: 1024, mimeType: 'text/html' })),
          coverImageUrl: cover, totalSize: [349901, 242278, 591872, 45056][i], tags: ['产品', '验收', '网页', '第四个标签'], folderCanonicalName: '',
          ownerUserId: 'qa-layout-user', viewCount: views[i], visibility: 'private',
          description: i === 2 ? '用于检查长描述的底部统计是否和短描述对齐。'.repeat(5) : '测试描述',
          createdAt: date, updatedAt: date,
        }));
        const traffic = Object.fromEntries(sites.map((site, i) => [site.id, {
          all: { visits: views[i], visitors: views[i], lastViewedAt: views[i] ? date : null },
          external: { visits: i === 2 ? 2 : 0, visitors: i === 2 ? 1 : 0, lastViewedAt: i === 2 ? date : null },
          activeShareLinks: i === 0 || i === 2 ? 1 : 0,
        }]));
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
          if (path === '/api/web-pages') data = { items: sites, total: sites.length, activity, traffic,
            visitors: Object.fromEntries(sites.map((site, i) => [site.id, views[i]])) };
          else if (path === '/api/web-pages/related-documents/summaries') data = { items: Object.fromEntries(sites.map((site, i) => [site.id, { count: 3, mainTitle: titles[0], isMain: i === 0, titles: titles.filter(title => title !== site.title) }])) };
          else if (path === '/api/web-pages/tags') data = { tags: tagNames.map((tag, index) => ({ tag, count: tagCounts[index] })) };
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
        await expect(cards.locator('.related-variant-badge')).toHaveCount(4);
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.evaluate(() => document.fonts.ready);
        const metrics = await cards.evaluateAll(elements => elements.map(card => {
          const bounds = card.getBoundingClientRect();
          const stats = card.querySelector<HTMLElement>('[data-site-card-stats]')!;
          const statsBounds = stats.getBoundingClientRect();
          const editBounds = card.querySelector('[data-site-edit-badge]')?.getBoundingClientRect();
          const thumbBounds = card.querySelector('[data-site-card-thumbnail]')!.getBoundingClientRect();
          const sharedBounds = card.querySelector('[data-site-shared-badge]')?.getBoundingClientRect();
          const selectBounds = card.querySelector('[data-site-select]')!.getBoundingClientRect();
          const meta = card.querySelector<HTMLElement>('[data-site-card-meta]')!;
          const columns = getComputedStyle(stats).gridTemplateColumns.split(/\s+/).length;
          const titleBounds = card.querySelector('h3')!.getBoundingClientRect();
          const badge = card.querySelector('[aria-label="新创建，尚未打开"]');
          const badgeBounds = badge?.getBoundingClientRect();
          const slots = Array.from(stats.children).map(child => child.getBoundingClientRect()).filter(rect => rect.height > 0);
          return {
            title: card.querySelector('h3')!.textContent, cardHeight: bounds.height,
            statsHeight: statsBounds.height, columns, metricCount: slots.length,
            editInFooter: !!editBounds && editBounds.top >= statsBounds.top && editBounds.bottom <= statsBounds.bottom && editBounds.top >= thumbBounds.bottom,
            shareInBody: !sharedBounds || sharedBounds.top >= thumbBounds.bottom,
            selectionAtTop: selectBounds.top <= thumbBounds.top + 2 && selectBounds.bottom <= thumbBounds.top + 44,
            noThumbnailStrip: !card.querySelector('[data-site-thumbnail-meta]'),
            metaFits: meta.scrollWidth <= meta.clientWidth,
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
          expect(metric.metricCount).toBe(4);
          expect(metric.statsHeight).toBeCloseTo(metric.columns === 4 ? 16 : 36, 0);
          expect(metric.editInFooter).toBe(true);
          expect(metric.shareInBody).toBe(true);
          expect(metric.selectionAtTop).toBe(true);
          expect(metric.noThumbnailStrip).toBe(true);
          expect(metric.metaFits, JSON.stringify(metric)).toBe(true);
          expect(metric.badgeInCard).toBe(true);
          expect(metric.titleLineHeight).toBeCloseTo(20, 0);
          if (metric.badgeGap !== null) {
            expect(metric.badgeGap).toBeGreaterThanOrEqual(5);
            expect(metric.badgeGap).toBeLessThanOrEqual(7);
          }
        }
        await expect(cards.locator('[data-site-edit-badge]')).toHaveCount(4);
        await expect(page.getByLabel('已编辑 0 次', { exact: true })).toHaveCount(2);
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
        // 三档都提供常驻按钮，详情不折叠、不省略；查看详情不是打开网页，不写访问记录。
        if (size === 'large') {
          const lastAccess = cards.nth(3).locator('[title^="最近访问"]');
          await expect(lastAccess).toContainText('刚刚');
          await expect(cards.nth(3).getByLabel('有效分享链接', { exact: true })).toContainText('0');
        }
        const visited: string[] = [];
        page.on('request', request => { if (request.url().includes('/record-view')) visited.push(request.url()); });
        const trigger = cards.nth(2).getByRole('button', { name: '查看网页详情' });
        await expect(cards.getByRole('button', { name: '查看网页详情' })).toHaveCount(4);
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: '网页详情' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('heading', { name: titles[2], exact: true })).toBeVisible();
        await expect(dialog.getByText(sites[2].description, { exact: true })).toBeVisible();
        await expect(dialog.getByText('第四个标签', { exact: true })).toBeVisible();
        for (const [label, value] of [['已发布的内容修改', '987654321 次'], ['原累计浏览', '987654321 次（旧口径）'], ['来源', '手动上传']]) {
          await expect(dialog.locator('dt').filter({ hasText: label }).locator('..').locator('dd')).toHaveText(value);
        }
        const allTraffic = dialog.getByRole('region', { name: '全部访问（含作者）', exact: true });
        const externalTraffic = dialog.getByRole('region', { name: '外部访问（不含已登录作者）', exact: true });
        await expect(allTraffic).toContainText('987654321 次');
        await expect(allTraffic).toContainText('987654321 位');
        await expect(externalTraffic).toContainText('2 次');
        await expect(externalTraffic).toContainText('1 位');
        await expect(dialog.getByText('创建时间', { exact: true })).toHaveCount(1);
        await expect(dialog.getByText('更新时间', { exact: true })).toHaveCount(1);
        await expect(dialog.locator('details, [aria-expanded="false"]')).toHaveCount(0);
        await expect(dialog.getByRole('region', { name: '完整文件列表' }).locator('li')).toHaveCount(103);
        expect(await dialog.evaluate(el => {
          const rect = el.getBoundingClientRect();
          const body = el.querySelector('.prd-dialog-body')!;
          return rect.top >= 0 && rect.bottom <= innerHeight && el.scrollWidth <= el.clientWidth && body.scrollWidth <= body.clientWidth && body.scrollHeight > body.clientHeight;
        })).toBe(true);
        await testInfo.attach(`完整详情-${width}-${theme}-${size}`, { body: await dialog.screenshot(), contentType: 'image/png' });
        await dialog.getByText('page-102.html', { exact: true }).scrollIntoViewIfNeeded();
        await expect(dialog.getByText('page-102.html', { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        expect(visited).toEqual([]);

        if (width === 1440 && size === 'small') {
          const rail = page.locator('[data-tour-id="webpages-library-rail"]');
          const tags = rail.getByRole('region', { name: '标签筛选' });
          await expect(tags.locator('.web-library-tags__item')).toHaveCount(8);
          await expect(tags.getByRole('button', { name: '更多标签 · 5' })).toBeVisible();
          const longName = tags.getByRole('button', { name: /每日验收-2026-09-06-网页托管-复测/ });
          await expect(longName).toHaveAttribute('title', '每日验收-2026-09-06-网页托管-复测 · 3 个网页');
          const checkRows = async () => {
            const rows = await tags.locator('.web-library-tags__item').evaluateAll(items => items.map(item => {
              const rect = item.getBoundingClientRect();
              const name = item.querySelector('.web-library-tags__name')!;
              const count = item.querySelector('.web-library-tags__count')!.getBoundingClientRect();
              return { height: rect.height, overflow: item.scrollWidth > item.clientWidth,
                countRight: count.right, nameRight: name.getBoundingClientRect().right, countLeft: count.left,
                nowrap: getComputedStyle(name).whiteSpace };
            }));
            for (const row of rows) {
              expect(row.height).toBe(28);
              expect(row.overflow).toBe(false);
              expect(row.nowrap).toBe('nowrap');
              expect(row.nameRight).toBeLessThanOrEqual(row.countLeft - 7);
              expect(row.countRight).toBeCloseTo(rows[0].countRight, 0);
            }
          };
          await checkRows();
          await testInfo.attach(`标签侧栏-${theme}`, { body: await rail.screenshot(), contentType: 'image/png' });
          await tags.getByRole('button', { name: '更多标签 · 5' }).click();
          await expect(tags.locator('.web-library-tags__item')).toHaveCount(13);
          await checkRows();
          const chosen = tags.getByRole('button', { name: /LongUnbrokenTagNameForOverflowVerification/ });
          const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/web-pages'
            && new URL(request.url()).searchParams.get('tag') === tagNames[8]);
          await chosen.click();
          await request;
          await expect(chosen).toHaveAttribute('aria-pressed', 'true');
          await tags.getByRole('button', { name: '收起标签' }).click();
          await expect(tags.locator('.web-library-tags__item')).toHaveCount(9);
          await expect(chosen).toBeVisible();
          await expect(tags.getByRole('button', { name: '更多标签 · 4' })).toHaveAttribute('aria-expanded', 'false');
          await testInfo.attach(`标签已选-${theme}`, { body: await rail.screenshot(), contentType: 'image/png' });
          await tags.getByRole('button', { name: '清除标签筛选' }).click();
          await expect(tags.locator('.web-library-tags__item')).toHaveCount(8);
          await expect(tags.locator('[aria-pressed="true"]')).toHaveCount(0);
          await longName.focus();
          await page.keyboard.press('Enter');
          await expect(longName).toHaveAttribute('aria-pressed', 'true');
          await page.keyboard.press('Enter');
          await expect(longName).toHaveAttribute('aria-pressed', 'false');
        }

      });
    }
  }
}

test('返回定位的分页外网页移到团队后，不会在个人空间恢复旧卡片', async ({ page }) => {
  const date = new Date().toISOString();
  const target = { id: 'return-target', title: '返回定位目标', sourceType: 'upload', ownerUserId: 'qa-return',
    siteUrl: '', cosPrefix: '', entryFile: 'index.html', files: [], totalSize: 42, tags: [], visibility: 'private',
    createdAt: date, updatedAt: date, sharedTeamIds: [] as string[] };
  let moved = false;
  await page.addInitScript(() => {
    localStorage.setItem('webpages.pref.cardSize', 'small');
    localStorage.setItem('prd-admin-auth', JSON.stringify({ state: {
      isAuthenticated: true, user: { userId: 'qa-return', username: 'qa-return', role: 'ADMIN' },
      token: 'qa-return-token', refreshToken: 'qa-return-refresh', sessionKey: 'qa-return-session',
      permissions: ['access', 'web-pages.read'], permissionsLoaded: true, isRoot: false,
      menuCatalog: [], menuCatalogLoaded: true, cdnBaseUrl: '', permFingerprint: 'qa-return',
    }, version: 0 }));
  });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = { items: [], total: 0, folders: [], tags: [], teams: [] };
    if (path === '/api/web-pages/return-target') data = target;
    else if (path === '/api/web-pages/return-target/teams') {
      expect(route.request().postDataJSON()).toEqual({ teamIds: ['target-team'] });
      target.sharedTeamIds = ['target-team']; moved = true;
    } else if (path === '/api/teams') data = { items: [{ team: { id: 'target-team', name: '目标团队' }, role: 'owner' }] };
    else if (path === '/api/authz/me') data = { effectivePermissions: ['access', 'web-pages.read'], menuCatalog: [], isRoot: false };
    else if (path === '/api/changelog/current-week') data = { weekStart: date, weekEnd: date, fetchedAt: date,
      dataSourceAvailable: true, source: 'local', totalDays: 0, totalEntries: 0, daysOffset: 0, hasMore: false, fragments: [] };
    await route.fulfill({ json: { success: true, data, error: null } });
  });
  await page.goto('/web-pages?focusSite=return-target');
  const card = page.locator('[data-hosted-site-id="return-target"]').first();
  await expect(card).toBeVisible();
  await expect(page).not.toHaveURL(/focusSite=/);
  await expect(card).toBeVisible();
  await card.hover();
  await card.getByRole('button', { name: '更多设置' }).click();
  await page.getByText('移动到空间或文件夹', { exact: true }).click();
  await page.getByRole('button', { name: '目标团队', exact: true }).click();
  await page.getByRole('button', { name: '移动', exact: true }).click();
  await expect.poll(() => moved).toBe(true);
  await expect(card).toHaveCount(0);
});

// 回归：关联点击只打开当前页模态窗，不能经过列表路由或丢失原阅读现场。
for (const mode of ['list', 'account-share', 'guest-share'] as const) {
  test(`关联文档当前页预览保留原背景：${mode}`, async ({ page }) => {
    const sites = ['source', 'target'].map(id => ({ id, title: id === 'source' ? '来源文档' : '关联目标',
      siteUrl: `https://hosting.example/${id}/index.html`, entryFile: 'index.html', contentShape: 'self-contained-html',
      ownerUserId: 'qa-related-user', sourceType: 'upload', files: [], tags: [], totalSize: 1024,
      cosPrefix: '', folderCanonicalName: '', createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z', askEnabled: false }));
    const apiRequests: string[] = [];
    const errors: string[] = [];
    // Playwright 的 serviceWorkers:block 在不透明沙箱 iframe 注入脚本会抛平台错误；仍记录所有应用错误。
    page.on('pageerror', error => {
      if (!error.message.includes("Service worker is disabled because the context is sandboxed")) errors.push(error.message);
    });
    if (mode !== 'guest-share') await page.addInitScript(() => {
      if (window.top !== window) return;
      localStorage.setItem('prd-admin-auth', JSON.stringify({
      state: { isAuthenticated: true, user: { userId: 'qa-related-user', username: 'qa-related-user', role: 'ADMIN' },
        token: 'qa-related-session', permissions: ['access', 'web-pages.read'], permissionsLoaded: true,
        isRoot: false, menuCatalog: [], menuCatalogLoaded: true }, version: 0,
    })); });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      apiRequests.push(path);
      if (path.endsWith('/annotation-runtime.js')) {
        await route.fulfill({ contentType: 'text/javascript', body: await readFile(
          new URL('../../prd-api/src/PrdAgent.Infrastructure/Services/Assets/hostedAnnotations.js', import.meta.url), 'utf8') });
        return;
      }
      let data: unknown = { items: [], folders: [], tags: [], teams: [], total: 0 };
      if (path === '/api/authz/me') data = { effectivePermissions: ['access', 'web-pages.read'], menuCatalog: [], isRoot: false };
      else if (path === '/api/changelog/current-week') data = { weekStart: sites[0].createdAt, weekEnd: sites[0].createdAt, fetchedAt: sites[0].createdAt, dataSourceAvailable: true, source: 'local', totalDays: 0, totalEntries: 0, daysOffset: 0, hasMore: false, fragments: [] };
      else if (path === '/api/web-pages') data = { items: sites, total: sites.length };
      else if (path === '/api/web-pages/related-documents/summaries') data = { items: { source: { count: 1, isMain: true, titles: ['关联目标'] } } };
      else if (path.endsWith('/related-documents')) data = { version: 1, mainSiteId: 'source', canManage: false,
        hasPermissionDifferences: false, items: sites.map(site => ({ ...site, isMain: site.id === 'source',
          preview: { ...site, useShareAccess: mode === 'guest-share' },
          href: mode === 'guest-share' ? `/s/wp/qa-related?siteId=${site.id}` : `/web-pages?openSite=${site.id}` })) };
      else if (path === '/api/web-pages/shares/view/qa-related') data = { title: '来源分享', shareType: 'collection', sites };
      else if (path.endsWith('/content')) {
        const id = url.searchParams.get('siteId') || path.split('/')[3];
        data = { siteId: id, siteUrl: `https://hosting.example/${id}/index.html`, contentType: 'text/html',
          html: `<!doctype html><h1>${id === 'source' ? '来源正文' : '目标正文'}</h1><input aria-label="保留输入"><div style="height:2000px"></div>` };
      } else if (path.endsWith('/revisions')) data = [];
      else if (path.endsWith('/comments')) data = { siteId: 'source', commentsEnabled: true, canComment: false, comments: [] };
      else if (path === '/api/web-pages/target') data = sites[1];
      await route.fulfill({ json: { success: true, data, error: null } });
    });
    await page.goto(mode === 'list' ? '/web-pages?keepFilter=1' : '/s/wp/qa-related?siteId=source');
    const originalUrl = page.url();
    let sourceFrame;
    if (mode === 'list') {
      await page.locator('[data-hosted-site-id="source"] .related-trigger').click();
    } else {
      sourceFrame = page.locator('iframe[title="来源文档"]').contentFrame();
      await sourceFrame.getByLabel('保留输入').fill('原页面状态');
      await sourceFrame.locator('body').evaluate(el => { el.ownerDocument.defaultView!.scrollTo(0, 200); });
      await page.locator('.share-topbar .related-trigger').click();
    }
    const listReads = apiRequests.filter(path => path === '/api/web-pages').length;
    await page.locator('.related-document-card').filter({ hasText: '关联目标' }).click();
    const modal = mode === 'guest-share' ? page.getByRole('dialog', { name: '关联文档预览', exact: true })
      : page.getByRole('dialog', { name: '关联目标', exact: true });
    await expect(modal).toBeVisible();
    await expect(modal.locator('iframe').first().contentFrame().getByRole('heading', { name: '目标正文' })).toBeVisible();
    expect(page.url()).toBe(originalUrl);
    expect(page.context().pages()).toHaveLength(1);
    expect(apiRequests.filter(path => path === '/api/web-pages')).toHaveLength(listReads);
    if (mode === 'guest-share') expect(apiRequests).not.toContain('/api/web-pages/target');
    // 原生和 Radix 阅读器都必须一次只关闭最上层，不丢失当前正文状态。
    await modal.locator('.related-trigger').click();
    await expect(page.getByRole('dialog', { name: '关联文档', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '关联文档', exact: true })).toHaveCount(0);
    await expect(modal).toBeVisible();
    await expect(modal.locator('.related-trigger')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    expect(page.url()).toBe(originalUrl);
    if (sourceFrame) {
      await expect(sourceFrame.getByLabel('保留输入')).toHaveValue('原页面状态');
      expect(await sourceFrame.locator('body').evaluate(el => el.ownerDocument.defaultView!.scrollY)).toBe(200);
    }
    expect(errors).toEqual([]);
  });
}
