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

async function serve(page: Page, options: { shape?: string; wrapper?: string; html?: string; staleArchiveShape?: boolean;
  pdfFilePaths?: string[]; requiresPreviewBridge?: boolean; sameOrigin?: boolean; nativeHtml?: string; modal?: boolean; inlineHistory?: boolean; extraHistory?: boolean; unarchivedHistory?: boolean; multiFileHistory?: boolean; metadataLag?: boolean; ask?: boolean } = {}) {
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
    const currentVersion = { id: 'current', siteId: site.id, versionLabel: 'V2', contentVersionKey: options.metadataLag ? '10000' : '20000', isCurrent: true, canPreview: true, siteUrl: siteEntry, entryFile: 'index.html', contentShape: options.staleArchiveShape ? 'multi-file' : 'self-contained-html' };
    const inlineVersion = { ...currentVersion, id: 'inline-history', versionLabel: 'V1', contentVersionKey: '10000', isCurrent: false, siteUrl: options.multiFileHistory ? siteEntry : null, contentShape: options.multiFileHistory ? 'multi-file' : 'self-contained-html' };
    const olderVersion = { ...inlineVersion, id: 'earlier-history', versionLabel: 'V0', contentVersionKey: '5000', canPreview: !options.unarchivedHistory };
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
      data = { siteId: site.id, commentsEnabled: true, canComment: !!options.inlineHistory, comments: [
        ...(options.extraHistory || options.unarchivedHistory ? [{
          id: 'inline-history-note', revisionId: inlineVersion.id, contentVersion: inlineVersion.contentVersionKey,
          authorName: '复验作者', content: '旧版意见与正文同时可读', createdAt: '2026-11-02T00:00:00Z',
          anchor: options.extraHistory ? {
            kind: 'element', selector: '#old-heading', pagePath: new URL(siteEntry).pathname, tagName: 'h1',
            text: '仅保留 HTML 的旧版正文', elementText: '仅保留 HTML 的旧版正文', prefix: '', suffix: '',
            contentVersion: inlineVersion.contentVersionKey,
          } : null,
        }] : []),
        ...(options.unarchivedHistory ? [{
          id: 'unarchived-history-note', revisionId: olderVersion.id, contentVersion: olderVersion.contentVersionKey,
          authorName: '复验作者', content: '原文未归档也可以阅读当时的意见', createdAt: '2026-11-01T00:00:00Z',
        }] : []),
      ] };
    } else if (path.endsWith('/revisions')) {
      if (options.metadataLag) await metadataGate;
      data = options.inlineHistory ? [currentVersion, inlineVersion, ...(options.extraHistory || options.unarchivedHistory ? [olderVersion] : [])] : options.metadataLag ? [currentVersion] : [];
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
      const { frame } = await serve(page, { modal: true, inlineHistory: true, extraHistory: true, shape: 'self-contained-html', html: '<h1>当前版正文</h1><input aria-label="当前页草稿"><div style="height:1800px"></div>' });
      const liveInput = frame.getByRole('textbox', { name: '当前页草稿' });
      await liveInput.fill('切回时保留原输入');
      const liveDocument = frame.locator('html');
      await liveDocument.evaluate(() => window.scrollTo(0, 400));
      const version = page.getByRole('button', { name: '网页版本：V2', exact: true });
      await version.click();
      const first = page.getByRole('dialog', { name: '历史版本', exact: true });
      await expect(first.frameLocator('iframe').getByRole('heading', { name: '仅保留 HTML 的旧版正文' })).toBeVisible();
      await expect(first.getByText(/旧版意见与正文同时可读/)).toBeVisible();
      const documentBox = await first.locator('iframe').boundingBox();
      const commentsBox = await first.getByRole('region', { name: 'V1 的意见' }).boundingBox();
      expect(documentBox && commentsBox && (documentBox.x + documentBox.width <= commentsBox.x + 1 || documentBox.y + documentBox.height <= commentsBox.y + 1)).toBeTruthy();
      await expect(first.locator('.annotation-chat-bubble')).toHaveCount(0);
      await first.frameLocator('iframe').getByRole('button', { name: '打开批注 1' }).click();
      await expect(first.locator('[data-review-history-thread="inline-history-note"]')).toHaveAttribute('aria-current', 'true');
      if (viewport.width > 768) {
        const header = first.locator('.review-history-window-header');
        const box = (await header.boundingBox())!;
        await page.mouse.move(box.x + 180, box.y + 16);
        await page.mouse.down();
        await page.mouse.move(box.x + 222, box.y + 43, { steps: 5 });
        await page.mouse.up();
        const moved = (await header.boundingBox())!;
        expect(moved.x - box.x).toBe(42);
        expect(moved.y - box.y).toBe(27);
      }
      const dialogElement = await first.elementHandle();
      await first.getByRole('button', { name: '恢复此版本', exact: true }).click();
      await first.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
      await first.getByRole('navigation', { name: '历史版本列表' }).getByRole('button', { name: /^V0/ }).click();
      const second = page.getByRole('dialog', { name: '历史版本', exact: true });
      await expect(second.frameLocator('iframe').getByRole('heading', { name: '更早的 V0 正文' })).toBeVisible();
      expect(await dialogElement!.evaluate(element => element.isConnected)).toBe(true);
      await expect(second.getByRole('button', { name: /^确认恢复并发布/ })).toHaveCount(0);
      await expect(second.getByRole('button', { name: '恢复此版本', exact: true })).toBeVisible();
      await second.getByRole('button', { name: '返回', exact: true }).click();
      await expect(frame.getByRole('heading', { name: '当前版正文' })).toBeVisible();
      expect(await liveDocument.evaluate(() => window.scrollY)).toBe(400);
      await expect(liveInput).toHaveValue('切回时保留原输入');
      await expect(version).toBeFocused();
    });

    test('历史小窗隔离之前上传错误，恢复失败保留可操作提示', async ({ page }) => {
      await serve(page, { modal: true, inlineHistory: true, shape: 'self-contained-html', html: '<h1>当前版正文</h1>' });
      await page.route('**/api/web-pages/qa-native/reupload', route => route.fulfill({ json: { success: false, data: null, error: { code: 'TEST_UPLOAD', message: '上传失败，请重新上传' } } }));
      await page.route('**/api/web-pages/qa-native/edits/revisions/inline-history/rollback', route => route.fulfill({ json: { success: false, data: null, error: { code: 'VERSION_CONFLICT', message: '版本已更新，请核对后重试恢复' } } }));
      await page.getByLabel('上传新版本文件', { exact: true }).setInputFiles({ name: 'new.html', mimeType: 'text/html', buffer: Buffer.from('<h1>新版</h1>') });
      await expect(page.getByRole('alert').filter({ hasText: '上传失败，请重新上传' })).toBeVisible();
      await page.getByRole('button', { name: '网页版本：V2', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '历史版本', exact: true });
      await expect(dialog.frameLocator('iframe').getByRole('heading', { name: '仅保留 HTML 的旧版正文' })).toBeVisible();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      const selecting = page.waitForEvent('filechooser');
      await dialog.getByRole('button', { name: '上传新版本', exact: true }).click();
      await (await selecting).setFiles({ name: 'history-upload.html', mimeType: 'text/html', buffer: Buffer.from('<h1>新版</h1>') });
      await expect(dialog.getByRole('alert')).toHaveText('上传失败，请重新上传');
      await dialog.getByRole('button', { name: '恢复此版本', exact: true }).click();
      const confirmRestore = dialog.getByRole('button', { name: /^确认恢复并发布/ });
      const confirmBox = await confirmRestore.boundingBox();
      expect(confirmBox!.width).toBeGreaterThan(100);
      expect(confirmBox!.height).toBeLessThanOrEqual(48);
      expect(await confirmRestore.evaluate(button => button.scrollWidth <= button.clientWidth)).toBe(true);
      await confirmRestore.click();
      await expect(dialog.getByRole('alert')).toHaveText('版本已更新，请核对后重试恢复');
      await dialog.screenshot({ path: test.info().outputPath('restore-confirm.png') });
      await expect(page.locator('iframe[title="临时预览测试"]').contentFrame().getByRole('heading', { name: '当前版正文' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog.getByRole('alertdialog')).toHaveCount(0);
      await dialog.getByRole('button', { name: '关闭历史版本', exact: true }).click();
      await page.getByRole('button', { name: '网页版本：V2', exact: true }).click();
      await expect(dialog.frameLocator('iframe').getByRole('heading', { name: '仅保留 HTML 的旧版正文' })).toBeVisible();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
    });

    for (const modal of [false, true]) {
      test(`${modal ? '站内' : '分享'}的无直链历史正文保持内联与只读预览`, async ({ page }) => {
        const { frame, preview } = await serve(page, { modal, inlineHistory: true, shape: 'self-contained-html', html: '<h1>当前版正文</h1>' });
        await expect(frame.getByRole('heading', { name: '当前版正文' })).toBeVisible();
        await page.getByRole('button', { name: '网页版本：V2', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '历史版本', exact: true });
        const historical = dialog.locator('iframe');
        const historicalFrame = historical.contentFrame();
        await expect(historicalFrame.getByRole('heading', { name: '仅保留 HTML 的旧版正文' })).toBeVisible();
        await expect(frame.getByRole('heading', { name: '当前版正文' })).toBeVisible();
        await expect(preview).toHaveAttribute('srcdoc', /当前版正文/);
        await expect.poll(() => historicalFrame.locator('base').getAttribute('href')).toBe(new URL('.', entry).href);
        expect((await historical.getAttribute('sandbox'))?.split(' ')).not.toContain('allow-same-origin');
        await expect(dialog.getByRole('button', { name: '绑定页面元素 / 选中文字', exact: true })).toHaveCount(0);
        await expect(dialog.getByRole('textbox')).toHaveCount(0);
        await expect(historical).toHaveAttribute('srcdoc', /仅保留 HTML 的旧版正文/);
        await expect(historicalFrame.locator('script[data-map-pdf-download-bridge], script[data-map-package-download-bridge]')).toHaveCount(0);
        expect(new URL(page.url()).pathname).toBe(modal ? '/web-pages' : '/s/wp/qa-native');

      });
    }

    for (const modal of [false, true]) {
      test(`${modal ? '站内' : '分享'}的历史多文件版本保留真实来源与同源 fetch`, async ({ page }) => {
        const { frame } = await serve(page, { modal, inlineHistory: true, multiFileHistory: true, shape: 'multi-file' });
        await page.getByRole('button', { name: '网页版本：V2', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '历史版本', exact: true });
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
      const dialog = page.getByRole('dialog', { name: '历史版本', exact: true });
      await expect(dialog.getByRole('button', { name: '重试', exact: true })).toBeVisible();
      await expect(dialog.getByRole('alert')).toContainText('V1 载入失败');
      await expect(dialog.getByRole('region', { name: 'V1 的意见' })).toHaveCount(0);
      await expect(dialog.locator('iframe')).toHaveCount(0);
      await expect(frame.getByRole('heading', { name: '当前版正文' })).toBeVisible();
      failSnapshot = false;
      await dialog.getByRole('button', { name: '重试', exact: true }).click();
      await expect(dialog.locator('iframe').contentFrame().getByRole('heading', { name: '仅保留 HTML 的旧版正文' })).toBeVisible();
      await expect(dialog.getByRole('region', { name: 'V1 的意见' })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/web-pages');
    });

    test('历史小窗的原文未归档版本仍可阅读独立意见，不请求或恢复旧原文', async ({ page }) => {
      const { frame } = await serve(page, { modal: true, inlineHistory: true, unarchivedHistory: true, shape: 'self-contained-html', html: '<h1>当前版正文</h1>' });
      const unavailable = page.waitForRequest('**/revisions/earlier-history/preview', { timeout: 1500 }).then(() => true, () => false);
      await page.getByRole('button', { name: '网页版本：V2', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '历史版本', exact: true });
      const list = dialog.getByRole('navigation', { name: '历史版本列表' });
      await list.getByRole('button', { name: /^V0 原文未归档/ }).click();
      const opinions = dialog.getByRole('region', { name: 'V0 的意见' });
      await expect(opinions.getByText(/原文未归档也可以阅读当时的意见/)).toBeVisible();
      await expect(opinions.getByText(/旧版意见与正文同时可读/)).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '恢复此版本', exact: true })).toHaveCount(0);
      await expect(dialog.locator('iframe')).toHaveCount(0);
      await expect(frame.getByRole('heading', { name: '当前版正文' })).toBeVisible();
      await list.getByRole('button', { name: /^V1/ }).click();
      await expect(dialog.frameLocator('iframe').getByRole('heading', { name: '仅保留 HTML 的旧版正文' })).toBeVisible();
      await expect(dialog.getByRole('region', { name: 'V1 的意见' }).getByText(/旧版意见与正文同时可读/)).toBeVisible();
      expect(await unavailable).toBe(false);
    });

    test('站内当前版保留输入，不因旧版本记录响应而跳到空白文档', async ({ page }) => {
      const { frame, preview, releaseVersions } = await serve(page, { modal: true, shape: 'multi-file', metadataLag: true });
      await expect(frame.locator('#result')).toHaveText('fetch-ok:entry');
      await frame.getByLabel('保留输入').fill('等待版本记录时保留');
      const tab = page.getByRole('tab', { name: /^讨论/ });
      const toggle = page.getByRole('dialog').getByRole('button', { name: '批注与讨论', exact: true });
      if (await tab.isVisible()) await tab.click();
      else if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
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
      const tab = page.getByRole('tab', { name: /^讨论/ });
      const toggle = page.getByRole('button', { name: '批注与讨论', exact: true });
      if (await tab.isVisible()) await tab.click();
      else if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
      await expect(page.locator('aside.review-sidebar')).toBeVisible();
      await page.getByRole('button', { name: '更多', exact: true }).click();
      await page.getByRole('menuitem', { name: '全屏演示', exact: true }).click();
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

    test('恢复旧网页后以当前正文的内容类型加载新版批注', async ({ page }) => {
      const html = '<h1>恢复后正文</h1><script data-map-annotations="v1">document.body.dataset.obsoleteRuntime = "1";</script>';
      const { frame, preview, requests } = await serve(page, {
        shape: 'self-contained-html', staleArchiveShape: true, inlineHistory: true, html, nativeHtml: html,
      });
      await expect(frame.getByRole('heading', { name: '恢复后正文' })).toBeVisible();
      await expect(preview).toHaveAttribute('srcdoc', /annotation-runtime\.js/);
      await expect(frame.locator('[data-map-annotation-layer]')).toHaveAttribute('data-dual-column', '');
      await expect(frame.locator('[data-obsolete-runtime]')).toHaveCount(0);
      expect(requests).toEqual([]);
    });
  });
}


