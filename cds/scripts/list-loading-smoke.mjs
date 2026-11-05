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
let dataGate, releaseData;
const holdData = () => { dataGate = new Promise(resolve => { releaseData = () => { resolve(); dataGate = null; }; }); };
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
    // 会话首载单独由连续性脚本验收；这里固定已确认身份，门控列表请求测量布局。
    if (pathname === '/api/projects' || pathname === '/api/projects/fixture-project') {
      if (dataGate) await dataGate;
      else await new Promise(r => setTimeout(r, delay));
    }
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
  const filledPulse = async () => {
    const style = await page.evaluate(() => {
      // The route skeleton can be replaced before a bound element callback runs.
      // Select and sample the current document node within the same browser turn.
      const el = document.querySelector('.cds-loading-skeleton-line');
      if (!el) throw new Error('No current skeleton to inspect');
      const s = getComputedStyle(el);
      return { backgroundImage: s.backgroundImage, color: s.backgroundColor, shadow: s.boxShadow,
        border: s.borderTopColor, duration: s.animationDuration, animation: s.animationName, opacity: Number(s.opacity) };
    });
    assert.equal(style.backgroundImage, 'none', 'solid fill without a bright sweeping gradient');
    assert(!/rgba\([^)]*,\s*0\)$/.test(style.color), 'the placeholder has a visible fill');
    assert.equal(style.shadow, 'none', 'no pale inset outline');
    assert.equal(style.border, 'rgba(0, 0, 0, 0)', 'invisible border preserves geometry');
    assert.equal(style.duration, '2s');
    assert.notEqual(style.animation, 'none');
    assert(style.opacity >= .7, 'breathing remains legible at its dimmest phase');
  };
  const geometry = async selector => {
    await page.mouse.move(0, 0);
    return page.evaluate(async selector => {
      const current = () => [...document.querySelectorAll(selector)].find(el => el.getBoundingClientRect().width > 0);
      const initial = current();
      if (!initial) throw new Error('No visible card to measure');
      await Promise.allSettled(initial.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished));
      const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const measure = () => {
        const el = current();
        if (!el) throw new Error('Card disappeared before measurement');
        return { card: rect(el), header: rect(el.querySelector('header')), footer: rect(el.querySelector('footer')) };
      };
      // A route-chunk skeleton is replaced by the page's data skeleton. Reselect
      // the live node instead of measuring a detached element as a zero rectangle.
      // Keep the original one-pixel contract and wait for layout motion to settle.
      let last = JSON.stringify(measure()), stable = 0;
      for (let frame = 0; frame < 60 && stable < 4; frame++) {
        await new Promise(requestAnimationFrame);
        const next = JSON.stringify(measure());
        stable = next === last ? stable + 1 : 0; last = next;
      }
      if (stable < 4) throw new Error('Card geometry did not settle');
      return measure();
    }, selector);
  };
  const aligned = (label, before, after) => {
    for (const part of ['card', 'header', 'footer']) {
      assert.equal(Boolean(before[part]), Boolean(after[part]), label + ' ' + part);
      if (before[part]) for (const axis of ['x', 'y', 'width', 'height']) assert(Math.abs(before[part][axis] - after[part][axis]) <= 1, `${label} ${part}.${axis}: ${before[part][axis]} -> ${after[part][axis]}`);
    }
    geometryResults.push({ label, before, after });
  };
  holdData();
  await page.goto(base + '/project-list');
  await page.waitForSelector('[aria-label="加载项目列表"]');
  const projectBefore = await geometry('[aria-busy="true"] .cds-card-grid article');
  await filledPulse();
  await page.screenshot({ path: out + '/projects-skeleton.png' });
  releaseData();
  await page.waitForSelector('article a[href="/branches/fixture-project"]');
  aligned('projects desktop', projectBefore, await geometry('[data-list-loading-boundary] article'));
  await noEffect();
  await page.getByRole('button', { name: '刷新项目列表', exact: true }).click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('article a[href="/branches/fixture-project"]').count(), 1);
  assert.equal(await page.locator('[aria-busy="true"] .cds-card-grid').count(), 0);
  await noEffect();
  holdData();
  await page.locator('article a[href="/branches/fixture-project"]').click();
  await page.waitForSelector('[aria-busy="true"] .cds-branch-card-grid article');
  const branchBefore = await geometry('[aria-busy="true"] .cds-branch-card-grid article');
  await filledPulse();
  await page.screenshot({ path: out + '/branches-skeleton.png' });
  releaseData();
  await page.waitForSelector('[data-branch-card-id]');
  await page.screenshot({path:out+'/branches-real-diagnostic.png'});
  await fs.writeFile(out+'/branches-real-diagnostic.html',await page.content());
  aligned('branches desktop with tags', branchBefore, await geometry('[data-branch-card-id]'));
  await noEffect();
  console.log('PASS project skeleton -> real project -> refresh retains content -> branch skeleton -> real branches; no effects');

  await page.getByRole('button', { name: '切换到黑天主题', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, pending, real, label] of [
    ['/project-list', '[aria-busy="true"] .cds-card-grid article', '[data-list-loading-boundary] article', 'projects dark390'],
    ['/branches/fixture-project', '[aria-busy="true"] .cds-branch-card-grid article', '[data-branch-card-id]', 'branches dark390'],
  ]) {
    holdData();
    await page.goto(base + route);
    await page.waitForSelector(pending);
    const before = await geometry(pending);
    await filledPulse();
    await page.screenshot({ path: out + '/' + label.replaceAll(' ', '-') + '-skeleton.png' });
    releaseData();
    await page.waitForSelector(route === '/project-list' ? 'article a[href="/branches/fixture-project"]' : real);
    aligned(label, before, await geometry(real));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await noEffect();
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  holdData();
  await page.goto(base + '/project-list');
  await page.waitForSelector('.cds-loading-skeleton-line');
  assert.equal(await page.locator('.cds-loading-skeleton-line').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  releaseData();
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

  const shellGeometry = () => page.evaluate(() => {
    const shape = selector => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x:r.x, y:r.y, width:r.width, height:r.height };
    };
    return { main:shape('.cds-main'), workspace:shape('.cds-workspace'), rail:shape('.cds-rail'),
      card:shape('[aria-busy="true"] article'), rows:getComputedStyle(document.querySelector('.cds-app-shell')).gridTemplateRows };
  });
  const slowLayouts = [];
  delay = 8500;
  for (const [route, real] of [['/project-list','article a[href="/branches/fixture-project"]'], ['/branches/fixture-project','[data-branch-card-id]']]) {
    await page.goto(base + route);
    await page.waitForSelector('[aria-busy="true"] article');
    const before = await shellGeometry();
    await page.getByText('正在等待服务器返回列表数据。').waitFor({ timeout: 9000 });
    const after = await shellGeometry();
    for (const part of ['main','workspace','rail','card']) for (const axis of ['x','y','width','height']) assert(Math.abs(before[part][axis]-after[part][axis])<1, `${route}: slow status moved ${part}.${axis}: ${before[part][axis]} -> ${after[part][axis]}`);
    assert.equal(after.rows.split(/\s+/).length,2,'slow status must not add an app-shell grid row');
    assert(await page.getByText('正在等待服务器返回列表数据。').evaluate(el=>Boolean(el.closest('.cds-workspace'))),'status belongs inside the workspace');
    assert(await page.getByRole('button', { name: '重新加载', exact: true }).isVisible());
    await page.waitForSelector(real);
    assert.equal(await page.getByText('正在等待服务器返回列表数据。').count(),0);
    slowLayouts.push({route,before,after});
  }
  await fs.writeFile(out + '/slow-layout.json',JSON.stringify(slowLayouts,null,2));
  fail = true; delay = 600;
  await page.goto(base + '/project-list');
  await page.getByText(/fixture: 请求失败/).waitFor({ timeout: 10000 });
  await noEffect();
  fail = false; delay = 10; chunkDelay = 0;
  await page.getByRole('button', { name: '刷新项目列表', exact: true }).click();
  await page.waitForSelector('article a[href="/branches/fixture-project"]');
  await page.reload();
  await page.waitForSelector('article a[href="/branches/fixture-project"]');
  await noEffect();
  console.log('PASS long-wait status clears on success; error/retry; fast cache without decoration');

  member = true; delay = 1200; chunkDelay = 1200;
  holdData();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('status', {name:'页面加载中',exact:true}).waitFor();
  assert.equal(await page.locator('.cds-topbar-center .h-4.w-44').count(),1,'member code wait uses summary silhouette');
  assert.equal(await page.locator('.cds-topbar-center > .h-9.w-full').count(),0,'member code wait has no owner-only silhouette');
  await page.getByRole('status', {name:'页面加载中',exact:true}).waitFor({state:'hidden'});
  assert.equal(await page.locator('.cds-topbar-center .h-4.w-44').count(),1,'member data wait uses the same summary silhouette');
  assert.equal(await page.locator('.cds-topbar-center > .h-9.w-full').count(),0,'member data wait has no owner-only silhouette');
  await page.waitForSelector('[aria-busy="true"] .cds-card-grid article');
  const memberBefore = await geometry('[aria-busy="true"] .cds-card-grid article');
  assert.equal(await page.locator('#topbar-git-repo-url').count(), 0);
  releaseData();
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
