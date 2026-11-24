import { devices, expect, test } from '@playwright/test';
import { installOperationsFixtures, target } from '../fixtures/admin-operations.mjs';

const origin = process.env.CDS_MOBILE_COMPAT_ORIGIN || 'http://127.0.0.1:5273';
const projectId = target.projectId;
const api = `/api/projects/${projectId}/design`;
const design = 'DSN-FIXTURE-MOBILE';
const ready = 'data-fixture-prototype-ready';
const screen = {
  id: 'phone', name: '手机原型就绪', route: '#/phone', viewport: 'phone', themes: ['light', 'dark'],
  entryReadySelector: `[${ready}]`, entryTimeoutMs: 1000, impl: null,
};
const screenshot = { id: 'fixture-shot', sha256: 'a'.repeat(64) };
const version = {
  version: 20, title: '手机原型合成验收', sourceCommit: 'a'.repeat(40), sha256: 'a'.repeat(64),
  prototypeId: 'fixture-mobile-prototype', createdAt: '2026-11-25T00:00:00Z',
  publisher: { id: 'fixture-author', label: '合成稿件作者' },
  screens: [screen, { ...screen, id: 'phone-next', name: '第二个合成画面', route: '#/phone-next' }],
  demo: [{ screen: screen.id, title: '手机原型就绪' }], acceptance: [], tags: [], decisionIds: [],
  renders: { [screen.id]: { light: screenshot, dark: screenshot } },
};
const workspace = {
  projectId, frameworks: [],
  designs: [{ id: design, projectId, frozen: 20, versions: [version], comments: [], runs: [], feedback: [] }],
  permissions: { write: false, review: false, feedback: false, visual: false, actorId: 'fixture-viewer' },
};
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN49/wuAAV5ArOtKqbJAAAAAElFTkSuQmCC', 'base64');

test('手机设计原型连续刷新、慢加载、失败重试和截图图库', async ({ browser, browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox Playwright 不支持 isMobile');
  const context = await browser.newContext({
    ...devices['iPhone 12 Mini'], viewport: { width: 375, height: 812 },
    deviceScaleFactor: 1, colorScheme: 'light', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  let mode: 'normal' | 'slow' | 'failure' = 'normal';
  let deferredRequests = 0;
  let failedRequests = 0;
  let requests = 0;
  let resume: () => void = () => {};
  let hold: Promise<void> = Promise.resolve();
  try {
    await installOperationsFixtures(page);
    await page.route(url => url.pathname === api, route => route.fulfill({ json: workspace }));
    await page.route(url => url.pathname === api + '/artifacts/' + screenshot.id,
      route => route.fulfill({ contentType: 'image/png', body: pixel }));
    await page.route(url => url.pathname === api + '/artifacts/' + version.prototypeId, async route => {
      requests++;
      if (mode === 'failure') {
        failedRequests++;
        return route.fulfill({ status: 502, contentType: 'text/html', body: '<!doctype html><title>fixture unavailable</title>' });
      }
      if (mode === 'slow') {
        deferredRequests++;
        await hold;
      }
      return route.fulfill({
        contentType: 'text/html',
        headers: { 'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'self'" },
        body: `<!doctype html><html><head><meta charset="utf-8"></head><body><main ${ready}>合成原型已打开</main><script>
          document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme');
          addEventListener('message', event => {
            if (event.source !== parent || event.data?.type !== 'cds-design-entry') return;
            parent.postMessage({ type: 'cds-design-entry-result', requestId: event.data.requestId, reached: true }, '*');
          });
        </script></body></html>`,
      });
    });

    const url = origin + '/design?' + new URLSearchParams({ project: projectId, design, version: '20', screen: screen.id });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const canvas = page.locator('.dw-deliver .dw-canvas');
    const frame = canvas.locator('iframe');
    const expectReady = async () => {
      await expect(canvas.locator('[data-preview-state="ready"]')).toHaveCount(1);
      await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
      await expect(frame.contentFrame().locator(`[${ready}]`)).toBeVisible();
      await expect(page).toHaveURL(url);
    };
    await expectReady();
    expect(await page.evaluate(() => window.innerWidth)).toBe(375);
    // Linux WebKit reports zero hardware touch points even when Playwright emulates taps.
    if (browserName === 'chromium') expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
    const topFrameUrls: string[] = [];
    page.on('framenavigated', candidate => {
      if (candidate === page.mainFrame()) topFrameUrls.push(candidate.url());
    });
    for (let turn = 0; turn < 5; turn++) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expectReady();
    }
    expect(topFrameUrls).toEqual(Array.from({ length: 5 }, () => url));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    const tools = canvas.locator('.dw-canvas-corner .dw-tools');
    expect(await tools.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    await expect(canvas.getByLabel('缩放', { exact: true })).toBeHidden();

    await canvas.getByRole('button', { name: '切换为深色', exact: true }).tap();
    await expectReady();
    await expect(frame.contentFrame().locator('html')).toHaveAttribute('data-theme', 'dark');
    mode = 'slow';
    hold = new Promise(resolve => { resume = resolve; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => deferredRequests).toBe(1);
    await expect(canvas.getByText('正在打开可以点的原型', { exact: true })).toBeVisible();
    await expect(canvas.locator('.dw-frame-png')).toBeVisible();
    mode = 'normal';
    resume();
    await expectReady();

    mode = 'failure';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => failedRequests).toBeGreaterThan(0);
    const retry = canvas.getByRole('button', { name: '重试', exact: true });
    await expect(canvas.getByRole('status').filter({ hasText: /加载失败|未返回|未能|无法|超时/ })).toBeVisible();
    await expect(retry).toBeVisible();
    const beforeRetry = requests;
    mode = 'normal';
    await retry.tap();
    await expectReady();
    expect(requests).toBeGreaterThan(beforeRetry);

    await canvas.getByRole('button', { name: /^全部\s*2\s*屏$/ }).tap();
    await expect(canvas.locator('.dw-all-screens figure')).toHaveCount(2);
    await expect(page.locator('.dw-canvas iframe')).toHaveCount(0);
    await expect(canvas.locator('.dw-all-screens img')).toHaveCount(1);
    await canvas.getByRole('button', { name: '单屏', exact: true }).tap();
    await expectReady();
  } finally {
    resume();
    await context.close();
  }
});