test.describe('长文批注连续跟随与菜单外点', () => {
  const title = '长文批注跟随样例';
  const content = '这是一条需要保留完整内容的长意见。'.repeat(3000);
  const html = `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:16px/1.7 system-ui}main{padding:32px}p{margin:12px 0}</style><main><h1>${title}</h1><p id="note-one">定位段落一</p><p id="note-two">定位段落二</p>${'<p>长文压力段落，滚动时不应遍历全部正文寻找位置。</p>'.repeat(10000)}</main></html>`;
  async function open(page: Page, denseCount = 0, compactRange = false, authors?: string[]) {
    const sourceHtml = compactRange
      ? '<meta name="viewport" content="width=device-width,initial-scale=1"><p id="note-one" style="margin:22px 42px 0 16px;font:16px/20px sans-serif">上一行' + '文字'.repeat(8) + '<br>批注目标' + '继续'.repeat(7) + '</p>'
      : html;
    const site = { id: 'qa-follow', title, siteUrl: 'https://hosting.example/sites/qa-follow/index.html?v=20000', entryFile: 'index.html', contentShape: 'self-contained-html', viewerCanEdit: false, totalSize: sourceHtml.length, fileCount: 1, files: [], tags: [] };
    const version = { id: 'v2', siteId: site.id, versionLabel: 'V2', contentVersionKey: '20000', isCurrent: true, canPreview: true, entryFile: site.entryFile, siteUrl: site.siteUrl, contentShape: site.contentShape };
    const names = denseCount ? ['one', ...Array.from({ length: denseCount - 1 }, (_, index) => 'dense-' + index)] : ['one', 'two'];
    const comments = names.map((name, index) => ({ id: name, siteId: site.id, revisionId: 'v2', contentVersion: '20000',
      authorUserId: authors?.[index], authorName: authors?.[index] ?? '复验作者', content, createdAt: new Date(Date.UTC(2026, 10, 17, 0, index)).toISOString(),
      anchor: { kind: compactRange ? 'text' : 'element', pagePath: '/sites/qa-follow/index.html', selector: '#note-' + (denseCount ? 'one' : name), tagName: 'p', text: compactRange ? '批注目标' : '定位段落' + (index + 1), elementText: '定位段落' + (index + 1), prefix: '', suffix: '', contentVersion: '20000' } }));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/annotation-runtime.js')) { await route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../../prd-api/src/PrdAgent.Infrastructure/Services/Assets/hostedAnnotations.js', import.meta.url), 'utf8') }); return; }
      const data = path.endsWith('/shares/view/qa-follow') ? { title, shareType: 'single', sites: [site] }
        : path.endsWith('/content') ? { html: sourceHtml }
        : path.endsWith('/comments') ? { siteId: site.id, commentsEnabled: true, canComment: false, comments }
        : path.endsWith('/revisions') ? [version]
        : path.endsWith('/related-documents') ? { version: 1, mainSiteId: site.id, canManage: false, items: [{ id: site.id, title }, { id: 'other', title: '关联样例', href: '/s/wp/other' }] }
        : { items: [], total: 0 };
      await route.fulfill({ json: { success: true, data, error: null } });
    });
    await page.goto('/s/wp/qa-follow');
    const discussion = page.getByRole('button', { name: '批注与讨论', exact: true });
    if (page.viewportSize()!.width < 768) {
      await expect(page.getByRole('tab', { name: '正文', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.annotation-mobile-dock, .annotation-chat-bubble')).toHaveCount(0);
    } else {
      if (page.viewportSize()!.width >= 1024) {
        await expect(discussion).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('.review-thread')).toHaveCount(comments.length);
        await expect(page.locator('.annotation-chat-bubble')).toHaveCount(0);
        await discussion.click();
      }
      await expect(page.locator('.annotation-chat-bubble')).toHaveCount(comments.length);
    }
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
    test.use({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile,
      contextOptions: { reducedMotion: 'reduce' } });
    const tap = async (locator: ReturnType<Page['getByRole']>) => mobile ? locator.tap() : locator.click();
    if (!mobile) test('折叠正文时不留下选区或气泡，点讨论引用可展开并恢复对应标注', async ({ page }) => {
      const frame = await open(page, 1, true);
      const pin = frame.getByRole('button', { name: '打开批注 1', exact: true });
      await expect(pin).toBeVisible();
      await frame.locator('#note-one').evaluate(paragraph => {
        const details = document.createElement('details');
        const title = document.createElement('summary');
        title.textContent = '折叠区';
        paragraph.before(details); details.append(title, paragraph);
      });
      await expect(pin).toHaveCount(0);
      await expect(frame.locator('[data-map-annotation-layer] .highlight:not([hidden])')).toHaveCount(0);
      await expect(page.locator('.annotation-chat-bubble')).toHaveCount(0);
      await page.getByRole('button', { name: '批注与讨论', exact: true }).click();
      await page.locator('.review-anchor-quote').click();
      await expect(frame.locator('details')).toHaveJSProperty('open', true);
      await expect(pin).toBeVisible();
      await frame.getByText('折叠区', { exact: true }).click();
      await expect(pin).toHaveCount(0);
      await expect(frame.locator('[data-map-annotation-layer] .highlight:not([hidden])')).toHaveCount(0);
    });
    if (!mobile) test('两位作者的笔色在正文、气泡和连线成组，深浅主题均可辨识', async ({ page }, testInfo) => {
      await page.addInitScript(() => { localStorage.setItem('map-mobile-theme-v2', JSON.stringify({ state: { mode: 'system' }, version: 0 })); });
      const frame = await open(page, 0, false, ['林岚', '周岐']);
      await expect(frame.getByRole('button', { name: '打开批注 1', exact: true })).not.toHaveAttribute('data-pen', '');
      const secondPin = frame.getByRole('button', { name: '打开批注 2', exact: true });
      await expect(secondPin).toHaveAttribute('data-pen', '');
      const theme = page.locator('.review-workbench');
      for (const mode of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: mode });
        await expect(theme).toHaveAttribute('data-theme', mode);
        const first = page.locator('[data-bubble-id="one"] .annotation-chat-number');
        const second = page.locator('[data-bubble-id="two"] .annotation-chat-number');
        const blue = mode === 'light' ? 'rgb(201, 218, 248)' : 'rgb(29, 53, 93)';
        await expect(second).toHaveCSS('background-color', blue);
        await expect(first).not.toHaveCSS('background-color', blue);
        await page.screenshot({ path: testInfo.outputPath(`author-pens-${mode}.png`) });
      }
      await secondPin.click();
      await expect(page.locator('[data-active-connector]')).toHaveAttribute('data-pen', '218');
      await expect(page.getByRole('dialog', { name: '批注气泡 2' })).toHaveAttribute('data-pen', '218');
    });
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
      const frame = await open(page, 9);
      const cards = page.locator('.annotation-chat-bubble');
      const nonoverlapping = () => cards.evaluateAll(elements => elements.every((el, index) => index === 0
        || elements[index - 1].getBoundingClientRect().bottom + 7 <= el.getBoundingClientRect().top));
      await expect.poll(nonoverlapping).toBe(true);
      await expect(page.locator('.annotation-chat-actions')).toHaveCount(0);
      const pins = frame.getByRole('button', { name: /打开批注/ });
      await expect(pins).toHaveCount(9);
      const firstPin = await pins.first().boundingBox();
      expect(firstPin).not.toBeNull();
      await expect.poll(() => Promise.all(Array.from({ length: 9 }, (_, index) => pins.nth(index).boundingBox()))
        .then(boxes => boxes.every(box => box && box.x <= firstPin!.x + 1))).toBe(true);
      await expect(frame.locator('[data-map-annotation-layer] .outline:not([hidden])')).toHaveCount(1);
      await frame.getByRole('button', { name: '打开批注 5', exact: true }).click();
      const selected = page.getByRole('dialog', { name: '批注气泡 5', exact: true });
      await expect(selected).toHaveClass(/is-active/);
      await expect.poll(nonoverlapping).toBe(true);
      await expect(page.locator('.annotation-bubble-connectors path')).toHaveCount(1);
      await expect(selected.getByRole('button', { name: '查看讨论' })).toBeVisible();

      await page.setViewportSize({ width: 1440, height: 445 });
      const margin = page.locator('.annotation-bubble-scroll');
      await expect(margin).toHaveAttribute('aria-label', '滚动查看更多页边批注');
      await expect(selected).toBeInViewport({ ratio: .6 });
      await margin.focus();
      await page.keyboard.press('Home');
      await expect(page.getByRole('button', { name: '展开批注气泡 1', exact: true })).toBeInViewport();
      await page.keyboard.press('End');
      await expect(page.getByRole('button', { name: '展开批注气泡 9', exact: true })).toBeInViewport();
      expect(await frame.locator('body').evaluate(() => window.scrollY)).toBe(0);
      expect(await margin.evaluate(el => el.scrollTop)).toBe(0);
    });
    if (!mobile) test('点正文编号不改阅读位置，卡片仅点选时过渡，页边滚轮跟正文', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const frame = await open(page, 9);
      const marker = (number: number) => frame.getByRole('button', { name: '打开批注 ' + number, exact: true });
      const margin = page.locator('.annotation-bubble-scroll');
      const documentTop = () => frame.locator('body').evaluate(() => scrollY);
      const anchor = frame.locator('#note-one');
      const railTop = await margin.evaluate(el => el.scrollTop);
      const initialMarker = (await marker(5).boundingBox())!;
      await anchor.evaluate(el => { (el as HTMLElement).style.marginTop = '145px'; });
      await expect.poll(async () => (await marker(5).boundingBox())?.y ?? 0).toBeGreaterThan(initialMarker.y + 100);
      const first = await documentTop();
      await marker(5).click();
      const selected = page.getByRole('dialog', { name: '批注气泡 5', exact: true });
      await expect(selected).toBeVisible();
      await expect(margin.locator('.annotation-bubble-space')).toHaveCSS('transition-property', 'none');
      await expect(margin.locator('[data-active-connector] path')).toHaveCSS('transition-property', 'none');
      await expect.poll(() => margin.evaluate(el => el.getAnimations({ subtree: true }).some(animation => animation.playState === 'running'))).toBe(true);
      await expect.poll(() => margin.evaluate(el => el.getAnimations({ subtree: true }).some(animation => animation.playState === 'running'))).toBe(false);
      expect(await documentTop()).toBe(first);
      expect(await margin.evaluate(el => el.scrollTop)).toBe(railTop);
      await expect.poll(async () => Math.abs((await selected.boundingBox())!.y - (await anchor.boundingBox())!.y)).toBeLessThan(2);
      const connector = margin.locator('[data-active-connector] circle');
      const [cx, cy] = await connector.evaluate(el => [Number(el.getAttribute('cx')), Number(el.getAttribute('cy'))]);
      const [origin, bubble] = await Promise.all([margin.boundingBox(), selected.boundingBox()]);
      expect(Math.abs(cx + origin!.x - bubble!.x)).toBeLessThan(1);
      expect(cy + origin!.y).toBeGreaterThan(bubble!.y + 6);
      expect(cy + origin!.y).toBeLessThan(bubble!.y + bubble!.height - 6);
      await selected.getByRole('button', { name: /^展开全文/ }).click();
      const longText = selected.locator('.annotation-chat-full');
      await expect(longText).toBeInViewport();
      const textBox = (await longText.boundingBox())!;
      await page.mouse.move(textBox.x + 20, textBox.y + 20);
      await page.mouse.wheel(0, 60);
      await expect.poll(() => longText.evaluate(el => el.scrollTop)).toBeGreaterThan(40);
      expect(await documentTop()).toBe(first);
      await selected.getByRole('button', { name: '收起全文', exact: true }).click();
      await expect(selected).toBeInViewport({ ratio: .6 });
      const point = (await selected.boundingBox())!;
      const y = Math.min(point.y + 24, page.viewportSize()!.height - 20);
      const marginTop = await margin.evaluate(el => el.scrollTop);
      await page.mouse.move(point.x + 36, y);
      await page.mouse.wheel(0, 70);
      await expect.poll(documentTop).toBeGreaterThan(first + 60);
      expect(await margin.evaluate(el => el.scrollTop)).toBe(marginTop);
      expect(await margin.evaluate(el => el.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const afterWheel = await documentTop();
      await marker(3).click();
      await expect(page.getByRole('dialog', { name: '批注气泡 3', exact: true })).toBeVisible();
      expect(await documentTop()).toBe(afterWheel);
      expect(await margin.evaluate(el => el.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0);
      await page.getByRole('button', { name: '批注与讨论', exact: true }).click();
      await page.locator('.review-thread.is-active .review-anchor-quote').click();
      await expect.poll(() => anchor.evaluate(el => Math.abs(el.getBoundingClientRect().top - innerHeight * .32))).toBeLessThan(3);
    });
    if (mobile) test('手机保持正文至底并由编号直达讨论，可按原位置返回', async ({ page }) => {
      const frame = await open(page, 16);
      const documentPanel = page.getByRole('tabpanel', { name: '正文', exact: true });
      const discussionTab = page.getByRole('tab', { name: '讨论 16', exact: true });
      const documentTab = page.getByRole('tab', { name: '正文', exact: true });
      const pins = frame.getByRole('button', { name: /打开批注/ });
      await expect(pins).toHaveCount(16);
      expect((await documentPanel.boundingBox())!.height).toBeGreaterThan(680);
      const initialScrollY = await frame.locator('body').evaluate(() => scrollY);
      await pins.nth(4).tap();
      await expect(discussionTab).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.review-thread.is-active .review-anchor-number')).toHaveText('5');
      await expect(page.locator('.annotation-mobile-dock, .annotation-chat-bubble')).toHaveCount(0);
      await documentTab.tap();
      await expect(pins.nth(4)).toBeInViewport();
      expect(await frame.locator('body').evaluate(() => scrollY)).toBe(initialScrollY);
    });
    if (mobile) test('首屏紧凑文字的重叠批注不遮住字，每个编号均可触控', async ({ page }) => {
      const frame = await open(page, 4, true);
      const pins = frame.getByRole('button', { name: /打开批注/ });
      await expect(pins).toHaveCount(4);
      await expect.poll(() => frame.locator('#note-one').evaluate(paragraph => {
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const glyphs = Array.from(range.getClientRects()).filter(rect => rect.width > 0);
        const layer = document.querySelector('[data-map-annotation-layer]')?.shadowRoot;
        const boxes = Array.from(layer?.querySelectorAll('.pin:not([hidden])') ?? [], element => element.getBoundingClientRect());
        const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        return boxes.length === 4 && boxes.every((box, index) => !glyphs.some(glyph => overlaps(box, glyph))
          && !boxes.slice(0, index).some(previous => overlaps(box, previous)));
      })).toBe(true);
      for (const number of [1, 2, 3, 4]) {
        await frame.getByRole('button', { name: '打开批注 ' + number, exact: true }).tap();
        await expect(page.locator('.review-thread.is-active .review-anchor-number')).toHaveText(String(number));
        await page.getByRole('tab', { name: '正文', exact: true }).tap();
      }
    });
    if (!mobile) test('页边卡可以拖离原文、虚线保留关系并复位', async ({ page }) => {
      const frame = await open(page);
      await frame.getByRole('button', { name: '打开批注 1', exact: true }).click();
      const card = page.getByRole('dialog', { name: '批注气泡 1', exact: true });
      await expect(card).toHaveAttribute('data-placement', 'right');
      const grip = await card.getByRole('button', { name: '移动批注气泡 1' }).boundingBox();
      expect(grip).not.toBeNull();
      await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip!.x, grip!.y + 120, { steps: 8 });
      await page.mouse.up();
      await expect(card).toHaveAttribute('data-placement', 'moved');
      expect(await card.evaluate(el => getComputedStyle(el).boxShadow)).toContain('1.5px');
      await expect(page.locator('.annotation-bubble-connectors .is-moved path')).toHaveCount(1);
      await card.getByRole('button', { name: '放回原位', exact: true }).click();
      await expect(card).toHaveAttribute('data-placement', 'right');
    });
    test('图标全隐保留编号，编号重开后全显；关联菜单在外点与点正文时收起', async ({ page }) => {
      const frame = await open(page);
      const discussion = page.getByRole('button', { name: '批注与讨论', exact: true });
      const documentTab = page.getByRole('tab', { name: '正文', exact: true });
      const pinned = frame.getByRole('button', { name: '打开批注 2', exact: true });
      const hide = page.getByRole('button', { name: '隐藏全部气泡', exact: true }).first();
      const show = page.getByRole('button', { name: '显示全部气泡', exact: true }).first();
      await expect(page.getByRole('button', { name: '批注显示方式', exact: true })).toHaveCount(0);
      await tap(hide);
      await expect(page.locator('.annotation-chat-bubble')).toHaveCount(0);
      await expect(frame.getByRole('button', { name: /打开批注/ })).toHaveCount(2);
      await tap(pinned);
      if (mobile) await expect(page.locator('.review-thread.is-active .review-anchor-number')).toHaveText('2');
      else await expect(page.getByRole('dialog', { name: '批注气泡 2', exact: true })).toBeVisible();
      await tap(show);
      if (mobile) await documentTab.tap();
      else await expect(page.locator('.annotation-chat-bubble')).toHaveCount(2);
      await tap(hide);

      const menu = page.getByRole('button', { name: '关联文档', exact: true });
      await tap(menu);
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      if (mobile) await page.getByText(title, { exact: true }).tap();
      else await discussion.click();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      if (!mobile) await discussion.click();
      await tap(menu);
      await expect(page.getByRole('dialog', { name: '关联文档', exact: true })).toBeVisible();
      const point = await freePoint(page, true);
      if (mobile) await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
    });
    test('一万段长文连续跟随、节点不重建、无全文查询，长意见默认渲染有界', async ({ page, context }) => {
      const frame = await open(page), card = page.locator('[data-bubble-id="one"]');
      await expect.poll(() => frame.locator('body').evaluate(() => document.readyState)).toBe('complete');
      const pin = frame.getByRole('button', { name: '打开批注 1', exact: true });
      const followed = mobile ? pin : card;
      if (!mobile) {
        expect(await card.locator('p').innerText()).toHaveLength(281);
        const grip = await card.getByRole('button', { name: /移动批注气泡/ }).boundingBox();
        expect(grip).not.toBeNull();
        await page.mouse.move(grip!.x + 5, grip!.y + 5);
        await page.mouse.down();
        await page.mouse.move(grip!.x + 5, grip!.y + 165, { steps: 10 });
        await page.mouse.up();
      }
      const before = await followed.boundingBox();
      expect(before).not.toBeNull();
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
        for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - 42 * i / 12 }] }); await page.waitForTimeout(16); }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
      }
      else { await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, 40); }
      await expect.poll(() => frame.locator('body').evaluate(() => scrollY)).toBeGreaterThan(0);
      await expect.poll(async () => {
        const y = await frame.locator('body').evaluate(() => scrollY), current = await followed.boundingBox(); return Math.abs(before!.y - current!.y - y);
      }).toBeLessThan(2);
      if (!mobile) expect(await card.evaluate(el => el === (window as typeof window & { __followCard?: Element }).__followCard)).toBe(true);
      const reads = await frame.locator('body').evaluate(() => (window as typeof window & { __followReads?: { scans: number; rects: number } }).__followReads!);
      const messages = await page.evaluate(() => (window as typeof window & { __followMessages?: number }).__followMessages!);
      expect(reads.scans).toBe(0); expect(reads.rects).toBeLessThanOrEqual((messages + 3) * 60);
      if (mobile) await page.getByRole('tab', { name: '讨论 2', exact: true }).tap();
      else await page.getByRole('button', { name: '批注与讨论', exact: true }).click();
      expect((await page.locator('.review-message-body').first().textContent())!.length).toBeLessThanOrEqual(281);
      {
        await tap(page.getByRole('button', { name: /^展开全文/ }).first());
        expect(await page.locator('.review-message-body').first().textContent()).toBe(content);
        await tap(page.getByRole('button', { name: '收起全文', exact: true }).first());
      }
      const budgetPath = test.info().outputPath('scroll-budget.json');
      await writeFile(budgetPath, JSON.stringify({ paragraphs: 10000, commentCharacters: content.length, ...reads, messages }));
      await test.info().attach('长文滚动预算', { path: budgetPath, contentType: 'application/json' });
    });
  });
});
