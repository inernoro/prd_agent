import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// 布局与阅读回归使用静止背景；动态画布单独由三档演示用例验证。
test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });

test('右侧快捷上传直接提交 ZIP，普通上传仍可搜索并指定首页', async ({ page }) => {
  const { ZipWriter, TextReader, Uint8ArrayWriter } = createRequire(new URL('../../prd-admin/package.json', import.meta.url))('@zip.js/zip.js');
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await zip.add('bundle/report.md', new TextReader('# Report'));
  await zip.add('bundle/manifest.json', new TextReader('{}'));
  await zip.add('bundle/run.sh', new TextReader('echo sample'));
  const longPath = `bundle/checkpoints/${'a'.repeat(112)}.json`;
  await zip.add(longPath, new TextReader('{}'));
  for (let index = 0; index < 8; index++) {
    await zip.add(`bundle/checkpoints/result-${index}.json`, new TextReader('{}'));
  }
  const buffer = Buffer.from(await zip.close());
  // Simulate a legacy ZIP with backslashes in both its local header and its central directory.
  const pathWithSlash = 'bundle/manifest.json';
  for (let index = buffer.indexOf(pathWithSlash); index !== -1; index = buffer.indexOf(pathWithSlash, index + pathWithSlash.length)) {
    buffer.write('bundle\\manifest.json', index);
  }
  let uploadBody: string | null = null;
  let resumeRequests = 0;
  let finishResume!: () => void;
  const resumeResponse = new Promise<void>(resolve => { finishResume = resolve; });
  const manualSite = { id: 'manual', title: 'scan', entryFile: 'map-file.html', visibility: 'private', files: [] };
  await page.addInitScript(() => {
    localStorage.setItem('prd-admin-auth', JSON.stringify({ state: {
      isAuthenticated: true, user: { userId: 'zip-qa', username: 'zip-qa', role: 'ADMIN' },
      token: 'zip-qa-session', permissions: ['access', 'web-pages.read'], permissionsLoaded: true,
      menuCatalog: [], menuCatalogLoaded: true,
    }, version: 0 }));
    sessionStorage.setItem('web-pages:pending-optimization-session', JSON.stringify({ sessionId: 'previous-upload' }));
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    let data: unknown = { items: [], total: 0, folders: [], tags: [], teams: [] };
    if (pathname === '/api/authz/me') data = { effectivePermissions: ['access', 'web-pages.read'], menuCatalog: [], isRoot: false };
    if (pathname === '/api/web-pages/upload' && request.method() === 'POST') {
      uploadBody = request.postData();
      data = { id: 'published', title: 'scan', entryFile: 'map-directory.html', visibility: 'private' };
    }
    const optimization = '/api/web-pages/optimization/uploads';
    if (pathname === `${optimization}/previous-upload`) {
      resumeRequests++;
      await resumeResponse;
      await route.fulfill({ status: 404, json: { success: false, data: null, error: { code: 'NOT_FOUND' } } });
      return;
    }
    if (pathname === optimization && request.method() === 'POST')
      data = { sessionId: 'zip-qa', chunkSize: buffer.length, totalChunks: 1 };
    if (pathname === `${optimization}/zip-qa`)
      data = { status: 'saved', review: { outcome: 'saved', site: manualSite } };
    await route.fulfill({ json: { success: true, data, error: null } });
  });
  await page.goto('/web-pages');
  await page.getByRole('button', { name: '展开投放面板' }).click();
  const dock = page.locator('[data-tour-id="share-dock-panel"]');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'), dock.getByRole('button', { name: '点击或拖文件到此上传' }).click(),
  ]);
  await chooser.setFiles({ name: 'scan.zip', mimeType: 'application/zip', buffer });
  await expect(dock.getByRole('button', { name: '无密码分享' })).toBeVisible();
  await expect(dock.getByRole('combobox', { name: '打开站点时' })).toHaveCount(0);
  expect(uploadBody).toContain('filename="scan.zip"');
  expect(uploadBody).not.toMatch(/name="(?:entryFile|openAsDirectory)"/);

  await dock.getByRole('button', { name: '收起投放面板' }).click();
  await page.getByRole('button', { name: '上传网页', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上传站点' });
  const fileInput = dialog.locator('input[type="file"]');
  try {
    await expect.poll(() => resumeRequests).toBe(1);
    await expect(page.getByText('正在恢复上次文件检查', { exact: true })).toBeVisible();
    await expect(fileInput).toHaveCount(0);
  } finally {
    finishResume();
  }
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles({ name: 'scan.zip', mimeType: 'application/zip', buffer });
  const mode = dialog.getByRole('combobox', { name: '打开站点时' });
  await expect(mode).toHaveValue('auto');
  await expect(mode.locator('option')).toHaveText(['系统查找', '文件目录', '手动选择']);
  const files = dialog.getByRole('group', { name: '选择首页文件' });
  await expect(files).toHaveCount(0);
  await mode.selectOption('directory');
  await expect(files).toHaveCount(0);
  await mode.selectOption('manual');
  const list = files.getByRole('list', { name: 'ZIP 文件列表' });
  await expect(list.getByRole('radio')).toHaveCount(11);
  await expect(list.getByRole('radio', { name: 'run.sh' })).toHaveCount(0);
  await page.setViewportSize({ width: 1024, height: 500 });
  expect(await list.getByText(longPath.replace('bundle/', ''), { exact: true }).evaluate(node =>
    node.clientHeight > 18 && node.scrollWidth === node.clientWidth)).toBe(true);
  const submit = dialog.getByRole('button', { name: '开始上传' });
  await expect(submit).toBeDisabled();
  const search = files.getByRole('searchbox', { name: '搜索文件名或路径' });
  await search.fill('manifest');
  await expect(list.getByRole('radio')).toHaveCount(1);
  await list.getByRole('radio', { name: 'manifest.json' }).check();
  await search.fill('report');
  await expect(files.getByText('已选 manifest.json')).toBeVisible();
  const request = page.waitForRequest(req => new URL(req.url()).pathname === '/api/web-pages/optimization/uploads'
    && req.method() === 'POST');
  await submit.click();
  const payload = (await request).postDataJSON();
  expect(payload).toMatchObject({ entryIndex: 1 });
  expect(payload).not.toHaveProperty('entryFile');
  await expect(page.getByRole('dialog', { name: '上传完成' })).toBeVisible();
  expect(resumeRequests).toBe(1);
});

