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

async function serve(page: Page, options: { shape?: string; wrapper?: string; html?: string;
  pdfFilePaths?: string[]; requiresPreviewBridge?: boolean; sameOrigin?: boolean; nativeHtml?: string; modal?: boolean; inlineHistory?: boolean; multiFileHistory?: boolean; metadataLag?: boolean; ask?: boolean } = {}) {
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
      data = { siteId: site.id, commentsEnabled: true, canComment: !!options.inlineHistory, comments: [] };
    } else if (path.endsWith('/revisions')) {
      if (options.metadataLag) await metadataGate;
      data = options.inlineHistory ? [currentVersion, inlineVersion] : options.metadataLag ? [currentVersion] : [];
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
  const preview = options.modal ? page.getByRole('dialog').locator('iframe') : page.locator('iframe[title="临时预览测试"]');
  await expect(preview).toBeVisible();
  return { releaseVersions, requests, contentRequests: () => contentRequests, listRequests: () => listRequests, frame: preview.contentFrame(), preview };
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`托管对抗样本 ${viewport.width}px`, () => {
    test.use({ viewport });

    for (const modal of [false, true]) {
      test(`${modal ? '站内' : '分享'}的无直链历史正文保持内联预览并可绑定批注`, async ({ page }) => {
        const { frame, preview } = await serve(page, { modal, inlineHistory: true, shape: 'self-contained-html', html: '<h1>当前版正文</h1>' });
        await expect(frame.getByRole('heading', { name: '当前版正文' })).toBeVisible();
        await page.getByRole('button', { name: '网页版本：V2', exact: true }).click();
        await page.getByRole('option', { name: /V1/ }).click();
        await expect(frame.getByRole('heading', { name: '仅保留 HTML 的旧版正文' })).toBeVisible();
        await expect(preview).not.toHaveAttribute('src', '');
        await expect.poll(() => frame.locator('base').getAttribute('href')).toBe(new URL('.', entry).href);
        const bind = page.getByRole('button', { name: '绑定页面元素 / 选中文字', exact: true });
        if (!await bind.isVisible()) await page.getByRole('button', { name: '批注与讨论', exact: true }).click();
        await expect(bind).toBeEnabled();
        await bind.click();
        await frame.getByRole('heading', { name: '仅保留 HTML 的旧版正文' }).click();
        await expect(page.getByText('已选中标题', { exact: true })).toBeVisible();
        await expect(frame.getByRole('heading', { name: '仅保留 HTML 的旧版正文' })).toBeVisible();
        await expect(preview).toHaveAttribute('srcdoc', /仅保留 HTML 的旧版正文/);
        await expect(frame.locator('script[data-map-pdf-download-bridge], script[data-map-package-download-bridge]')).toHaveCount(0);
        if (modal) await expect(page.getByRole('button', { name: '新窗口打开', exact: true })).toBeDisabled();
        else {
          await page.getByRole('button', { name: '更多', exact: true }).click();
          const external = page.getByRole('menuitem', { name: '新窗口打开', exact: true });
          await expect(external).toHaveAttribute('aria-disabled', 'true');
          await expect(external).not.toHaveAttribute('href');
        }

      });
    }

    for (const modal of [false, true]) {
      test(`${modal ? '站内' : '分享'}的历史多文件版本保留真实来源与同源 fetch`, async ({ page }) => {
        const { frame, preview } = await serve(page, { modal, inlineHistory: true, multiFileHistory: true, shape: 'multi-file' });
        await page.getByRole('button', { name: '网页版本：V2', exact: true }).click();
        await page.getByRole('option', { name: /V1/ }).click();
        await expect(page.getByRole('button', { name: '网页版本：V1', exact: true })).toBeVisible();
        await expect(frame.locator('#result')).toHaveText('fetch-ok:entry');
        await expect(preview).not.toHaveAttribute('srcdoc');
        expect(await frame.locator('body').evaluate(() => location.href)).toBe(entry);
        await expect(frame.locator('body')).toHaveAttribute('data-storage', 'ok');
      });
    }

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
