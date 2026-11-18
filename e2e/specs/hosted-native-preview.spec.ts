import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// 临时对抗文件只存在于测试目录，afterAll 无论成功失败都清理；保留生成器用于回归。
let directory: string;
let origin: string;
let entry: string;
const files: Record<string, string> = {
  'index.html': `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./style.css"></head><body>
    <h1>原地址运行验证</h1><input aria-label="保留输入"><button id="state">更新地址</button>
    <p id="result">loading</p><img alt="中文资源" src="./图片 空格.svg"><iframe id="child" title="子页面"></iframe>
    <a href="child.html?value=next#part" id="next">下一页</a><script src="./app.js"></script>
    <script type="module" src="./module.js"></script></body></html>`,
  'app.js': `const child = document.querySelector('#child');
    window.addEventListener('message', event => {
      if(event.source === child.contentWindow && event.origin === location.origin && event.data === 'child-ready')
        document.body.dataset.child = 'ready';
    });
    child.src = new URL('child.html?value=child#part', location.href).href;
    localStorage.setItem('preview-adversarial', 'ok');
    document.body.dataset.storage = localStorage.getItem('preview-adversarial');
    try { parent.document.body.dataset.compromised = 'yes'; } catch { document.body.dataset.isolation = 'ok'; }
    fetch(new URL('data.json', location.href)).then(r => r.json()).then(data => {
      document.querySelector('#result').textContent = data.message + ':' + new URLSearchParams(location.search).get('case');
    });
    document.querySelector('#state').onclick = () => history.pushState({}, '', '?case=changed#step');`,
  'module.js': `import { value } from './dependency.js'; document.body.dataset.module = value;`,
  'dependency.js': `export const value = 'ready';`,
  'style.css': 'h1 { color: rgb(12, 99, 33); }',
  'data.json': '{"message":"fetch-ok"}',
  '图片 空格.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="green"/></svg>',
  'child.html': `<!doctype html><html><body><h1>子页面</h1><p id="query"></p><iframe title="孙页面" src="grandchild.html"></iframe>
    <script>document.querySelector('#query').textContent = new URLSearchParams(location.search).get('value');
    parent.postMessage('child-ready', '*');</script></body></html>`,
  'grandchild.html': '<!doctype html><html><body><h1>第三层页面</h1></body></html>',
};