test('合集切换到较早版本成员时不复制上一成员的预览地址', async ({ page }) => {
  const sites = ['a', 'b'].map((id, index) => ({ id, title: `来源文档 ${id}`, siteUrl: `https://hosting.example/${id}/${id}.html?v=${index ? '10000' : '20000'}`,
    entryFile: `${id}.html`, contentShape: 'self-contained-html', totalSize: 1024, entrySize: 1024, fileCount: 1 }));
  const versions: string[] = [];
  let holdShare = false, release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('https://hosting.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>原文</h1>' }));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.endsWith('/annotation-runtime.js')) {
      await route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../../prd-api/src/PrdAgent.Infrastructure/Services/Assets/hostedAnnotations.js', import.meta.url), 'utf8') }); return;
    }
    let data: unknown = { items: [], total: 0 };
    if (path === '/api/web-pages/shares/view/provenance-token') {
      if (holdShare) await waiting;
      data = { title: '版本来源合集', shareType: 'collection', createdBy: 'author', createdAt: '2026-11-15T00:00:00Z', sites };
    } else if (path.endsWith('/revisions')) {
      const site = sites.find(item => item.id === url.searchParams.get('siteId'))!;
      versions.push(site.id);
      data = [{ id: `${site.id}-current`, siteId: site.id, versionLabel: 'V1', contentVersionKey: site.id === 'a' ? '20000' : '10000',
        isCurrent: true, canPreview: true, siteUrl: site.siteUrl, entryFile: site.entryFile, contentShape: site.contentShape }];
    } else if (path.endsWith('/comments')) data = { comments: [], commentsEnabled: true, canComment: false };
    else if (path.endsWith('/html') || path.endsWith('/content')) data = { html: '<!doctype html><html><head></head><body><h1>原文</h1></body></html>', contentType: 'text/html' };
    await route.fulfill({ json: { success: true, data, error: null } });
  });
  try {
    await page.goto('/s/wp/provenance-token?siteId=a');
    await expect.poll(() => versions.includes('a')).toBe(true);
    await expect(page.locator('iframe[title="来源文档 a"]')).toBeVisible();
    await expect(page.getByRole('button', { name: '网页版本：V1', exact: true })).toBeVisible();
    holdShare = true;
    await page.evaluate(() => { history.pushState(null, '', '/s/wp/provenance-token?siteId=b'); dispatchEvent(new PopStateEvent('popstate')); });
    await expect.poll(() => versions.includes('b')).toBe(true);
    const frame = page.locator('iframe[title="来源文档 b"]');
    await expect(frame).toBeVisible();
    await expect.poll(() => frame.evaluate(element => element.getAttribute('srcdoc') || element.getAttribute('src') || '')).toContain('hosting.example/b/');
  } finally { release(); }
});

