import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { FIXTURE_PROJECT_ID, isEventStream, resolveFixture } from './fixtures/mobile-layout-fixtures.mjs';

const projectId = FIXTURE_PROJECT_ID;
const boardPath = `/api/projects/${projectId}/design`;
const title = '合成目标稿件';
const draftId = 'fixture-design-target';
const otherId = 'fixture-design-decoy';
const publisher = { id: 'fixture-owner', label: '合成验收所有者' };
const screen = { id: 'main', name: '合成原型画面', route: '#main', viewport: 'desktop', themes: ['light', 'dark'], impl: null };
const externalOrigin = 'https://rationale-fixture.invalid';
const rationale = [
  '## 合成设计理由', '', '保留 **合成重点** 来核对段落与强调。', '',
  '1. 合成有序项甲', '2. 合成有序项乙', '', '- 合成无序项甲', '- 合成无序项乙', '',
  `[合成外部资料](${externalOrigin}/reference)`, '',
  '[不支持的合成链接](data:text/plain,fixture-unsafe-scheme)', '',
  `![合成远程图片](${externalOrigin}/markdown-image.png)`, '',
  '<aside data-fixture-untrusted>合成原始标签</aside>', '',
  `<img data-fixture-untrusted src="${externalOrigin}/raw-image.png" alt="合成原始图片">`,
].join('\n');

function draft(id, name, reason) {
  const version = {
    version: 1, title: name, sourceCommit: 'a'.repeat(40), sha256: 'b'.repeat(64),
    prototypeId: `${id}-prototype`, createdAt: '2026-11-20T02:00:00Z', publisher, screens: [screen],
    rationale: reason, spec: {}, acceptance: [], tags: [], decisionIds: [], resolves: {},
  };
  return { id, projectId, versions: [version], comments: [], runs: [], feedback: [] };
}

async function checkRoute(page) {
  await page.waitForURL(url => url.pathname === '/design' && url.searchParams.get('design') === draftId, { timeout: 2200 });
  await page.getByRole('heading', { name: title, exact: true, level: 1 }).waitFor();
  await page.getByLabel('稿件版本', { exact: true }).waitFor();
}

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8870');
assert(['127.0.0.1', 'localhost'].includes(base.hostname), '合成浏览器校验只允许本机实例');
const headerLimit = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
assert(headerLimit === undefined || (Number.isFinite(headerLimit) && headerLimit > 0));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CDS_CHROMIUM_PATH || undefined });
const context = await browser.newContext({
  viewport: { width: 1440, height: 940 }, reducedMotion: 'reduce', serviceWorkers: 'block',
});
const drafts = [draft(otherId, '合成对照稿件', ''), draft(draftId, title, rationale)];
const remoteMedia = [];
const cases = {};

async function check(name, action) {
  try {
    cases[name] = { passed: true, ...(await action()) };
  } catch (error) {
    cases[name] = { passed: false, reason: String(error.message).split('\n')[0] };
  }
}