test.beforeAll(async ({}, testInfo) => {
  // 生产是 admin/cfi 两个同站不同源域名；同样保留跨源隔离，不把测试变成跨站存储策略测试。
  const hosted = new URL(String(testInfo.project.use.baseURL));
  if (hosted.hostname === '127.0.0.1' || hosted.hostname === 'localhost') hosted.port = String(Number(hosted.port || 80) + 1);
  else hosted.hostname = `hosting.${hosted.hostname}`;
  origin = hosted.origin;
  entry = `${origin}/sites/qa/nested/index.html?case=entry#start`;
  directory = await mkdtemp(join(tmpdir(), 'hosted-preview-adversarial-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
});
test.afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
test.use({ trace: 'off', video: 'off' });

for (const width of [1440, 900, 390]) test(`${width}px 合集两份工具栏只打开一个历史阅读上下文`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const site = { id: 'collection-doc', title: '合集唯一预览样例', siteUrl: entry, entryFile: 'index.html', contentShape: 'self-contained-html', canEdit: false, canShare: true };
  const current = { id: 'cv2', siteId: site.id, versionLabel: 'V2', contentVersionKey: '20000', isCurrent: true, canPreview: true, siteUrl: entry, entryFile: 'index.html', contentShape: 'self-contained-html' };
  const old = { ...current, id: 'cv1', versionLabel: 'V1', contentVersionKey: '10000', isCurrent: false };
  let previews = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/annotation-runtime.js')) { await route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../../prd-api/src/PrdAgent.Infrastructure/Services/Assets/hostedAnnotations.js', import.meta.url), 'utf8') }); return; }
    let data: unknown = {};
    if (path.endsWith('/shares/view/qa-collection/collection')) data = { collection: { id: 'qa-collection', name: '单一历史预览', description: '', siteIds: [site.id], mainSiteId: site.id, sections: [], version: 1 }, items: [site], canManage: false };
    else if (path.endsWith('/content')) data = { html: '<h1>合集当前正文</h1><p>当前阅读上下文。</p>' };
    else if (path.endsWith('/comments')) data = { comments: [], commentsEnabled: true, canComment: false };
    else if (path.endsWith('/revisions')) data = [current, old];
    else if (path.endsWith('/revisions/cv1/preview')) { previews++; data = { revision: old, siteUrl: null, html: '<h1>历史只有一份</h1><p>不应重复执行。</p>' }; }
    await route.fulfill({ json: { success: true, data, error: null } });
  });
  await page.goto('/s/collection/qa-collection');
  await page.getByRole('button', { name: '从主文档开始阅读', exact: true }).click();
  if (width <= 700) await page.locator('[data-tool="notes"]').click();
  await page.getByRole('button', { name: '网页版本：V2', exact: true }).filter({ visible: true }).click();
  await page.getByRole('option', { name: /^V1/ }).click();
  await expect(page.locator('iframe[title="V1 网页预览"]')).toHaveCount(1);
  await expect(page.frameLocator('iframe[title="V1 网页预览"]').getByRole('heading', { name: '历史只有一份' })).toBeVisible();
  expect(previews).toBe(1);
  const document = await page.locator('iframe[title="V1 网页预览"]').elementHandle();
  await page.setViewportSize({ width: width === 1440 ? 390 : 1440, height: 900 });
  await page.waitForTimeout(200);
  expect(await document!.evaluate(element => element.isConnected)).toBe(true);
  expect(previews).toBe(1);
  await page.setViewportSize({ width, height: 900 });
  if (width <= 700) {
    await page.getByRole('dialog', { name: 'V1 · 版本预览', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('[data-tool="notes"]').click();
    await page.getByRole('button', { name: '网页版本：V2', exact: true }).filter({ visible: true }).click();
    await page.getByRole('option', { name: /^V1/ }).click();
    await expect(page.getByRole('dialog', { name: 'V1 · 版本预览', exact: true }).frameLocator('iframe').getByRole('heading', { name: '历史只有一份' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'V1 · 版本预览', exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '合集阅读面板', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '合集阅读面板', exact: true })).toHaveCount(0);
  } else await page.getByRole('dialog', { name: 'V1 · 版本预览', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  if (width > 700) await expect(page.getByRole('button', { name: '网页版本：V2', exact: true }).filter({ visible: true })).toBeFocused();
});

async function serve(page: Page, options: { shape?: string; wrapper?: string; html?: string;
  pdfFilePaths?: string[]; requiresPreviewBridge?: boolean; sameOrigin?: boolean; nativeHtml?: string; modal?: boolean; inlineHistory?: boolean; extraHistory?: boolean; multiFileHistory?: boolean; metadataLag?: boolean; ask?: boolean } = {}) {
  const requests: string[] = [];
  let contentRequests = 0;
  let listRequests = 0;
  let releaseVersions!: () => void;
  const metadataGate = new Promise<void>(resolve => { releaseVersions = resolve; });
  const hostedOrigin = options.sameOrigin ? new URL(String(test.info().project.use.baseURL)).origin : origin;
  const entryUrl = new URL(options.sameOrigin ? entry.replace(origin, hostedOrigin) : entry);
  if (options.metadataLag) entryUrl.searchParams.set('v', '20000');
  const siteEntry = entryUrl.href;
  const site = {
    id: 'qa-native', title: '临时预览测试', siteUrl: siteEntry, entryFile: 'index.html',
    contentShape: options.shape, wrappedAssetType: options.wrapper,
    pdfFilePaths: options.pdfFilePaths, requiresPreviewBridge: options.requiresPreviewBridge,
    totalSize: 3000, entrySize: 600, fileCount: 10, viewerCanEdit: !!options.inlineHistory,
    ownerUserId: 'qa-preview-user', files: [], tags: [], folder: '', sourceType: 'upload',
    createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z', askEnabled: false,
  };
  await page.route(`${hostedOrigin}/sites/qa/nested/**`, async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    const name = decodeURIComponent(url.pathname.split('/').pop()!);
    // 测试服务器不做 SPA fallback，也不添加 CORS；错误路径应保留真实 404。
    if (!(name in files)) { await route.fulfill({ status: 404, body: 'Missing file' }); return; }
    const types: Record<string, string> = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml' };
    await route.fulfill({ contentType: types[name.split('.').pop()!]!, body: name === 'index.html' && options.nativeHtml
      ? options.nativeHtml : name === 'index.html' && options.multiFileHistory ? files['index.html'].replace('<script type="module" src="./module.js"></script>', '') : await readFile(join(directory, name)) });
  });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/annotation-runtime.js')) {
      await route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../../prd-api/src/PrdAgent.Infrastructure/Services/Assets/hostedAnnotations.js', import.meta.url), 'utf8') });
      return;
    }
    const currentVersion = { id: 'current', siteId: site.id, versionLabel: 'V2', contentVersionKey: options.metadataLag ? '10000' : '20000', isCurrent: true, canPreview: true, siteUrl: siteEntry, entryFile: 'index.html', contentShape: 'self-contained-html' };
    const inlineVersion = { ...currentVersion, id: 'inline-history', versionLabel: 'V1', contentVersionKey: '10000', isCurrent: false, siteUrl: options.multiFileHistory ? siteEntry : null, contentShape: options.multiFileHistory ? 'multi-file' : 'self-contained-html' };
    const olderVersion = { ...inlineVersion, id: 'earlier-history', versionLabel: 'V0', contentVersionKey: '5000' };
    let data: unknown = { items: [], total: 0, folders: [], tags: [], teams: [] };
    if (path.endsWith('/shares/view/qa-native')) {
      data = { title: '临时预览测试', shareType: 'single', createdAt: '2026-11-03T00:00:00Z', sites: [site],
        ask: options.ask ? { enabled: true, siteId: site.id, allowAnonymous: true, openingQuestions: [] } : undefined };
    } else if (path === '/api/authz/me') {
      data = { effectivePermissions: ['access', 'web-pages.read'], menuCatalog: [], isRoot: false };
    } else if (path === '/api/web-pages') {
      listRequests++;
      data = { items: [site], total: 1, activity: { [site.id]: { editCount: listRequests, isNew: false } } };
    } else if (path === '/api/changelog/current-week') {
      data = { weekStart: '2026-11-02', weekEnd: '2026-11-08', fetchedAt: site.createdAt,
        dataSourceAvailable: true, source: 'local', totalDays: 0, totalEntries: 0,
        daysOffset: 0, hasMore: false, fragments: [] };
    } else if (path.endsWith('/download/pdf')) {
      await route.fulfill({ contentType: 'application/pdf', headers: { 'Content-Disposition': 'attachment; filename="lesson.pdf"' }, body: '%PDF-1.4\n%%EOF' });
      return;
    } else if (path.endsWith('/content')) {
      contentRequests++;
      data = { html: options.html ?? files['index.html'] };
    } else if (path.endsWith('/comments')) {
      data = { siteId: site.id, commentsEnabled: true, canComment: !!options.inlineHistory, comments: options.extraHistory ? [{
        id: 'inline-history-note', revisionId: inlineVersion.id, contentVersion: inlineVersion.contentVersionKey,
        authorName: '复验作者', content: '旧版意见与正文同时可读', createdAt: '2026-11-02T00:00:00Z',
      }] : [] };
    } else if (path.endsWith('/revisions')) {
      if (options.metadataLag) await metadataGate;
      data = options.inlineHistory ? [currentVersion, inlineVersion, ...(options.extraHistory ? [olderVersion] : [])] : options.metadataLag ? [currentVersion] : [];
    } else if (options.extraHistory && path.endsWith('/revisions/earlier-history/preview')) {
      data = { revision: olderVersion, siteUrl: null, html: '<h1>更早的 V0 正文</h1>' };
    } else if (path.endsWith('/revisions/inline-history/preview')) {
      data = { revision: inlineVersion, siteUrl: inlineVersion.siteUrl, html: options.multiFileHistory ? files['index.html'].replace('<script type="module" src="./module.js"></script>', '') : '<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="old-heading">仅保留 HTML 的旧版正文</h1><p>这是旧版，不能替换为当前版或后台页面。</p></body></html>' };
    }
    await route.fulfill({ json: { success: true, data, error: null } });
  });
  if (options.modal || options.inlineHistory) {
    await page.addInitScript(() => localStorage.setItem('prd-admin-auth', JSON.stringify({
      state: { isAuthenticated: true, user: { userId: 'qa-preview-user', username: 'qa-preview-user', displayName: '预览验收用户', role: 'ADMIN' },
        token: 'qa-preview-token', refreshToken: 'qa-preview-refresh', sessionKey: 'qa-preview-session',
        permissions: ['access', 'web-pages.read'], permissionsLoaded: true, isRoot: false,
        menuCatalog: [], menuCatalogLoaded: true, cdnBaseUrl: '', permFingerprint: 'qa-preview' }, version: 0,
    })));
  }
  if (options.modal) {
    await page.goto('/web-pages');
    const card = page.locator('[data-tour-id="webpages-card"]').filter({ hasText: site.title });
    await expect(card).toBeVisible();
    await card.hover();
    await card.getByRole('button', { name: '更多' }).filter({ visible: true }).first().click();
    // 固定父页时钟，让输入操作稳定发生在 1.5 秒等待窗内，不依赖 CI 机器速度。
    if (!options.inlineHistory && !options.metadataLag) {
      await page.clock.install({ time: new Date('2026-11-03T12:00:00Z') });
      await page.clock.pauseAt(new Date('2026-11-03T12:00:01Z'));
    }
    await page.getByText('评论管理', { exact: true }).click();
  } else {
    await page.goto('/s/wp/qa-native');
  }
  const preview = page.locator('iframe[title="临时预览测试"]');
  await expect(preview).toBeVisible();
  return { releaseVersions, requests, contentRequests: () => contentRequests, listRequests: () => listRequests, frame: preview.contentFrame(), preview };
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`托管对抗样本 ${viewport.width}px`, () => {
    test.use({ viewport });

    test('在同一个历史小窗切换快照，清除上一版的恢复确认并保留当前正文', async ({ page }) => {
      const { frame } = await serve(page, { modal: true, inlineHistory: true, extraHistory: true, shape: 'self-contained-html', html: '<h1>当前版正文</h1>' });
      const version = page.getByRole('button', { name: '网页版本：V2', exact: true });
      await version.click();
      await page.getByRole('option', { name: /^V1/ }).click();
      const first = page.getByRole('dialog', { name: 'V1 · 版本预览', exact: true });
      await expect(first.frameLocator('iframe').getByRole('heading', { name: '仅保留 HTML 的旧版正文' })).toBeVisible();
      await expect(first.getByText('旧版意见与正文同时可读', { exact: true })).toBeVisible();
      const documentBox = await first.locator('iframe').boundingBox();
      const commentsBox = await first.locator('.review-history-comments').boundingBox();
      expect(documentBox && commentsBox && (documentBox.x + documentBox.width <= commentsBox.x + 1 || documentBox.y + documentBox.height <= commentsBox.y + 1)).toBeTruthy();
      await expect(first.locator('.annotation-chat-bubble')).toHaveCount(0);
      const dialogElement = await first.elementHandle();
      await first.getByRole('button', { name: '恢复为当前版本', exact: true }).click();
      await first.getByRole('navigation', { name: '历史版本列表' }).getByRole('button', { name: /^V0/ }).click();
      const second = page.getByRole('dialog', { name: 'V0 · 版本预览', exact: true });
      await expect(second.frameLocator('iframe').getByRole('heading', { name: '更早的 V0 正文' })).toBeVisible();
      expect(await dialogElement!.evaluate(element => element.isConnected)).toBe(true);
      await expect(second.getByRole('button', { name: '确认恢复并发布', exact: true })).toHaveCount(0);
      await expect(second.getByRole('button', { name: '恢复为当前版本', exact: true })).toBeVisible();
      await second.getByRole('button', { name: '返回当前页', exact: true }).click();
      await expect(frame.getByRole('heading', { name: '当前版正文' })).toBeVisible();
      await expect(version).toBeFocused();
    });

    test('历史小窗隔离之前上传错误，恢复失败保留可操作提示', async ({ page }) => {
      await serve(page, { modal: true, inlineHistory: true, shape: 'self-contained-html', html: '<h1>当前版正文</h1>' });
      await page.route('**/api/web-pages/qa-native/reupload', route => route.fulfill({ json: { success: false, data: null, error: { code: 'TEST_UPLOAD', message: '上传失败，请重新上传' } } }));
      await page.route('**/api/web-pages/qa-native/edits/revisions/inline-history/rollback', route => route.fulfill({ json: { success: false, data: null, error: { code: 'VERSION_CONFLICT', message: '版本已更新，请核对后重试恢复' } } }));
      await page.getByLabel('上传新版本文件', { exact: true }).setInputFiles({ name: 'new.html', mimeType: 'text/html', buffer: Buffer.from('<h1>新版</h1>') });
      await page.getByRole('button', { name: '网页版本：V2', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: '上传失败，请重新上传' })).toBeVisible();
      await page.getByRole('option', { name: /^V1/ }).click();
      const dialog = page.getByRole('dialog', { name: 'V1 · 版本预览', exact: true });
      await expect(dialog.frameLocator('iframe').getByRole('heading', { name: '仅保留 HTML 的旧版正文' })).toBeVisible();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await dialog.getByRole('button', { name: '恢复为当前版本', exact: true }).click();
      const confirmRestore = dialog.getByRole('button', { name: '确认恢复并发布', exact: true });
      const confirmBox = await confirmRestore.boundingBox();
      expect(confirmBox!.width).toBeGreaterThan(100);
      expect(confirmBox!.height).toBeLessThanOrEqual(48);
      expect(await confirmRestore.evaluate(button => button.scrollWidth <= button.clientWidth)).toBe(true);
      await confirmRestore.click();
      await expect(dialog.getByRole('alert')).toHaveText('版本已更新，请核对后重试恢复');
      await dialog.screenshot({ path: test.info().outputPath('restore-confirm.png') });
      await expect(page.locator('iframe[title="临时预览测试"]').contentFrame().getByRole('heading', { name: '当前版正文' })).toBeVisible();
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '网页版本：V2', exact: true }).click();
      await page.getByRole('option', { name: /^V1/ }).click();
      await expect(dialog.frameLocator('iframe').getByRole('heading', { name: '仅保留 HTML 的旧版正文' })).toBeVisible();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
    });

    for (const modal of [false, true]) {
      test(`${modal ? '站内' : '分享'}的无直链历史正文保持内联预览并可绑定批注`, async ({ page }) => {
        const { frame, preview } = await serve(page, { modal, inlineHistory: true, shape: 'self-contained-html', html: '<h1>当前版正文</h1>' });
        await expect(frame.getByRole('heading', { name: '当前版正文' })).toBeVisible();
        await page.getByRole('button', { name: '网页版本：V2', exact: true }).click();
        await page.getByRole('option', { name: /V1/ }).click();
        const dialog = page.getByRole('dialog', { name: 'V1 · 版本预览', exact: true });
        const historical = dialog.locator('iframe');
        const historicalFrame = historical.contentFrame();
        await expect(historicalFrame.getByRole('heading', { name: '仅保留 HTML 的旧版正文' })).toBeVisible();
        await expect(frame.getByRole('heading', { name: '当前版正文' })).toBeVisible();
        await expect(preview).toHaveAttribute('srcdoc', /当前版正文/);
        await expect.poll(() => historicalFrame.locator('base').getAttribute('href')).toBe(new URL('.', entry).href);
        expect((await historical.getAttribute('sandbox'))?.split(' ')).not.toContain('allow-same-origin');
        await dialog.getByRole('button', { name: '查看此版本批注', exact: true }).click();
        const bind = dialog.getByRole('button', { name: '绑定页面元素 / 选中文字', exact: true });
        await expect(bind).toBeEnabled();
        await bind.click();
        await historicalFrame.getByRole('heading', { name: '仅保留 HTML 的旧版正文' }).click();
        await expect(dialog.getByText('已选中标题', { exact: true })).toBeVisible();
        await expect(historical).toHaveAttribute('srcdoc', /仅保留 HTML 的旧版正文/);
        await expect(historicalFrame.locator('script[data-map-pdf-download-bridge], script[data-map-package-download-bridge]')).toHaveCount(0);
        expect(new URL(page.url()).pathname).toBe(modal ? '/web-pages' : '/s/wp/qa-native');

      });
    }

    for (const modal of [false, true]) {
      test(`${modal ? '站内' : '分享'}的历史多文件版本保留真实来源与同源 fetch`, async ({ page }) => {
        const { frame } = await serve(page, { modal, inlineHistory: true, multiFileHistory: true, shape: 'multi-file' });
        await page.getByRole('button', { name: '网页版本：V2', exact: true }).click();
        await page.getByRole('option', { name: /V1/ }).click();
        const dialog = page.getByRole('dialog', { name: 'V1 · 版本预览', exact: true });
        const historical = dialog.locator('iframe');
        const historicalFrame = historical.contentFrame();
        await expect(page.getByRole('button', { name: '网页版本：V2', exact: true, includeHidden: true })).toBeAttached();
        await expect(historicalFrame.locator('#result')).toHaveText('fetch-ok:entry');
        await expect(historical).not.toHaveAttribute('srcdoc');
        expect(await historicalFrame.locator('body').evaluate(() => location.href)).toBe(entry);
        await expect(historicalFrame.locator('body')).toHaveAttribute('data-storage', 'ok');
        await expect(historicalFrame.locator('body')).toHaveAttribute('data-isolation', 'ok');
        expect(await page.locator('body').getAttribute('data-compromised')).toBeNull();
        await expect(frame.locator('#result')).toHaveText('fetch-ok:entry');
      });
    }

    test('历史快照失败时不展示当前版批注，重试后仍在小窗', async ({ page }) => {
      const { frame } = await serve(page, { modal: true, inlineHistory: true, shape: 'self-contained-html', html: '<h1>当前版正文</h1>' });
      let failSnapshot = true;
      await page.route('**/revisions/inline-history/preview', async route => {
        if (failSnapshot) await route.fulfill({ status: 503, json: { success: false, error: { message: '快照暂不可用，请重试' } } });
        else await route.fallback();
      });
      await page.getByRole('button', { name: '网页版本：V2', exact: true }).click();
      await page.getByRole('option', { name: /V1/ }).click();
      const dialog = page.getByRole('dialog', { name: 'V1 · 版本预览', exact: true });
      await expect(dialog.getByRole('button', { name: '重试预览', exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: '查看此版本批注', exact: true })).toBeDisabled();
      await expect(dialog.locator('.review-sidebar')).toHaveCount(0);
      await expect(dialog.locator('iframe')).toHaveCount(0);
      await expect(frame.getByRole('heading', { name: '当前版正文' })).toBeVisible();
      failSnapshot = false;
      await dialog.getByRole('button', { name: '重试预览', exact: true }).click();
      await expect(dialog.locator('iframe').contentFrame().getByRole('heading', { name: '仅保留 HTML 的旧版正文' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: '查看此版本批注', exact: true })).toBeEnabled();
      expect(new URL(page.url()).pathname).toBe('/web-pages');
    });

    test('站内当前版保留输入，不因旧版本记录响应而跳到空白文档', async ({ page }) => {
      const { frame, preview, releaseVersions } = await serve(page, { modal: true, shape: 'multi-file', metadataLag: true });
      await expect(frame.locator('#result')).toHaveText('fetch-ok:entry');
      await frame.getByLabel('保留输入').fill('等待版本记录时保留');
      await page.getByRole('dialog').getByRole('button', { name: '批注与讨论', exact: true }).click();
      await expect(page.locator('.review-thread-scroll')).toContainText('正在确认网页版本');
      await expect(page.getByRole('dialog')).not.toContainText('无法确认网页版本');
      const original = await preview.elementHandle();
      const listed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/revisions'));
      releaseVersions(); await listed;
      await page.getByRole('button', { name: '网页版本：加载中', exact: true }).click();
      await expect(page.getByRole('option', { name: /V2/ })).toBeDisabled();
      await page.keyboard.press('Escape');
      expect(await original!.evaluate(element => element.isConnected)).toBe(true);
      await expect(frame.getByLabel('保留输入')).toHaveValue('等待版本记录时保留');
      expect(await frame.locator('body').evaluate(() => location.href)).toContain('v=20000');
    });

    test('讨论打开时进入全屏仍铺满视口，退出后恢复工具栏', async ({ page }) => {
      await serve(page, { shape: 'multi-file' });
      await page.getByRole('button', { name: '批注与讨论', exact: true }).click();
      await expect(page.locator('aside.review-sidebar')).toBeVisible();
      await page.getByRole('button', { name: '全屏演示', exact: true }).click();
      await expect(page.locator('.share-topbar')).toBeHidden();
      await expect(page.locator('aside.review-sidebar')).toBeHidden();
      await expect.poll(async () => (await page.locator('iframe[title="临时预览测试"]').boundingBox())?.height ?? 0)
        .toBeGreaterThanOrEqual(viewport.height - 1);
      await page.evaluate(() => document.exitFullscreen());
      await expect(page.locator('.share-topbar')).toBeVisible();
    });

    test('站内弹窗越过等待窗口后不重载，保留输入和地址状态', async ({ page }, testInfo) => {
      const { requests, contentRequests, listRequests } = await serve(page, { shape: 'multi-file', modal: true });
      const iframe = page.getByRole('dialog').locator('iframe');
      const original = await iframe.elementHandle();
      const frame = iframe.contentFrame();
      await expect(frame.locator('#result')).toHaveText('fetch-ok:entry');
      await frame.getByLabel('保留输入').fill('等待结束后仍保留');
      await frame.locator('#state').click();
      const loads = requests.filter(path => path.endsWith('/index.html')).length;
      await page.clock.runFor(1600);
      // 回到标签页会更新活动统计，但不能重新加载任何预览或丢掉输入。
      const refreshCount = listRequests() + 1;
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
        Reflect.deleteProperty(document, 'visibilityState');
      });
      await expect(page.getByLabel(`已编辑 ${refreshCount} 次`, { exact: true })).toBeAttached();

      expect(await original!.evaluate(element => element.isConnected)).toBe(true);
      await expect(frame.getByLabel('保留输入')).toHaveValue('等待结束后仍保留');
      expect(await frame.locator('body').evaluate(() => location.href)).toContain('?case=changed#step');
      expect(requests.filter(path => path.endsWith('/index.html'))).toHaveLength(loads);
      expect(contentRequests()).toBe(0);
      await page.screenshot({ path: testInfo.outputPath('native-modal-state.png') });
    });

    test('多文件 URL、嵌套页面、模块、fetch、资源及隔离均保持浏览器语义', async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const { frame, requests, contentRequests } = await serve(page, { shape: 'multi-file' });
      await expect(frame.locator('#result')).toHaveText('fetch-ok:entry');
      await expect(frame.locator('body')).toHaveAttribute('data-child', 'ready');
      await expect(frame.locator('body')).toHaveAttribute('data-module', 'ready');
      await expect(frame.locator('body')).toHaveAttribute('data-storage', 'ok');
      await expect(frame.locator('body')).toHaveAttribute('data-isolation', 'ok');
      await expect(page.locator('body')).not.toHaveAttribute('data-compromised');
      await expect(frame.locator('h1')).toHaveCSS('color', 'rgb(12, 99, 33)');
      await expect(frame.getByAltText('中文资源')).toHaveJSProperty('naturalWidth', 20);
      await expect(frame.frameLocator('#child').locator('#query')).toHaveText('child');
      await expect(frame.frameLocator('#child').frameLocator('iframe').locator('h1')).toHaveText('第三层页面');
      expect(contentRequests()).toBe(0);
      expect(requests.every(path => path.startsWith('/sites/qa/nested/'))).toBe(true);
      await frame.getByLabel('保留输入').fill('保留已输入的内容');
      await frame.locator('#state').click();
      await expect(frame.getByLabel('保留输入')).toHaveValue('保留已输入的内容');
      expect(await frame.locator('body').evaluate(() => location.href)).toContain('?case=changed#step');
      await page.screenshot({ path: testInfo.outputPath('native-preview.png') });
      await frame.locator('#next').click();
      await expect(frame.locator('#query')).toHaveText('next');
      expect(errors).toEqual([]);
    });

    test('同源托管地址也不能读取或修改后台父页面', async ({ page }) => {
      const nativeHtml = '<html><body><p id="isolation">pending</p><script>try { parent.document.body.dataset.compromised="yes"; } catch { document.querySelector("#isolation").textContent="blocked"; }</script></body></html>';
      const { frame } = await serve(page, { shape: 'multi-file', sameOrigin: true, nativeHtml });
      await expect(frame.locator('#isolation')).toHaveText('blocked');
      await expect(page.locator('body')).not.toHaveAttribute('data-compromised');
    });

    for (const wrapper of ['pdf', 'video']) {
      test(`${wrapper} 包装页不等待版本记录，仍可打开向我提问`, async ({ page }) => {
        await serve(page, { shape: 'multi-file', wrapper, ask: true });
        await page.getByRole('button', { name: '向我提问', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '向我提问', exact: true })).toBeVisible();
        await expect(page.getByRole('textbox', { name: '就这一页提个问题', exact: true })).toBeVisible();
      });
    }

    test('PDF 课程保留真实点击下载，未登记附件仍被拒绝', async ({ page }) => {
      const html = '<html><body><a href="lesson.pdf">下载课件</a><a href="missing.pdf">未登记课件</a></body></html>';
      const { frame } = await serve(page, { shape: 'multi-file', pdfFilePaths: ['lesson.pdf'], html });
      const downloaded = page.waitForEvent('download');
      await frame.getByText('下载课件', { exact: true }).click();
      expect((await downloaded).suggestedFilename()).toBe('lesson.pdf');
      await frame.getByText('未登记课件').click();
      await expect(frame.getByRole('alert')).toContainText('未登记');
    });

    test('完整教程包保留下载桥并在清单缺失时给出失败提示', async ({ page }) => {
      const html = '<html><body><button data-download-package>下载完整教程包</button><p data-package-status></p></body></html>';
      const { frame } = await serve(page, { shape: 'multi-file', requiresPreviewBridge: true, html });
      await frame.getByRole('button', { name: '下载完整教程包' }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(frame.locator('[data-package-status]')).not.toHaveText('');
      await expect(frame.getByRole('button', { name: '下载完整教程包' })).toBeEnabled();
    });

    for (const legacy of [
      { label: '旧接口缺少分类', shape: undefined, wrapper: undefined },
      { label: '带系统附属文件的自包含站', shape: 'self-contained-html', wrapper: undefined },
      { label: 'Markdown 包装站', shape: 'multi-file', wrapper: 'markdown' },
    ]) {
      test(`${legacy.label}保留内联预览和页内锚点`, async ({ page }) => {
        const html = '<!doctype html><html><body><h1>旧站点正文</h1><a href="#end">到结尾</a><section id="end">结尾</section></body></html>';
        const { frame, requests, contentRequests } = await serve(page, { ...legacy, html });
        await expect(frame.locator('h1')).toHaveText('旧站点正文');
        expect(await frame.locator('body').evaluate(() => location.href)).toBe('about:srcdoc');
        await frame.getByText('到结尾').click();
        await expect(frame.locator('#end')).toBeVisible();
        expect(requests).toEqual([]);
        expect(contentRequests()).toBeGreaterThan(0);
      });
    }
  });
}