for (const action of ['管理合集', '分享']) {
  test(`章节分享旧阅读地址的${action}进入原章节入口`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('prd-admin-auth', JSON.stringify({ state: {
      isAuthenticated: true, user: { userId: 'chapter-owner', username: 'chapter-owner', displayName: '章节验收', role: 'ADMIN' },
      token: 'chapter-test-token', refreshToken: 'chapter-test-refresh', sessionKey: 'chapter-test-session',
      permissions: ['access', 'web-pages.read'], permissionsLoaded: true, isRoot: false,
      menuCatalog: [], menuCatalogLoaded: true, cdnBaseUrl: '', permFingerprint: 'chapter-test',
    }, version: 0 })));
    const calls: string[] = [];
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      calls.push(`${request.method()} ${path}`);
      let data: unknown = { items: [], total: 0 };
      if (path === '/api/web-pages/shares/view/chapter-token') data = {
        title: '章节分享验收', shareType: 'collection', documentCollectionId: 'chapters', createdBy: 'chapter-owner', createdAt: '2026-11-15T00:00:00Z',
        sites: [{ id: 'chapter-member', title: '章节成员', siteUrl: '', files: [], totalSize: 0 }],
      };
      else if (path.startsWith('/api/web-pages/collections/')) { await route.abort(); return; }
      else if (path.endsWith('/comments')) data = { comments: [], commentsEnabled: true, canComment: false };
      await route.fulfill({ json: { success: true, data, error: null } });
    });
    await page.goto('/s/wp/chapter-token');
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/web-pages/collections/chapters${action === '分享' ? '/share' : ''}$`));
    expect(calls.some(call => call.includes('/collections/compat/'))).toBe(false);
    expect(calls.some(call => !call.startsWith('GET '))).toBe(false);
  });
}

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
          else if (path === '/api/web-pages/related-documents/summaries') data = { items: Object.fromEntries(sites.map((site, i) => [site.id, { count: i === 3 ? 0 : 3, mainTitle: i === 3 ? undefined : titles[0], isMain: i === 0, titles: i === 3 ? [] : titles.filter(title => title !== site.title) }])) };
          else if (path === '/api/web-pages/layout-3/collection-contexts') data = { items: [], total: 0, totalContexts: 0, page: 1, pageSize: 20 };
          else if (path === '/api/web-pages/layout-3/related-documents') data = { items: [sites[3]], canManage: true, version: 0 };
          else if (path === '/api/web-pages/tags') data = { tags: tagNames.map((tag, index) => ({ tag, count: tagCounts[index] })) };
          else if (path === '/api/authz/me') data = { effectivePermissions: ['access', 'web-pages.read'], menuCatalog: [], isRoot: false };
          else if (path === '/api/web-pages/shares') data = { items: [...[0, 2].map(i => ({ id: `layout-share-${i}`, token: `layout-share-${i}`, siteId: sites[i].id,
            siteIds: [sites[i].id], shareType: 'single', createdAt: date, expiresAt: null, isRevoked: false, viewCount: 0 })),
              { id: 'expired', token: 'expired', siteId: sites[1].id, siteIds: [sites[1].id], shareType: 'single',
                createdAt: date, expiresAt: new Date(Date.now() - 60_000).toISOString(), isRevoked: false, viewCount: 0 },
              { id: 'single-member-collection', token: 'single-member-collection', siteId: sites[3].id, siteIds: [sites[3].id], shareType: 'collection',
                createdAt: date, expiresAt: null, isRevoked: false, viewCount: 0 },
            ] };
          else if (path === '/api/changelog/current-week') data = { weekStart: date, weekEnd: date, fetchedAt: date,
            dataSourceAvailable: true, source: 'local', totalDays: 0, totalEntries: 0, daysOffset: 0, hasMore: false, fragments: [] };
          await route.fulfill({ json: { success: true, data, error: null } });
        });
        await page.goto('/web-pages');
        const cards = page.locator('[data-tour-id="webpages-card"]');
        await expect(cards).toHaveCount(4);
        await expect(page.getByLabel('已编辑 987654321 次', { exact: true })).toBeAttached();
        await expect(cards.locator('.related-trigger')).toHaveCount(3);
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await page.evaluate(() => document.fonts.ready);
        const unlinkedCard = cards.nth(3);
        await expect(cards.nth(0).locator('[data-site-shared-badge]')).toHaveCount(1);
        await expect(cards.nth(1).locator('[data-site-shared-badge]')).toHaveCount(0);
        await expect(unlinkedCard.locator('[data-site-shared-badge]')).toHaveCount(0);
        await expect(unlinkedCard.locator('.related-trigger')).toHaveCount(0);
        await unlinkedCard.hover();
        await expect(unlinkedCard.locator('.related-trigger')).toHaveCount(0);
        await unlinkedCard.getByRole('button', { name: '更多设置', exact: true }).filter({ visible: true }).last().click();
        await page.getByRole('menuitem', { name: '合集', exact: true }).click();
        const relations = page.getByRole('dialog', { name: '合集', exact: true });
        await expect(relations.getByText('这份文档尚未加入合集。')).toBeVisible();
        await relations.getByRole('button', { name: '创建合集', exact: true }).click();
        const manager = page.getByRole('dialog', { name: '创建合集', exact: true });
        await expect(manager).toBeVisible();
        await manager.getByRole('button', { name: '关闭', exact: true }).last().click();
        await page.mouse.move(0, 0);
        await expect(unlinkedCard.locator('.related-trigger')).toHaveCount(0);
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
            title: card.querySelector('h3')!.textContent, cardTop: bounds.top, cardWidth: bounds.width, cardHeight: bounds.height, metaTop: meta.getBoundingClientRect().top - bounds.top,
            statsHeight: statsBounds.height, columns, metricCount: slots.length,
            editInFooter: !!editBounds && editBounds.top >= statsBounds.top && editBounds.bottom <= statsBounds.bottom && editBounds.top >= thumbBounds.bottom,
            shareInThumbnail: !sharedBounds || sharedBounds.bottom <= thumbBounds.bottom,
            selectionAtTop: selectBounds.top <= thumbBounds.top + 8 && selectBounds.bottom <= thumbBounds.top + 44,
            noThumbnailStrip: !card.querySelector('[data-site-thumbnail-meta]'),
            metaFits: meta.scrollWidth <= meta.clientWidth,
            overflow: slots.some(rect => rect.left < bounds.left || rect.right > bounds.right),
            wrapped: slots.some(rect => rect.height > 16.5),
            badgeGap: badgeBounds ? badgeBounds.left - titleBounds.right : null,
            badgeInCard: !badgeBounds || badgeBounds.right <= bounds.right,
            titleLineHeight: card.querySelector('[data-site-card-title]')!.getBoundingClientRect().height,
            statsRightGap: meta.getBoundingClientRect().right - slots[slots.length - 1].right,
          };
        }));
        for (const metric of metrics) {
          if (width === 1440) expect(metric.cardWidth, JSON.stringify(metric)).toBe(({ small: 176, medium: 264, large: 360 })[size]);
          expect(metric.overflow, JSON.stringify(metric)).toBe(false);
          expect(metric.wrapped, JSON.stringify(metric)).toBe(false);
          expect(metric.metricCount).toBe(3);
          expect(Math.abs(metric.statsRightGap)).toBeLessThan(1);
          expect(metric.statsHeight).toBeCloseTo(16, 0);
          expect(metric.editInFooter).toBe(true);
          expect(metric.shareInThumbnail).toBe(true);
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
        // 与 Demo 一样按自身内容定高，不为同行长描述或选中边框补空白；统计相对位置保持一致。
        expect(Math.max(...metrics.map(metric => metric.metaTop)) - Math.min(...metrics.map(metric => metric.metaTop))).toBeLessThan(1);
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
        await expect(dialog.getByRole('tab', { name: '基本信息', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(dialog.getByRole('region', { name: '完整文件列表' })).toHaveCount(0);
        await expect(dialog).toHaveCSS('max-width', '840px');
        await expect.poll(async () => (await dialog.boundingBox())!.width).toBeCloseTo(Math.min(840, width * 0.92), 1);
        expect(await dialog.evaluate(el => ({
          bodyFont: getComputedStyle(el.querySelector('[data-site-details]')!).fontSize,
          titleFont: getComputedStyle(el.querySelector('[data-site-details] h2')!).fontSize,
          columns: getComputedStyle(el.querySelector('[data-site-details-columns]')!).gridTemplateColumns.split(/\s+/).length,
        }))).toMatchObject({ bodyFont: '12px', titleFont: '14px', columns: width >= 768 ? 2 : 1 });
        if (width >= 768) {
          const rows = dialog.locator('dt').filter({ hasText: /^(已发布的内容修改|创建时间|更新时间|最近访问)$/ }).locator('..');
          expect(await rows.evaluateAll(items => items.every(row => Array.from(row.children).every(cell => {
            return cell.getBoundingClientRect().height <= parseFloat(getComputedStyle(cell).lineHeight) + 1;
          })))).toBe(true);
        }
        await dialog.getByRole('tab', { name: '文件 · 103', exact: true }).click();
        await expect(dialog.getByRole('region', { name: '完整文件列表' }).locator('li')).toHaveCount(103);
        await expect(allTraffic).toContainText('987654321 次');
        await expect(externalTraffic).toContainText('2 次');
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
    await page.setViewportSize({ width: 1440, height: 900 });
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
    await page.context().route('**/api/**', async route => {
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
      else if (path.endsWith('/collection-contexts')) data = { items: [], total: 0, totalContexts: 0, page: 1, pageSize: 20 };
      else if (path.endsWith('/related-documents')) data = { version: 1, mainSiteId: 'source', canManage: false,
        hasPermissionDifferences: false, items: sites.map(site => ({ ...site, isMain: site.id === 'source',
          // 访客通过合集快照读取成员；评论引用仍附在该成员上。
          isManual: true,
          mentions: mode === 'guest-share' && site.id === 'target' ? [{ commentId: 'source-comment', authorName: '引用者', sourceSiteId: 'source', sourceTitle: '来源文档', label: '来源文档中的评论引用' }] : [],
          preview: { ...site, useShareAccess: mode === 'guest-share' },
          href: mode === 'guest-share' ? `/s/wp/qa-related?siteId=${site.id}` : `/web-pages?openSite=${site.id}` })) };
      else if (path === '/api/web-pages/share') data = { token: 'qa-visit', shareUrl: '/s/wp/qa-visit' };
      else if (path === '/api/web-pages/shares/view/qa-visit') data = { title: '关联目标', shareType: 'single', sites: [sites[1]] };
      else if (path === '/api/web-pages/shares/view/qa-related') data = { title: '来源分享', shareType: 'collection', sites: mode === 'account-share' ? [sites[0]] : sites };
      else if (path.endsWith('/content')) {
        const id = url.searchParams.get('siteId') || path.split('/')[3];
        data = { siteId: id, siteUrl: `https://hosting.example/${id}/index.html`, contentType: 'text/html',
          html: `<!doctype html><h1>${id === 'source' ? '来源正文' : '目标正文'}</h1><input aria-label="保留输入"><div style="height:2000px"></div>` };
      } else if (path.endsWith('/revisions')) data = path.includes('/target/') || path.includes('/qa-visit/')
        ? [{ id: 'target-v1', siteId: 'target', versionLabel: 'V1', contentVersionKey: '2026-11-05', isCurrent: true,
          canPreview: true, siteUrl: sites[1].siteUrl, entryFile: 'index.html', contentShape: 'self-contained-html' }] : [];
      else if (path.endsWith('/comments')) data = { commentsEnabled: true, canComment: false,
        comments: path.includes('/target/') || path.includes('/qa-visit/') ? [{ id: 'target-comment', siteId: 'target', contentVersion: '2026-11-05',
          content: '预览文档已有评论', authorUserId: 'reviewer', authorName: '审阅者', createdAt: sites[0].createdAt, canDelete: false }] : [] };
      else if (path === '/api/web-pages/target') data = sites[1];
      await route.fulfill({ json: { success: true, data, error: null } });
    });
    await page.goto(mode === 'list' ? '/web-pages?keepFilter=1' : '/s/wp/qa-related');
    if (mode !== 'list') await page.locator('.hosted-share-member').filter({ hasText: '来源文档' }).click();
    const originalUrl = page.url();
    let sourceFrame;
    if (mode === 'list') {
      await page.locator('[data-hosted-site-id="source"] .related-trigger').click();
    } else {
      sourceFrame = page.locator('iframe[title="来源文档"]').contentFrame();
      await sourceFrame.getByLabel('保留输入').fill('原页面状态');
      await sourceFrame.locator('body').evaluate(el => { el.ownerDocument.defaultView!.scrollTo(0, 200); });
      await expect(page.locator('.share-topbar')).toBeVisible();
      await expect(page.locator('.ledger-reading-article,.ledger-reading-sidebar,.hosted-ledger')).toHaveCount(0);
      const frame = await page.locator('iframe[title="来源文档"]').elementHandle();
      await page.locator('.share-topbar .related-trigger').click();
      expect(await page.locator('iframe[title="来源文档"]').evaluate((node, original) => node === original, frame)).toBe(true);
      await expect(sourceFrame.getByLabel('保留输入')).toHaveValue('原页面状态');
    }
    const listReads = apiRequests.filter(path => path === '/api/web-pages').length;
    const related = page.getByRole('dialog', { name: '合集', exact: true });
    await related.getByText('关联目标', { exact: true }).click();
    const modal = mode === 'guest-share' ? page.getByRole('dialog', { name: '关联文档预览', exact: true })
      : page.getByRole('dialog', { name: '关联目标', exact: true });
    await expect(modal).toBeVisible();
    await expect(modal.locator('iframe').first().contentFrame().getByRole('heading', { name: '目标正文' })).toBeVisible();
    const discussion = modal.getByRole('button', { name: '批注与讨论' });
    await expect(discussion).toHaveAttribute('aria-expanded', 'false');
    expect(page.url()).toBe(originalUrl);
    expect(page.context().pages()).toHaveLength(1);
    expect(apiRequests.filter(path => path === '/api/web-pages')).toHaveLength(listReads);
    if (mode === 'guest-share') expect(apiRequests).not.toContain('/api/web-pages/target');
    if (mode === 'list') {
      await expect(discussion).toHaveAccessibleDescription('1 条评论');
      await expect(modal.getByText('预览文档已有评论')).toBeHidden();
      await discussion.click();
      await expect(modal.getByText('预览文档已有评论')).toBeVisible();
      await discussion.click();
      await expect(discussion).toHaveAttribute('aria-expanded', 'false');

      await modal.getByRole('button', { name: '更多', exact: true }).click();
      const open = page.getByRole('menuitem', { name: '新窗口打开', exact: true });
      await expect(open).toBeInViewport();
      const [external] = await Promise.all([page.context().waitForEvent('page'), open.click()]);
      await expect(external).toHaveURL(/\/s\/wp\/qa-visit$/);
      await expect(external.locator('.share-topbar')).toBeVisible();
      await expect(external.locator('.hosted-ledger,[role="dialog"]')).toHaveCount(0);
      await expect(external.locator('iframe').contentFrame().getByRole('heading', { name: '目标正文' })).toBeVisible();
      const externalDiscussion = external.getByRole('button', { name: '批注与讨论' });
      await expect(externalDiscussion).toHaveAccessibleDescription('1 条评论');
      await expect(externalDiscussion).toHaveAttribute('aria-expanded', 'false');
      await externalDiscussion.click();
      await expect(external.getByText('预览文档已有评论')).toBeVisible();
      await external.reload();
      await expect(externalDiscussion).toHaveAttribute('aria-expanded', 'false');
      await external.setViewportSize({ width: 390, height: 844 });
      const documentTab = external.getByRole('tab', { name: '正文' });
      await expect(documentTab).toHaveAttribute('aria-selected', 'true');
      await external.getByRole('tab', { name: '讨论' }).click();
      await expect(external.getByText('预览文档已有评论')).toBeVisible();
      await documentTab.click();
      await external.setViewportSize({ width: 1440, height: 900 });
      await expect(externalDiscussion).toHaveAttribute('aria-expanded', 'false');
      await external.goto(new URL('/s/wp/qa-visit?review=current', external.url()).href);
      await expect(externalDiscussion).toHaveAttribute('aria-expanded', 'true');
      expect(apiRequests.filter(path => path === '/api/web-pages')).toHaveLength(listReads);
      await external.close();
    }
    // 原生和 Radix 阅读器都必须一次只关闭最上层，不丢失当前正文状态。
    await modal.locator('.related-trigger').click();
    await expect(page.getByRole('dialog', { name: '合集', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '合集', exact: true })).toHaveCount(0);
    await expect(modal).toBeVisible();
    await expect(modal.locator('.related-trigger')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    expect(page.url()).toBe(originalUrl);
    if (mode === 'list') {
      const card = page.locator('[data-hosted-site-id="target"]');
      await card.hover();
      await card.getByRole('button', { name: '更多设置' }).click();
      await page.getByText('评论管理', { exact: true }).click();
      await expect(modal.getByText('预览文档已有评论')).toBeVisible();
    }
    if (sourceFrame) {
      await expect(sourceFrame.getByLabel('保留输入')).toHaveValue('原页面状态');
      expect(await sourceFrame.locator('body').evaluate(el => el.ownerDocument.defaultView!.scrollY)).toBe(200);
    }
    expect(errors).toEqual([]);
  });
}