try {
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base.origin) {
      if (url.origin === externalOrigin) remoteMedia.push(url.pathname);
      return route.abort();
    }
    const pathname = url.pathname.replace(/^\/_cds/, '');
    if (!pathname.startsWith('/api/')) return route.continue();
    if (isEventStream(pathname) || pathname === '/api/activity-stream') {
      return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    }
    if (pathname === '/api/auth/status') return route.fulfill({ json: {
      authenticated: true, enabled: true, mode: 'basic',
      user: { ...publisher, name: publisher.label, isSystemOwner: true },
    } });
    if (pathname === boardPath) return route.fulfill({ json: { ...resolveFixture(boardPath), designs: drafts } });
    const prototype = drafts.find(entry => pathname === `${boardPath}/artifacts/${entry.versions[0].prototypeId}`);
    if (prototype) return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="zh"><meta charset="utf-8"><body style="display:grid;place-items:center;height:90vh"><h1>实体框架 · ${prototype.versions[0].title}</h1></body></html>`,
    });
    return route.fulfill({ json: resolveFixture(pathname) ?? {} });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const card = page.locator('article.dw-design-card').filter({ hasText: title });
  const headline = card.getByText(title, { exact: true });
  const openShelf = async () => {
    await page.goto(new URL('/design', base).href);
    await headline.waitFor();
  };

  await page.goto(new URL('/project-list', base).href);
  await page.getByRole('link', { name: '设计', exact: true }).click();
  await headline.waitFor();
  await check('coverCenter', async () => {
    const cover = card.locator('iframe');
    await card.frameLocator('iframe').locator('h1').filter({ hasText: `实体框架 · ${title}` }).waitFor();
    const sandbox = await cover.getAttribute('sandbox');
    assert(sandbox !== null && !sandbox.split(/\s+/).includes('allow-same-origin'), '原型框架仍隔离同源权限');
    const bounds = await cover.boundingBox();
    assert(bounds && bounds.width > 40 && bounds.height > 40);
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await checkRoute(page);
  });
  await check('cardSurface', async () => {
    await openShelf();
    const footer = await card.locator('footer').boundingBox();
    assert(footer && footer.width > 40 && footer.height > 25);
    await page.mouse.click(footer.x + footer.width - 6, footer.y + footer.height - 6);
    await checkRoute(page);
  });
  await check('keyboard', async () => {
    await openShelf();
    assert.equal(await headline.evaluate(element => element.tabIndex), 0);
    await headline.focus();
    await page.keyboard.press('Enter');
    await checkRoute(page);
  });
  await check('coverKeyboard', async () => {
    await openShelf();
    const cover = card.getByRole('button', { name: `打开稿件 ${title}`, exact: true });
    await cover.waitFor({ timeout: 2200 });
    assert.equal(await cover.evaluate(element => element.tabIndex), 0);
    await cover.focus();
    await page.keyboard.press('Enter');
    await checkRoute(page);
  });
  await check('cardLargeScreen', async () => {
    await openShelf();
    await card.hover();
    await card.getByRole('button', { name: `大屏查看 ${title}`, exact: true }).click();
    const large = page.getByRole('dialog', { name: `${title} · V1`, exact: true });
    await large.waitFor();
    assert.equal(new URL(page.url()).searchParams.has('design'), false, '大屏操作保留设计库位置');
    await large.getByRole('button', { name: '退出大屏', exact: true }).click();
    await large.waitFor({ state: 'hidden' });
  });
  await check('title', async () => {
    await openShelf();
    await headline.click();
    await checkRoute(page);
  });

  const workspace = page.locator('.dw-workspace');
  await check('previewHeader', async () => {
    const canvas = workspace.locator('.dw-canvas');
    await canvas.waitFor();
    const area = await workspace.boundingBox();
    const stage = await canvas.boundingBox();
    const tabs = await page.getByRole('navigation', { name: '稿件标签', exact: true }).boundingBox();
    assert(area && stage && tabs, '预览画布与稿件标签可见');
    const headerPixels = Math.round(stage.y - area.y);
    assert(tabs.y + tabs.height <= stage.y + 1, '稿件标签与画布不重叠');
    return { headerPixels, canvasHeight: Math.round(stage.height) };
  });
  if (headerLimit !== undefined && cases.previewHeader.headerPixels > headerLimit) {
    cases.previewHeader.passed = false;
    cases.previewHeader.reason = `预览顶部占用 ${cases.previewHeader.headerPixels}px，目标至多 ${headerLimit}px`;
  }

  await check('rationaleMarkdown', async () => {
    await page.getByRole('navigation', { name: '稿件标签', exact: true }).getByRole('button', { name: '思路', exact: true }).click();
    await workspace.getByRole('heading', { name: '合成设计理由', exact: true }).waitFor();
    const checks = {
      paragraphs: await workspace.locator('p').filter({ hasText: '来核对段落与强调。' }).count() === 1,
      strong: await workspace.locator('p strong').filter({ hasText: /^合成重点$/ }).count() === 1,
      ordered: await workspace.locator('ol li').filter({ hasText: /^合成有序项甲$/ }).count() === 1,
      unordered: await workspace.locator('ul li').filter({ hasText: /^合成无序项甲$/ }).count() === 1,
    };
    assert(Object.values(checks).every(Boolean), `未保留 Markdown 语义 ${JSON.stringify(checks)}`);
    return checks;
  });
  await check('rationaleSafety', async () => {
    await workspace.getByRole('heading', { name: '合成设计理由', exact: true }).waitFor();
    assert.equal(await workspace.locator('[data-fixture-untrusted]').count(), 0, '原始 HTML 不生成可执行节点');
    assert.equal(await workspace.locator('img[src*="rationale-fixture.invalid"]').count(), 0, 'Markdown 不加载远程图片');
    assert.equal(await workspace.locator('a[href^="data:"]').count(), 0, '不支持的协议不生成可用链接');
    assert.deepEqual(remoteMedia, [], '稿件理由没有触发向外部地址的请求');
  });
  console.log(JSON.stringify(cases, null, 2));
  if (Object.values(cases).some(result => !result.passed)) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