test.describe('长文批注连续跟随与菜单外点', () => {
  const title = '长文批注跟随样例';
  const content = '这是一条需要保留完整内容的长意见。'.repeat(3000);
  const html = `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:16px/1.7 system-ui}main{padding:32px}p{margin:12px 0}</style><main><h1>${title}</h1><p id="note-one">定位段落一</p><p id="note-two">定位段落二</p>${'<p>长文压力段落，滚动时不应遍历全部正文寻找位置。</p>'.repeat(10000)}</main></html>`;
  async function open(page: Page, dense = false) {
    const site = { id: 'qa-follow', title, siteUrl: 'https://hosting.example/sites/qa-follow/index.html?v=20000', entryFile: 'index.html', contentShape: 'self-contained-html', viewerCanEdit: false, totalSize: html.length, fileCount: 1, files: [], tags: [] };
    const version = { id: 'v2', siteId: site.id, versionLabel: 'V2', contentVersionKey: '20000', isCurrent: true, canPreview: true, entryFile: site.entryFile, siteUrl: site.siteUrl, contentShape: site.contentShape };
    const names = dense ? ['one', ...Array.from({ length: 8 }, (_, index) => 'dense-' + index)] : ['one', 'two'];
    const comments = names.map((name, index) => ({ id: name, siteId: site.id, revisionId: 'v2', contentVersion: '20000', authorName: '复验作者', content, createdAt: '2026-11-17T00:00:00Z', anchor: { kind: 'element', pagePath: '/sites/qa-follow/index.html', selector: '#note-' + (dense ? 'one' : name), tagName: 'p', text: '定位段落' + (index + 1), elementText: '定位段落' + (index + 1), prefix: '', suffix: '', contentVersion: '20000' } }));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/annotation-runtime.js')) { await route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../../prd-api/src/PrdAgent.Infrastructure/Services/Assets/hostedAnnotations.js', import.meta.url), 'utf8') }); return; }
      const data = path.endsWith('/shares/view/qa-follow') ? { title, shareType: 'single', sites: [site] }
        : path.endsWith('/content') ? { html }
        : path.endsWith('/comments') ? { siteId: site.id, commentsEnabled: true, canComment: false, comments }
        : path.endsWith('/revisions') ? [version]
        : path.endsWith('/related-documents') ? { version: 1, mainSiteId: site.id, canManage: false, items: [{ id: site.id, title }, { id: 'other', title: '关联样例', href: '/s/wp/other' }] }
        : { items: [], total: 0 };
      await route.fulfill({ json: { success: true, data, error: null } });
    });
    await page.goto('/s/wp/qa-follow');
    const discussion = page.getByRole('button', { name: '批注与讨论', exact: true });
    await expect(discussion).toHaveAttribute('aria-expanded', page.viewportSize()!.width < 768 ? 'false' : 'true');
    if (await discussion.getAttribute('aria-expanded') === 'true') {
      await expect(page.locator('.review-thread')).toHaveCount(comments.length);
      await expect(page.locator('.annotation-chat-bubble')).toHaveCount(0);
      await discussion.click();
    }
    await expect(page.locator('.annotation-chat-bubble')).toHaveCount(comments.length);
    await expect(page.locator('.annotation-chat-bubble').first()).toBeVisible();
    return page.frameLocator(`iframe[title="${title}"]`);
  }
  async function freePoint(page: Page, scrolling = false) {
    const point = await page.locator(`iframe[title="${title}"]`).evaluate((el, scrolling) => {
      const r = el.getBoundingClientRect();
      for (const fx of [.95, .05, .5]) for (const fy of (scrolling ? [.75, .6, .9] : [.08, .3, .6, .9])) { const x = r.left + r.width * fx, y = r.top + r.height * fy; if (document.elementFromPoint(x, y) === el) return { x, y }; }
      return null;
    }, scrolling);
    expect(point).not.toBeNull(); return point!;
  }
  for (const mobile of [false, true]) test.describe(mobile ? '独立触控' : '桌面', () => {
    test.use({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const tap = async (locator: ReturnType<Page['getByRole']>) => mobile ? locator.tap() : locator.click();
    if (!mobile) test('页边宽度不随可见锚点增减，右侧绝对定位内容不触发缩放闪烁', async ({ page }) => {
      await page.setViewportSize({ width: 1000, height: 900 });
      const frame = await open(page);
      await frame.locator('#note-one, #note-two').evaluateAll(elements => elements.forEach((element, index) => {
        Object.assign((element as HTMLElement).style, { position: 'absolute', left: '750px', top: `${100 + index * 160}px`, width: '100px' });
      }));
      await page.waitForTimeout(300);
      const widths: number[] = [];
      for (let sample = 0; sample < 8; sample++) {
        widths.push(await page.locator(`iframe[title="${title}"]`).evaluate(element => element.clientWidth));
        await page.waitForTimeout(100);
      }
      expect(new Set(widths)).toEqual(new Set([700]));
      await expect(page.locator('.annotation-bubble-canvas')).toHaveCount(1);
      await expect(page.locator('.annotation-chat-bubble')).toHaveCount(0);
    });
    if (!mobile) test('同段九条批注在页边互不遮盖，选中连接原文，短视口可滚动阅读', async ({ page }) => {
      const frame = await open(page, true);
      const cards = page.locator('.annotation-chat-bubble');
      const nonoverlapping = () => cards.evaluateAll(elements => elements.every((el, index) => index === 0
        || elements[index - 1].getBoundingClientRect().bottom + 7 <= el.getBoundingClientRect().top));
      await expect.poll(nonoverlapping).toBe(true);
      await expect(page.locator('.annotation-chat-actions')).toHaveCount(0);
      await expect(frame.getByRole('button', { name: /打开批注/ })).toHaveCount(9);
      await frame.getByRole('button', { name: '打开批注 5', exact: true }).click();
      const selected = page.getByRole('dialog', { name: '批注气泡 5', exact: true });
      await expect(selected).toHaveClass(/is-active/);
      await expect.poll(nonoverlapping).toBe(true);
      await expect(page.locator('.annotation-bubble-connectors path')).toHaveCount(1);
      await expect(selected.getByRole('button', { name: '查看讨论' })).toBeVisible();

      await page.setViewportSize({ width: 1440, height: 445 });
      const margin = page.locator('.annotation-bubble-scroll');
      await expect(margin).toHaveAttribute('aria-label', '滚动查看更多页边批注');
      const point = await selected.boundingBox();
      await page.mouse.move(point!.x + point!.width / 2, point!.y + point!.height / 2);
      await page.mouse.wheel(0, 500);
      await expect.poll(() => margin.evaluate(el => el.scrollTop + el.clientHeight)).toBeGreaterThan(570);
      await expect(page.getByRole('button', { name: '展开批注气泡 9', exact: true })).toBeInViewport();
      expect(await frame.locator('body').evaluate(() => window.scrollY)).toBe(0);
    });
    test('图标全隐保留编号，编号重开后全显；菜单外点与iframe点击收起', async ({ page }) => {
      const frame = await open(page);
      await expect(page.getByRole('button', { name: '批注显示方式', exact: true })).toHaveCount(0);
      const viewed = page.locator('[data-bubble-id="one"]');
      await tap(viewed.getByRole('button', { name: '展开批注气泡 1', exact: true }));
      await tap(viewed.getByRole('button', { name: '查看讨论', exact: true }));
      await expect(page.getByRole('button', { name: '批注与讨论', exact: true })).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.annotation-chat-bubble')).toHaveCount(0);
      await tap(page.getByRole('button', { name: '批注与讨论', exact: true }));
      await expect(viewed).toBeVisible();
      await expect(page.locator('.annotation-chat-bubble')).toHaveCount(2);
      await page.screenshot({ path: test.info().outputPath('default-bubble-icons.png') });
      if (mobile) { const r = await page.getByRole('button', { name: '隐藏全部气泡', exact: true }).first().boundingBox(); expect(r!.width).toBeGreaterThanOrEqual(44); expect(r!.height).toBeGreaterThanOrEqual(44); }
      await tap(page.getByRole('button', { name: '隐藏全部气泡', exact: true }).first());
      await expect(page.locator('.annotation-chat-bubble')).toHaveCount(0);
      await expect(frame.getByRole('button', { name: /打开批注/ })).toHaveCount(2);
      await tap(frame.getByRole('button', { name: '打开批注 2', exact: true }));
      await expect(page.locator('.annotation-chat-bubble')).toHaveCount(1);
      await tap(page.getByRole('dialog', { name: '批注气泡 2', exact: true }).getByRole('button', { name: '显示全部气泡', exact: true }));
      await expect(page.locator('.annotation-chat-bubble')).toHaveCount(2);
      const closed = page.locator('[data-bubble-id="one"]'), number = await closed.locator('.annotation-chat-number').innerText();
      const reloadDocument = async () => {
        const boot = await frame.locator('body').evaluate(() => performance.timeOrigin);
        await frame.locator('body').evaluate(() => location.reload());
        await expect.poll(() => frame.locator('body').evaluate(() => performance.timeOrigin)).toBeGreaterThan(boot);
        await expect(frame.getByRole('button', { name: /打开批注/ })).toHaveCount(2);
      };
      for (let round = 0; round < 2; round++) {
        const expand = closed.getByRole('button', { name: /展开批注气泡/ });
        if (await expand.count()) await tap(expand);
        await tap(closed.getByRole('button', { name: /收起批注气泡/ })); await expect(closed).toHaveCount(0);
        await reloadDocument(); await expect(page.locator('.annotation-chat-bubble')).toHaveCount(1); await expect(closed).toHaveCount(0);
        if (round === 0) { await tap(frame.getByRole('button', { name: '打开批注 ' + number, exact: true })); await expect(closed).toBeVisible(); }
      }
      await tap(page.getByRole('button', { name: '显示全部气泡', exact: true }).first()); await expect(page.locator('.annotation-chat-bubble')).toHaveCount(2);
      await tap(page.getByRole('button', { name: '隐藏全部气泡', exact: true }).first());
      for (const menu of ['网页版本：V2', '关联文档']) {
        await tap(page.getByRole('button', { name: menu, exact: true })); await expect(page.getByRole('button', { name: menu, exact: true })).toHaveAttribute('aria-expanded', 'true');
        await tap(page.getByRole('button', { name: '批注与讨论', exact: true })); await expect(page.getByRole('button', { name: menu, exact: true })).toHaveAttribute('aria-expanded', 'false');
        const commentsButton = page.getByRole('button', { name: '批注与讨论', exact: true });
        if (await commentsButton.getAttribute('aria-expanded') === 'true') await tap(commentsButton);
        await tap(page.getByRole('button', { name: menu, exact: true }));
        const point = await freePoint(page); if (mobile) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
        await expect(page.getByRole('button', { name: menu, exact: true })).toHaveAttribute('aria-expanded', 'false');
        if (menu === '网页版本：V2') {
        await tap(page.getByRole('button', { name: menu, exact: true }));
        await tap(frame.getByRole('button', { name: '打开批注 1', exact: true }));
        await expect(page.getByRole('button', { name: menu, exact: true })).toHaveAttribute('aria-expanded', 'false');
        await tap(page.getByRole('button', { name: '显示全部气泡', exact: true }).first());
        await tap(page.getByRole('button', { name: '隐藏全部气泡', exact: true }).first());
        }
      }
    });
    test('一万段长文连续跟随、节点不重建、无全文查询，长意见默认渲染有界', async ({ page, context }) => {
      const frame = await open(page), card = page.locator('[data-bubble-id="one"]');
      await expect.poll(() => frame.locator('body').evaluate(() => document.readyState)).toBe('complete');
      expect(await card.locator('p').innerText()).toHaveLength(281);
      expect((await page.locator('.review-message-body').first().textContent())!.length).toBeLessThanOrEqual(281);
      // 先把跟踪气泡挪到阅读区内部，避免边缘限位改变本用例的位移期望。
      const grip = await card.getByRole('button', { name: /移动批注气泡/ }).boundingBox(); expect(grip).not.toBeNull();
      if (mobile) {
        const cdp = await context.newCDPSession(page), x = grip!.x + grip!.width / 2, y = grip!.y + grip!.height / 2;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 160 * i / 10 }] }); await page.waitForTimeout(16); }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
      } else { await page.mouse.move(grip!.x + 5, grip!.y + 5); await page.mouse.down(); await page.mouse.move(grip!.x + 5, grip!.y + 165, { steps: 10 }); await page.mouse.up(); }
      const before = await card.boundingBox(); expect(before).not.toBeNull();
      await page.evaluate(() => {
        const w = window as typeof window & { __followCard?: Element | null; __followMessages?: number };
        w.__followCard = document.querySelector('[data-bubble-id="one"]'); w.__followMessages = 0;
        window.addEventListener('message', e => { if (e.data?.type === 'map-annotation-previews') w.__followMessages!++; });
      });
      await frame.locator('body').evaluate(() => {
        const w = window as typeof window & { __followReads?: { scans: number; rects: number } }; w.__followReads = { scans: 0, rects: 0 };
        const query = document.querySelectorAll.bind(document); document.querySelectorAll = ((...args: Parameters<typeof query>) => { w.__followReads!.scans++; return query(...args); }) as typeof document.querySelectorAll;
        const rect = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function () { w.__followReads!.rects++; return rect.call(this); };
      });
      const point = await freePoint(page, true);
      if (mobile) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - 100 * i / 12 }] }); await page.waitForTimeout(16); }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
      }
      else { await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, 40); }
      await expect.poll(() => frame.locator('body').evaluate(() => scrollY)).toBeGreaterThan(0);
      await expect.poll(async () => {
        const y = await frame.locator('body').evaluate(() => scrollY), current = await card.boundingBox(); return Math.abs(before!.y - current!.y - y);
      }).toBeLessThan(2);
      expect(await card.evaluate(el => el === (window as typeof window & { __followCard?: Element }).__followCard)).toBe(true);
      const reads = await frame.locator('body').evaluate(() => (window as typeof window & { __followReads?: { scans: number; rects: number } }).__followReads!);
      const messages = await page.evaluate(() => (window as typeof window & { __followMessages?: number }).__followMessages!);
      expect(reads.scans).toBe(0); expect(reads.rects).toBeLessThanOrEqual((messages + 3) * 60);
      const commentsButton = page.getByRole('button', { name: '批注与讨论', exact: true });
      if (await commentsButton.getAttribute('aria-expanded') !== 'true') await tap(commentsButton);
      {
        await tap(page.getByRole('button', { name: '展开全文', exact: true }).first());
        expect(await page.locator('.review-message-body').first().textContent()).toBe(content);
        await tap(page.getByRole('button', { name: '收起全文', exact: true }).first());
      }
      const budgetPath = test.info().outputPath('scroll-budget.json');
      await writeFile(budgetPath, JSON.stringify({ paragraphs: 10000, commentCharacters: content.length, ...reads, messages }));
      await test.info().attach('长文滚动预算', { path: budgetPath, contentType: 'application/json' });
    });
  });
});