// 合集选择控制同一文档区；单一上下文不显示无意义的选择栏。
for (const width of [390, 1440]) for (const theme of ['light', 'dark'] as const) for (const multiple of [false, true]) {
  test(`文档合集联动 ${width}px ${theme} ${multiple ? '多个合集' : '单个合集多条分享'}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    const date = '2026-11-11T10:00:00Z';
    const site = { id: 'context-source', title: '发布指南', description: '合集联动验收', sourceType: 'upload', cosPrefix: '', entryFile: 'index.html', siteUrl: 'https://hosting.example/context-source/index.html',
      coverImageUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="190"><rect width="360" height="190" fill="#e1e8ef"/></svg>'),
      files: [], totalSize: 1024, ownerUserId: 'qa-context-user', visibility: 'private', viewCount: 0, tags: [], createdAt: date, updatedAt: date };
    const totalContexts = multiple ? 45 : 1;
    const link = (id: number, index = 0) => ({ id: `link-${id}-${index}`, title: `发布资料 ${id}`, shareUrl: `/s/wp/original-${id}-${index}`, createdAt: date, accessLevel: 'public', memberCount: 2, isActive: true, statusLabel: '有效' });
    const context = (id: number) => ({ id: `collection:${id}`, title: `发布资料 ${id}`, memberCount: multiple ? 12 : 2, updatedAt: date, collectionId: String(id), legacyShareId: null, shareCount: 3, primaryLink: link(id) });
    await page.addInitScript(() => {
      if (window.top !== window) return;
      localStorage.setItem('webpages.pref.viewMode', 'grid'); localStorage.setItem('webpages.pref.cardSize', 'medium');
      localStorage.setItem('prd-admin-auth', JSON.stringify({ state: { isAuthenticated: true,
        user: { userId: 'qa-context-user', username: 'qa-context-user', role: 'ADMIN' }, token: 'qa-context-session',
        permissions: ['access', 'web-pages.read'], permissionsLoaded: true, isRoot: false, menuCatalog: [], menuCatalogLoaded: true }, version: 0 }));
    });
    const errors: string[] = [], platformErrors: string[] = [], writes: string[] = [];
    // 与上方阅读器回归一致：保留 Playwright 禁用 SW 的沙箱注入错误证据，应用错误仍须为零。
    page.on('pageerror', error => {
      if (error.message.includes('Service worker is disabled because the context is sandboxed')) platformErrors.push(error.stack || error.message);
      else errors.push(error.stack || error.message);
    });
    await page.route('https://hosting.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>发布指南</h1>' }));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = decodeURIComponent(url.pathname);
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.request().method()) && path.startsWith('/api/web-pages')) writes.push(path);
      let data: unknown = { items: [], total: 0, folders: [], tags: [], teams: [] };
      if (path === '/api/authz/me') data = { effectivePermissions: ['access', 'web-pages.read'], menuCatalog: [], isRoot: false };
      else if (path === '/api/web-pages') data = { items: [site], total: 1 };
      else if (path === '/api/web-pages/related-documents/summaries') data = { items: { 'context-source': { count: 1, isMain: true, titles: ['会议纪要'] } } };
      else if (path.endsWith('/content')) data = { siteId: site.id, siteUrl: site.siteUrl, contentType: 'text/html', html: '<!doctype html><h1>发布指南</h1>' };
      else if (path.endsWith('/collection-contexts')) {
        const current = Number(url.searchParams.get('page') || 1), keyword = url.searchParams.get('keyword') || '';
        const ids = Array.from({ length: totalContexts }, (_, id) => id).filter(id => !keyword || String(id).includes(keyword));
        data = { items: ids.slice((current - 1) * 20, current * 20).map(context), total: ids.length, totalContexts, page: current, pageSize: 20 };
      } else if (path.endsWith('/documents')) {
        const id = Number(path.match(/collection:(\d+)/)?.[1] || 0);
        data = { version: 0, mainSiteId: site.id, canManage: false, hasPermissionDifferences: false, contextLabel: '合集成员',
          items: [{ id: site.id, title: '发布指南', isMain: true, href: '/web-pages?openSite=context-source' },
            { id: `target-${id}`, title: `关联目标 ${id}`, href: `/web-pages?openSite=target-${id}` },
            ...(multiple ? Array.from({ length: 10 }, (_, i) => ({ id: `extra-${id}-${i}`, title: `补充文档 ${i}`, href: `/web-pages?openSite=extra-${id}-${i}` })) : [])] };
      } else if (path.endsWith('/links')) {
        const id = Number(path.match(/collection:(\d+)/)?.[1] || 0);
        data = { items: [0, 1, 2].map(index => link(id, index)), total: 3, page: 1, pageSize: 20 };
      } else if (path === '/api/changelog/current-week') data = { weekStart: date, weekEnd: date, fetchedAt: date, dataSourceAvailable: true, source: 'local', totalDays: 0, totalEntries: 0, daysOffset: 0, hasMore: false, fragments: [] };
      await route.fulfill({ json: { success: true, data, error: null } });
    });
    await page.goto('/web-pages');
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const trigger = page.locator('[data-hosted-site-id="context-source"] .related-trigger');
    await expect(trigger).toHaveCount(1); await trigger.click();
    const dialog = page.getByRole('dialog', { name: '合集', exact: true });
    const sidebar = dialog.getByRole('complementary', { name: '所属合集' });
    if (multiple) {
      await expect(sidebar.locator('.collection-context-select')).toHaveCount(20);
      await expect(dialog.locator('.related-document-card')).toHaveCount(0);
      await sidebar.locator('.collection-context-select').first().click();
    }
    await expect(dialog.locator('.related-document-card')).toHaveCount(multiple ? 9 : 2);
    const footer = dialog.getByRole('region', { name: '合集链接操作', exact: true });
    await expect(footer.getByLabel('合集完整地址', { exact: true })).toHaveValue(new URL('/s/wp/original-0-0', page.url()).href);
    await expect(footer.getByRole('button', { name: '复制合集链接', exact: true })).toBeEnabled();
    await expect(dialog.locator('[aria-label="文档关系类型"]')).toHaveCount(0);
    await expect(footer.getByRole('link', { name: '打开合集', exact: true })).toHaveAttribute('href', new URL('/s/wp/original-0-0', page.url()).href);
    await expect(footer.getByRole('link', { name: '打开合集', exact: true })).toHaveAttribute('target', '_blank');
    if (multiple) {
      await expect(sidebar).toBeVisible(); await expect(sidebar.locator('.collection-context-select')).toHaveCount(20);
      await sidebar.locator('.collection-context-select').nth(1).click();
      await expect(dialog.locator('.related-document-card').filter({ hasText: '关联目标 1' })).toBeVisible();
      await expect(sidebar.locator('a')).toHaveCount(0);
      await expect(footer.getByLabel('合集完整地址', { exact: true })).toHaveValue(new URL('/s/wp/original-1-0', page.url()).href);
      await footer.getByRole('button', { name: '查看全部 3 条链接', exact: true }).click();
      await expect(footer.locator('.collection-context-link-option')).toHaveCount(3);
      await footer.locator('.collection-context-link-option').nth(2).click();
      await expect(footer.getByLabel('合集完整地址', { exact: true })).toHaveValue(new URL('/s/wp/original-1-2', page.url()).href);
      await expect(footer.getByRole('link', { name: '打开合集', exact: true })).toHaveAttribute('href', new URL('/s/wp/original-1-2', page.url()).href);
      await sidebar.getByLabel('搜索所属合集', { exact: true }).fill('44');
      await expect(sidebar.locator('.collection-context-select')).toHaveCount(1);
      await expect(footer.getByLabel('合集完整地址', { exact: true })).toHaveValue(new URL('/s/wp/original-1-2', page.url()).href);
      await sidebar.locator('.collection-context-select').first().click();
      await expect(dialog.locator('.related-document-card').filter({ hasText: '关联目标 44' })).toBeVisible();
      await sidebar.getByRole('button', { name: '清除合集搜索' }).click();
      await expect(sidebar.locator('.collection-context-select')).toHaveCount(20);
      await sidebar.getByRole('navigation', { name: '合集分页', exact: true }).getByRole('button', { name: '下一页' }).click();
      await expect(sidebar.locator('.collection-context-select').first().locator('strong')).toHaveText('发布资料 20');
      await expect(footer.getByLabel('合集完整地址', { exact: true })).toHaveValue(new URL('/s/wp/original-44-0', page.url()).href);
      const left = await sidebar.boundingBox(), right = await dialog.locator('.collection-context-documents').boundingBox();
      expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x + 1);
    } else {
      await expect(sidebar).toHaveCount(0); await dialog.getByRole('button', { name: '查看全部 3 条链接', exact: true }).click();
      await expect(footer.locator('.collection-context-link-option')).toHaveCount(3);
      await footer.locator('.collection-context-link-option').nth(1).click();
      await expect(footer.getByLabel('合集完整地址', { exact: true })).toHaveValue(new URL('/s/wp/original-0-1', page.url()).href);
      await expect(dialog.locator('[data-collection-layout="single"]')).toBeVisible();
    }
    await dialog.getByRole('button', { name: '列表视图', exact: true }).click();
    await expect(dialog.locator('.related-document-grid.is-list')).toBeVisible();
    await dialog.getByRole('button', { name: '卡片视图', exact: true }).click();
    const box = await dialog.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width); expect(box!.y + box!.height).toBeLessThanOrEqual(960);
    const anchorBox = await trigger.boundingBox();
    expect(box!.y >= anchorBox!.y + anchorBox!.height || box!.y + box!.height <= anchorBox!.y).toBe(true);
    const footerBefore = await footer.boundingBox();
    expect(footerBefore!.y + footerBefore!.height).toBeCloseTo(box!.y + box!.height, 0);
    expect(footerBefore!.width).toBeCloseTo(box!.width, 0);
    await dialog.locator('.related-documents-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
    const footerAfter = await footer.boundingBox();
    expect(footerAfter!.y).toBeCloseTo(footerBefore!.y, 0);
    const actions = await footer.locator('.collection-context-link-actions').boundingBox();
    expect(actions!.y + actions!.height).toBeLessThanOrEqual(footerAfter!.y + footerAfter!.height);
    const overflow = await dialog.evaluate(node => node.scrollWidth > node.clientWidth); expect(overflow).toBe(false);
    expect(errors).toEqual([]); expect(writes).toEqual([]);
    await testInfo.attach('sandbox-platform-diagnostics', { body: JSON.stringify(platformErrors), contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('collection-context-layout.png'), fullPage: false });
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`合集原分享阅读 ${theme}：慢响应切换不空白，返回目录不丢成员，迟到请求不覆盖`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', error => { if (!error.message.includes('Service worker is disabled because the context is sandboxed')) errors.push(error.message); });
    const sites = ['main', 'second', 'third', 'fourth'].map((id, index) => ({ id, title: `阅读文档 ${index + 1}`, siteUrl: `https://hosting.example/${id}/index.html`, entryFile: 'index.html', contentShape: 'self-contained-html', totalSize: 1024, entrySize: 1024, fileCount: 1 }));
    const shared = { title: '切换验收合集', shareType: 'collection', mainSiteId: 'main', sites, createdAt: '2026-11-15T00:00:00Z', createdBy: 'author' };
    let requests = 0;
    let delayNext = false;
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    await page.route('https://hosting.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>原文内容</h1>' }));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/annotation-runtime.js')) {
        await route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../../prd-api/src/PrdAgent.Infrastructure/Services/Assets/hostedAnnotations.js', import.meta.url), 'utf8') });
        return;
      }
      let data: unknown = { items: [], total: 0 };
      let stale = false;
      if (path === '/api/web-pages/shares/view/navigation-token') {
        requests++;
        if (delayNext) { delayNext = false; await delayed; stale = true; }
        data = stale ? { ...shared, title: '迟到的旧响应' } : shared;
      } else if (path.endsWith('/related-documents')) data = {
        items: sites.map(site => ({ id: site.id, title: site.title, preview: { ...site, useShareAccess: true },
          href: `/s/wp/navigation-token?siteId=${site.id}` })), version: 0, canManage: false,
      };
      else if (path.endsWith('/comments')) data = { comments: [], commentsEnabled: true, canComment: false };
      else if (path.endsWith('/html') || path.endsWith('/content')) data = { html: '<!doctype html><h1>原文内容</h1>', contentType: 'text/html' };
      await route.fulfill({ headers: stale ? { 'x-navigation-test': 'stale' } : {}, json: { success: true, data, error: null } });
    });
    await page.goto('/s/wp/navigation-token');
    await expect(page.getByRole('heading', { name: shared.title, exact: true })).toBeVisible({ timeout: 15000 });
    const themeSwitch = page.getByRole('button', { name: theme === 'light' ? '切换浅色' : '切换深色', exact: true });
    if (await themeSwitch.isVisible()) await themeSwitch.click();
    await expect(page.getByRole('region', { name: '主文档概览' }).locator('.ledger-document-preview')).toBeVisible();
    await expect(page.getByRole('region', { name: '全部文档' }).locator('.ledger-document-preview')).toHaveCount(3);
    const initialRequests = requests;
    delayNext = true;
    await page.locator('.ledger-directory .hosted-share-member').filter({ hasText: '阅读文档 2' }).click();
    await expect.poll(() => requests).toBe(initialRequests + 1);
    await expect(page.locator('iframe[title="阅读文档 2"]')).toBeVisible();
    await expect(page.locator('.review-reader-title').getByRole('link', { name: '返回合集' })).toBeVisible();
    await page.getByRole('button', { name: '合集', exact: true }).click();
    const related = page.getByRole('dialog', { name: '合集', exact: true });
    await expect(related.locator('.related-document-card')).toHaveCount(3);
    await expect(related.locator('.related-document-card').filter({ hasText: '阅读文档 1' })).toBeVisible();
    await expect(page.locator('.related-reader-popover')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.review-workbench')).toHaveAttribute('data-theme', theme);
    await page.keyboard.press('Escape');
    await expect(page.getByText('正在读取分享文档…', { exact: true })).toHaveCount(0);
    await testInfo.attach('等待复核时的阅读界面', { body: await page.screenshot(), contentType: 'image/png' });
    await page.goBack();
    await expect.poll(() => requests).toBe(initialRequests + 2);
    await expect(page.locator('.ledger-directory .hosted-share-member')).toHaveCount(4);
    await expect(page.getByRole('heading', { name: shared.title, exact: true })).toBeVisible();
    const lateResponse = page.waitForResponse(response => response.headers()['x-navigation-test'] === 'stale');
    release();
    await (await lateResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole('heading', { name: shared.title, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '迟到的旧响应', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
    await testInfo.attach('完整目录', { body: await page.screenshot(), contentType: 'image/png' });
    await expect(page.locator('.ledger-directory .hosted-share-member')).toHaveCount(4);
  });
}

test('视频分享可打开历史版本和合集卡片，分享读者没有上传操作', async ({ page }) => {
  const token = 'video-review';
  const sharePath = `/api/web-pages/shares/view/${token}`;
  const liveUrl = 'https://hosting.example/film/v2/index.html';
  const oldUrl = 'https://hosting.example/film/v1/index.html';
  const film = { id: 'film', title: '项目演示视频', siteUrl: liveUrl, entryFile: 'index.html', wrappedAssetType: 'video', contentShape: 'multi-file' };
  const member = { id: 'notes', title: '项目演示笔记', siteUrl: 'https://hosting.example/notes/index.html', entryFile: 'index.html' };
  const common = { siteId: film.id, canPreview: true, entryFile: 'index.html', contentShape: 'multi-file' };
  const current = { ...common, id: 'new-video', versionLabel: 'V2', contentVersionKey: '2026-11-26T12:00:00.000Z', isCurrent: true, siteUrl: liveUrl };
  const older = { ...common, id: 'old-video', versionLabel: 'V1', contentVersionKey: '2026-11-25T12:00:00.000Z', isCurrent: false, siteUrl: oldUrl };
  await page.route('https://hosting.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><video controls></video>' }));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let data: unknown = { items: [] };
    if (url.pathname === sharePath) data = { title: '项目演示合集', shareType: 'collection', mainSiteId: film.id, sites: [film, member], createdBy: 'author', createdAt: '2026-11-26T12:00:00Z' };
    if (url.pathname === `${sharePath}/revisions`) data = [current, older];
    if (url.pathname === `${sharePath}/revisions/old-video/preview`) data = { revision: older, siteUrl: oldUrl, html: '' };
    if (url.pathname === `${sharePath}/related-documents`) data = { items: [film, member].map(site => ({ id: site.id, title: site.title, preview: { ...site, useShareAccess: true }, isManual: true, href: `/s/wp/${token}?siteId=${site.id}` })), canManage: false, version: 0 };
    if (url.pathname.endsWith('/comments')) data = { comments: [], commentsEnabled: true, canComment: false };
    await route.fulfill({ json: { success: true, data, error: null } });
  });
  await page.goto(`/s/wp/${token}?siteId=${film.id}`);
  await expect(page.frameLocator('iframe[title="项目演示视频"]').locator('video')).toBeVisible();
  await page.getByRole('button', { name: '视频版本：V2' }).click();
  await expect(page.locator('iframe[title="V1 网页预览"]')).toHaveAttribute('src', oldUrl);
  await expect(page.getByRole('button', { name: '上传新版本', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭历史版本' }).click();
  const collectionToggle = page.getByRole('button', { name: '合集', exact: true });
  await collectionToggle.click();
  const collection = page.getByRole('dialog', { name: '合集', exact: true });
  await expect(collection.locator('.related-document-card')).toHaveCount(1);
  await expect(collection.locator('.related-document-card')).toContainText(member.title);
  await page.locator('iframe[title="项目演示视频"]').evaluate(frame => {
    frame.focus();
    window.dispatchEvent(new Event('blur'));
  });
  await expect(collectionToggle).toBeFocused();
  await expect(collectionToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(collection).toBeVisible();
});

// 从资产库入口验证批量创建、保存、分享和回读，测试数据不写入运行环境。
for (const mobile of [false, true]) test.describe(mobile ? '手机合集' : '桌面合集', () => {
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 };
  test.use({ viewport, isMobile: mobile, hasTouch: mobile });

  test('批量创建合集可直接保存，分享后收进我的合集并分组回读', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => {
      // Playwright 的 service-worker 拦截脚本也会注入安全隔离的网页缩略图。
      if (!error.message.startsWith("Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed")) {
        errors.push(error.message);
      }
    });
    await page.emulateMedia({ reducedMotion: mobile ? 'reduce' : 'no-preference' });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const date = new Date().toISOString();
    const titles = ['架构决策记录', '读书会参考资料', '关于技术决策的参考资料与现有工程实践说明'.repeat(4)];
    const sites = titles.map((title, index) => ({
      id: `collection-site-${index}`, title, sourceType: 'upload', cosPrefix: '', entryFile: 'index.html',
      siteUrl: `https://hosting.example/collection-${index}/index.html`, contentShape: 'self-contained-html',
      files: [], totalSize: 400, tags: [], folderCanonicalName: '', visibility: 'private',
      ownerUserId: 'collection-qa', viewCount: 0, createdAt: date, updatedAt: date,
    }));
    const compat = '/api/web-pages/collections/compat';
    const proposed = ['架构实践合集'];
    let namesRequested = 0;
    let payload: { title: string; mainSiteId: string; siteIds: string[] } | undefined;
    let shares: Record<string, unknown>[] = [];
    await page.addInitScript(() => {
      if (window.top !== window.self) return;
      localStorage.setItem('prd-admin-auth', JSON.stringify({ state: {
        isAuthenticated: true, user: { userId: 'collection-qa', username: 'collection-qa', role: 'ADMIN' },
        token: 'collection-qa-session', permissions: ['access', 'web-pages.read', 'web-pages.write'],
        permissionsLoaded: true, menuCatalog: [], menuCatalogLoaded: true,
      }, version: 0 }));
    });
    const documentHtml = (index: number) => `<!doctype html><body style="background:${['#ebe2d3', '#14241f', '#e6eef4'][index]};color:${index === 1 ? '#e6eeeb' : '#1e2833'};padding:58px;font:32px system-ui"><p>技术笔记</p><h1>${titles[index].slice(0, 24)}</h1><hr><p>阅读资料 · 应用实例与讨论</p></body>`;
    await page.route('https://hosting.example/**', route => {
      const index = Number(/collection-(\d)/.exec(new URL(route.request().url()).pathname)?.[1] ?? 0);
      return route.fulfill({ contentType: 'text/html', body: documentHtml(index) });
    });
    const details = () => ({
      collection: payload ? { ...payload, id: 'collection-qa', ownerUserId: 'collection-qa', version: 1, shareGeneration: 1, isDissolved: false, updatedAt: date } : null,
      sites, shares,
    });
    await page.route('**/api/**', async route => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      let data: unknown = { items: [], total: 0, folders: [], tags: [], teams: [] };
      if (path === '/api/authz/me') data = { effectivePermissions: ['access', 'web-pages.read', 'web-pages.write'], menuCatalog: [], isRoot: false };
      if (path === '/api/web-pages') data = { items: sites, total: sites.length };
      if (path === '/api/changelog/current-week') data = { weekStart: date, weekEnd: date, fetchedAt: date,
        dataSourceAvailable: true, source: 'local', totalDays: 0, totalEntries: 0, daysOffset: 0, hasMore: false, fragments: [] };
      const documentIndex = sites.findIndex(site => path === `/api/web-pages/${site.id}/content`);
      if (documentIndex !== -1) data = { html: documentHtml(documentIndex) };
      if (path === `${compat}/candidates`) data = { items: sites, total: 3 };
      if (path === `${compat}/name-suggestions`) {
        namesRequested++;
        expect(req.postDataJSON()).toEqual({ siteIds: sites.map(site => site.id) });
        data = { names: proposed };
      }
      if (path === compat && req.method() === 'POST') { payload = req.postDataJSON(); data = details(); }
      if (path === compat && req.method() === 'GET') data = {
        items: payload ? [details().collection] : [], total: payload ? 1 : 0,
        members: Object.fromEntries(sites.map(site => [site.id, site])),
      };
      if (path === `${compat}/collection-qa`) data = details();
      if (path === `${compat}/collection-qa/sharing-preview`) data = { fingerprint: 'proof', version: 1, canShare: true, items: [], notice: '' };
      if (path.includes('private-sources')) data = { requiresConfirmation: false, items: [] };
      if (path === `${compat}/collection-qa/shares`) {
        expect(req.postDataJSON()).toMatchObject({ collectionVersion: 1, permissionFingerprint: 'proof', visibility: 'logged-in', expiresInDays: 7 });
        const share = { id: 'share-qa', token: 'collection-token', shareUrl: '/s/wp/collection-token', visibility: 'logged-in', expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
        data = share;
        shares = [{ ...share, siteIds: payload?.siteIds, active: true, isRevoked: false, needsUpdate: false, collectionVersion: 1, memberCount: 3 }];
      }
      await route.fulfill({ json: { success: true, data, error: null } });
    });
    await page.goto('/web-pages');
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, mobile ? 'light' : 'dark');
    const cards = page.locator('[data-tour-id="webpages-card"]');
    await expect(cards).toHaveCount(3, { timeout: 15000 });
    if (!mobile) await page.getByLabel('批量选择', { exact: true }).click();
    for (const card of await cards.all()) await card.getByRole('button', { name: '选择', exact: true }).click();
    await page.getByRole('button', { name: '创建合集', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '创建合集' });
    await expect(editor.getByRole('textbox', { name: '合集名称', exact: true })).toHaveValue(proposed[0]);
    expect(namesRequested).toBe(1);
    await expect(editor.getByRole('article')).toHaveCount(3);
    await expect(editor.getByRole('article').first()).toContainText('主文档');
    const candidate = editor.getByRole('button', { name: titles[2], exact: true }).locator('span');
    expect(await candidate.evaluate(el => getComputedStyle(el).whiteSpace === 'nowrap' && el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(editor.locator('iframe')).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath('collection-create.png') });
    await editor.getByRole('textbox', { name: '合集名称', exact: true }).fill('arc');
    await editor.getByRole('button', { name: '保存合集' }).click();
    await expect.poll(() => payload).toMatchObject({ title: 'arc', mainSiteId: sites[0].id, siteIds: sites.map(site => site.id) });
    expect(shares).toHaveLength(0);
    const manager = page.getByRole('dialog', { name: '管理合集' });
    await expect(manager.getByRole('button', { name: '撤销合集' })).toBeVisible();
    await manager.getByRole('button', { name: '生成分享链接' }).click();
    const panel = page.getByRole('dialog', { name: '分享', exact: true });
    await expect(panel.getByRole('textbox', { name: '分享链接' })).toHaveValue(/\/s\/wp\/collection-token$/);
    expect(await panel.evaluate(el => getComputedStyle(el.parentElement!).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await panel.getByRole('button', { name: '复制', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/s\/wp\/collection-token$/);
    const box = (await panel.boundingBox())!;
    expect(box.x + box.width).toBeGreaterThan(viewport.width - 31);
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 31);
    await page.screenshot({ path: testInfo.outputPath('collection-share.png') });
    if (mobile) await page.touchscreen.tap(10, 32);
    else {
      await page.evaluate(() => {
        const observer = new MutationObserver(records => {
          const flight = records.flatMap(record => Array.from(record.addedNodes)).find(node => node instanceof Element && node.matches('.collection-flight'));
          if (flight instanceof Element) {
            const halo = document.querySelector('[data-gather-motion="halo"]');
            document.documentElement.dataset.collectionFlightObserved = JSON.stringify({
              flight: flight.getAnimations()[0]?.effect?.getTiming().duration,
              landing: halo?.getAnimations()[0]?.effect?.getTiming().delay,
            });
            observer.disconnect();
          }
        });
        observer.observe(document.body, { childList: true });
      });
      await page.mouse.click(40, 300);
      await expect(page.locator('html')).toHaveAttribute('data-collection-flight-observed', '{"flight":1440,"landing":1320}');
    }
    await expect(panel).toHaveCount(0);
    await expect(manager).toHaveCount(0);
    if (mobile) await expect(page.locator('[data-gather-motion]')).toHaveCount(0);
    await page.getByRole('button', { name: '我的合集', exact: true }).click();
    const group = page.getByRole('region', { name: 'arc' });
    await expect(group).toBeVisible();
    await expect(group.getByText('刚收入')).toBeVisible();
    await expect(group.locator('[data-tour-id="webpages-card"]')).toHaveCount(3);
    await expect(page.locator('.collection-flight')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('collection-library.png') });
    await page.reload();
    await page.getByRole('button', { name: '我的合集', exact: true }).click();
    await group.getByRole('button', { name: '管理合集：arc' }).click();
    await expect(manager.getByRole('textbox', { name: '合集名称', exact: true })).toHaveValue('arc');
    await expect(manager.getByRole('article').first()).toContainText(titles[0]);
    await manager.getByRole('button', { name: '生成分享链接' }).click();
    await expect(panel.getByRole('textbox', { name: '分享链接' })).toHaveValue(/\/s\/wp\/collection-token$/);
    await panel.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(manager).toHaveCount(0);
    expect(namesRequested).toBe(1);
    expect(errors).toEqual([]);
  });
});
