/** Local fixture QA only: no real credentials, deployments or model requests. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8870';
if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(base)) throw new Error('Fixture QA requires an explicit local server');
const out = process.env.CDS_SKELETON_EVIDENCE || '/tmp/cds-list-loading';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
let delay = 1800, fail = false, member = false, chunkDelay = 1200;
const errors = [], unknown = new Set(), geometryResults = [];

try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.addInitScript(() => {
    window.__loadingTrace = [];
    const sample = () => {
      const real = [...document.querySelectorAll('article a[href^="/branches/"]')].map(e => e.closest('article'));
      real.push(...document.querySelectorAll('[data-branch-card-id]'));
      if (window.__loadingTrace.length < 3000) window.__loadingTrace.push({
        overlays: document.querySelectorAll('.t-gen').length,
        modifiedCards: real.filter(e => e.style.opacity || e.style.clipPath || e.style.filter).length,
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await context.route(/\/assets\/ProjectListPage-[^/]+\.js$/, async route => {
    await new Promise(r => setTimeout(r, chunkDelay));
    await route.continue();
  });
  await context.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname.replace(/^\/_cds/, '');
    if (isEventStream(pathname)) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (pathname === '/api/auth/status') await new Promise(r => setTimeout(r, 900));
    if (pathname === '/api/projects' || pathname === '/api/projects/fixture-project') await new Promise(r => setTimeout(r, delay));
    if (fail && pathname === '/api/projects') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fixture: 请求失败，可刷新重试' }) });
    let body = resolveFixture(pathname);
    if (body === null) unknown.add(pathname);
    if (member && pathname === '/api/auth/status') body = { ...body, user: { ...body.user, isSystemOwner: false } };
    if (member && pathname === '/api/projects') body = { ...body, canManageProjects: false };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body ?? {}) });
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const noEffect = async () => {
    assert.deepEqual((await page.evaluate(() => window.__loadingTrace)).filter(f => f.overlays || f.modifiedCards), [], 'no construction overlay, clipping or hidden real cards at any frame');
    assert.equal(await page.locator('.t-gen').count(), 0);
  };
  const geometry = async selector => {
    await page.mouse.move(0, 0);
    return page.locator(selector).first().evaluate(async el => {
      await Promise.allSettled(el.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished));
      const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      return { card: rect(el), header: rect(el.querySelector('header')), footer: rect(el.querySelector('footer')) };
    });
  };
  const aligned = (label, before, after) => {
    for (const part of ['card', 'header', 'footer']) {
      assert.equal(Boolean(before[part]), Boolean(after[part]), label + ' ' + part);
      if (before[part]) for (const axis of ['x', 'y', 'width', 'height']) assert(Math.abs(before[part][axis] - after[part][axis]) <= 1, `${label} ${part}.${axis}`);
    }
    geometryResults.push({ label, before, after });
  };
  await page.goto(base + '/project-list');
  await page.waitForSelector('[aria-label="加载项目列表"]');
  const projectBefore = await geometry('[aria-busy="true"] .cds-card-grid article');
  await page.screenshot({ path: out + '/projects-skeleton.png' });
  await page.waitForSelector('article a[href="/branches/fixture-project"]');
  aligned('projects desktop', projectBefore, await geometry('[data-list-loading-boundary] article'));
  await noEffect();
  await page.getByRole('button', { name: '刷新项目列表', exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('article a[href="/branches/fixture-project"]').count(), 1);
  assert.equal(await page.locator('[aria-busy="true"] .cds-card-grid').count(), 0);
  await noEffect();
  await page.locator('article a[href="/branches/fixture-project"]').click();
  await page.waitForSelector('[aria-busy="true"] .cds-branch-card-grid article');
  const branchBefore = await geometry('[aria-busy="true"] .cds-branch-card-grid article');
  await page.screenshot({ path: out + '/branches-skeleton.png' });
  await page.waitForSelector('[data-branch-card-id]');
  aligned('branches desktop with tags', branchBefore, await geometry('[data-branch-card-id]'));
  await noEffect();
  console.log('PASS project skeleton -> real project -> refresh retains content -> branch skeleton -> real branches; no effects');

  await page.getByRole('button', { name: '切换到黑天主题', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, pending, real, label] of [
    ['/project-list', '[aria-busy="true"] .cds-card-grid article', '[data-list-loading-boundary] article', 'projects dark390'],
    ['/branches/fixture-project', '[aria-busy="true"] .cds-branch-card-grid article', '[data-branch-card-id]', 'branches dark390'],
  ]) {
    await page.goto(base + route);
    await page.waitForSelector(pending);
    const before = await geometry(pending);
    await page.screenshot({ path: out + '/' + label.replaceAll(' ', '-') + '-skeleton.png' });
    await page.waitForSelector(route === '/project-list' ? 'article a[href="/branches/fixture-project"]' : real);
    aligned(label, before, await geometry(real));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await noEffect();
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(base + '/project-list');
  await page.waitForSelector('article a[href="/branches/fixture-project"]');
  await noEffect();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(base + '/branches/fixture-project');
  await page.waitForSelector('[aria-busy="true"] .cds-branch-card-grid article');
  await page.getByRole('link', { name: '项目', exact: true }).click();
  await page.waitForSelector('article a[href="/branches/fixture-project"]');
  await noEffect();
  console.log('PASS dark390 aligned geometry; reduced motion; rapid SPA switch with no overlay');

  delay = 7200;
  await page.reload();
  await page.getByText('正在等待服务器返回列表数据。').waitFor({ timeout: 9000 });
  assert(await page.getByRole('button', { name: '重新加载', exact: true }).isVisible());
  await page.waitForSelector('article a[href="/branches/fixture-project"]');
  assert.equal(await page.getByText('正在等待服务器返回列表数据。').count(), 0);
  fail = true; delay = 600;
  await page.reload();
  await page.getByText(/fixture: 请求失败/).waitFor({ timeout: 10000 });
  await noEffect();
  fail = false; delay = 10; chunkDelay = 0;
  await page.getByRole('button', { name: '刷新项目列表', exact: true }).click();
  await page.waitForSelector('article a[href="/branches/fixture-project"]');
  await page.reload();
  await page.waitForSelector('article a[href="/branches/fixture-project"]');
  await noEffect();
  console.log('PASS long-wait status clears on success; error/retry; fast cache without decoration');

  member = true; delay = 1200;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForSelector('[aria-busy="true"] .cds-card-grid article');
  const memberBefore = await geometry('[aria-busy="true"] .cds-card-grid article');
  assert.equal(await page.locator('#topbar-git-repo-url').count(), 0);
  await page.waitForSelector('article a[href="/branches/fixture-project"]');
  aligned('projects member390', memberBefore, await geometry('[data-list-loading-boundary] article'));
  assert.equal(await page.locator('#topbar-git-repo-url').count(), 0);
  await noEffect();
  assert.deepEqual(errors, []); assert.deepEqual([...unknown], []);
  await fs.writeFile(out + '/geometry.json', JSON.stringify(geometryResults, null, 2));
  console.log('PASS member layout; GEOMETRY', geometryResults.map(r => r.label), 'PAGE_ERRORS', errors, 'UNREGISTERED_FIXTURES', [...unknown]);
} finally {
  await browser.close();
}
