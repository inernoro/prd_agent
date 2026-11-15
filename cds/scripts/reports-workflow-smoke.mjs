/** Deterministic reading/layout regression; never a live service acceptance result.
 * Run: PWPATH=... CDS_REPORTS_EVIDENCE=/tmp/reports pnpm exec tsx scripts/reports-workflow-smoke.mjs
 * CDS_REPORTS_SOURCE may point at another checkout's cds directory to run this exact script against the old UI.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';
import { buildReportsOverview } from '../src/services/acceptance-overview.ts';
import { buildPipelineOverview, buildPipelineSeries } from '../src/services/acceptance-pipeline.ts';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || 'playwright');
const source = path.resolve(process.env.CDS_REPORTS_SOURCE || fileURLToPath(new URL('..', import.meta.url)));
const out = process.env.CDS_REPORTS_EVIDENCE || '/tmp/cds-reports-workflow';
await fs.mkdir(out, { recursive: true });
const { startViteDevServer } = await import(pathToFileURL(path.join(source, 'scripts/lib/vite-dev-server.mjs')));
const server = await startViteDevServer();
const browser = await chromium.launch({ headless: true, executablePath: process.env.CDS_CHROMIUM_PATH }).catch(error => { server.stop(); throw error; });
const now = new Date('2026-11-15T12:00:00Z');
const projects = [{ id: 'fixture-project', name: '阅读样例', slug: 'reading-fixture' }, { id: 'fixture-other', name: '另一个项目', slug: 'other-fixture' }];
const makeReports = n => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, title: `功能验收 · 阅读对象${String(i).padStart(2,'0')} · 2026-11-15`, format: 'html', sizeBytes: 1234, createdAt: new Date(now.getTime() - (i + 1) * 60000).toISOString(), projectId: 'fixture-project', folderId: i === 0 ? 'f1' : null, verdict: i % 3 === 0 ? 'fail' : 'pass', defectCounts: { p0: 0, p1: i % 3 === 0 ? 1 : 0, p2: 0 }, tier: 'L2', branch: `feature/reading-${i}`, commitSha: (i + 1).toString(16).padStart(40, 'a'), reportType: 'acceptance' }));
const makeBranches = reports => reports.map((report, i) => ({ id: `b${i}`, projectId: report.projectId, branch: report.branch, commitSha: report.commitSha, status: 'running', createdAt: report.createdAt, lastDeployAt: report.createdAt, services: { web: { status: 'running' } } }));
const folders = [{ id: 'f1', name: '回归证据', projectId: 'fixture-project', createdAt: now.toISOString() }];
const task = i => ({ id: `t${i}`, title: `审查样例${i}`, projectId: 'fixture-project', sourceType: 'github', sourceName: `reading-${i}`, branchName: 'feature/reading', status: 'completed', phase: 'completed', progress: { totalFiles: 8, scannedFiles: 8 }, createdAt: now.toISOString(), updatedAt: now.toISOString(), delivery: { status: 'not_requested' }, findingsSummary: { p1: 1 }, reportId: 'r0' });
const results = [], metrics = [], unknown = new Set(), writes = [], pageErrors = [];
async function fixture({ width = 1440, theme = 'light', count = 2, reviews = 2, failFolders = false, failReports = false, failReview = false, failOverview = false } = {}) {
  const state = { count, reviews, failFolders, failReports, failReview, failOverview };
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: 'reduce' });
  await context.addInitScript(theme => { if (window === window.top) localStorage.setItem('cds_theme', theme); }, theme);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname.replace(/^\/_cds/, '');
    if (url.origin !== server.url) { await route.abort(); throw new Error('Fixture attempted non-local access: ' + url.origin); }
    if (!pathname.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') { writes.push(pathname); return route.fulfill({ status: 405, json: { error: 'fixture forbids writes' } }); }
    if (isEventStream(pathname)) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    const error = () => route.fulfill({ status: 500, headers: { 'x-cds-request-id': 'fixture-error' }, json: { error: '合成读取错误' } });
    const reports = makeReports(state.count);
    if (pathname === '/api/reports') return state.failReports ? error() : route.fulfill({ json: { reports } });
    if (pathname === '/api/report-folders') return state.failFolders ? error() : route.fulfill({ json: { folders } });
    if (pathname === '/api/reports/overview') return state.failOverview ? error() : route.fulfill({ json: { overview: buildReportsOverview(reports, [], { to: now, days: Number(url.searchParams.get('days') || 7) }) } });
    if (pathname === '/api/reports/pipeline') return route.fulfill({ json: { pipeline: buildPipelineOverview(projects, makeBranches(reports), [], reports, { now, recentDays: Number(url.searchParams.get('recentDays') || 7) }), series: buildPipelineSeries(projects, makeBranches(reports), reports, { now, days: 90 }) } });
    if (/^\/api\/reports\/[^/]+\/raw$/.test(pathname)) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><body><h1>阅读正文已到达</h1><p>合成报告证据</p></body></html>' });
    if (pathname === '/api/projects') return route.fulfill({ json: { projects } });
    if (pathname === '/api/code-reviews') {
      if (state.failReview) return error();
      const offset = Number(url.searchParams.get('offset') || 0), total = state.reviews;
      return route.fulfill({ json: { tasks: Array.from({ length: Math.max(0, Math.min(10, total - offset)) }, (_, i) => task(i + offset)), totals: { source: total, report: 0, all: total }, newCount: 0, historyCount: 0, snapshotAt: now.toISOString(), page: { offset, limit: 10, total, nextOffset: offset + 10 < total ? offset + 10 : null } } });
    }
    if (pathname === '/api/cds-system/connections') return route.fulfill({ json: { connections: [] } });
    const body = resolveFixture(pathname);
    if (body === null) unknown.add(pathname);
    return route.fulfill({ json: body ?? {} });
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => pageErrors.push(error.message));
  return { page, context, state };
}
async function settled(page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
}
async function shot(page, name) { await settled(page); await page.screenshot({ path: path.join(out, name + '.png') }); }
async function check(name, run) {
  if (process.env.CDS_REPORTS_CASE && !process.env.CDS_REPORTS_CASE.split('|').some(filter => name.includes(filter))) return;
  try { await run(); results.push({ name, pass: true }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, pass: false, error: error.message }); console.log('FAIL ' + name + ': ' + error.message.slice(0, 400)); }
}
const row = page => page.locator('#reports-ledger tbody tr').first();
try {
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await check(`report-list-${width}-${theme}`, async () => {
      const { page, context } = await fixture({ width, theme });
      try {
        await page.goto(server.url + '/reports'); await row(page).waitFor(); await settled(page);
        const box = await row(page).boundingBox();
        if (!box) { await shot(page, `missing-row-${width}-${theme}`); await fs.writeFile(path.join(out, `missing-row-${width}-${theme}.json`), JSON.stringify({text: await page.locator('body').innerText(), pageErrors, unknown: [...unknown]}, null, 2)); throw new Error('Report row disappeared after data load'); }
        const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, scroll: document.querySelector('.cds-main')?.scrollTop || 0, mainScrollHeight: document.querySelector('.cds-main')?.scrollHeight }));
        const preceding = await page.evaluate(() => ['.pp-root', '[aria-label="交叉分类筛选"]'].map(selector => { const el = document.querySelector(selector); const visible = Boolean(el && !el.closest('details:not([open])') && el.checkVisibility()); return { selector, visible, height: visible ? el.getBoundingClientRect().height : 0 }; }));
        metrics.push({ case: `report-list-${width}-${theme}`, firstDataY: box.y, rowHeight: box.height, precedingReadingRegions: preceding, ...layout });
        await shot(page, `reports-${width}-${theme}`);
        assert(box.y < (width === 390 ? 450 : 350), `first report y=${box.y}`);
        assert(!layout.overflow, 'page overflows horizontally');
        if (width === 390) {
          const title = await row(page).getByText('功能验收 · 阅读对象00 · 2026-11-15', { exact: true }).boundingBox();
          assert(title.x >= 0 && title.x + title.width <= width, 'report title needs horizontal scrolling');
          const action = await row(page).getByRole('button', { name: '打开报告操作菜单' }).boundingBox();
          assert(action.x >= 0 && action.x + action.width <= width && action.width >= 44 && action.height >= 44, 'record action target visible and usable: ' + JSON.stringify(action));
        }
        assert.equal(await page.getByRole('button', { name: '上一页', exact: true }).count(), 0, 'two records do not need pagination');
      } finally { await context.close(); }
    });
  }

  for (const width of [1440, 390]) await check(`reading-task-scroll-${width}`, async () => {
    const { page, context } = await fixture({ width });
    try {
      await page.goto(server.url + '/reports'); await row(page).waitFor(); await settled(page);
      const title = row(page).getByText(makeReports(2)[0].title, { exact: true });
      let gestures = 0;
      await page.mouse.move(width / 2, 600);
      while ((await title.boundingBox()).y > (width === 390 ? 764 : 820) && gestures < 10) {
        await page.mouse.wheel(0, 400); await settled(page); gestures++;
      }
      const scroll = await page.locator('.cds-main').evaluate(el => el.scrollTop);
      await title.click(); await page.frameLocator('iframe').getByRole('heading', { name: '阅读正文已到达' }).waitFor();
      metrics.push({ case: `reading-task-scroll-${width}`, scrollPx: scroll, wheelGestures: gestures, clicksToRead: 1, result: 'report-body-visible' });
      await shot(page, `reading-task-${width}`);
      assert.equal(gestures, 0, 'first report can be read from the initial viewport');
    } finally { await context.close(); }
  });

  await check('overview-mobile-small-and-large-expanded', async () => {
    const { page, context, state } = await fixture({ width: 390 });
    try {
      await page.goto(server.url + '/reports'); await row(page).waitFor();
      const overviewEntry = page.getByRole('button', { name: '验收概况', exact: true });
      if (await overviewEntry.count()) await overviewEntry.click(); // Old UI opened its overview by default.
      await page.locator('.z-stages').waitFor(); await settled(page);
      const stage = await page.locator('.z-stages').boundingBox();
      metrics.push({ case: 'overview-mobile-2', stagesHeight: stage.height });
      await shot(page, 'overview-390-small'); assert(stage.height < 250, `two-report stage is ${stage.height}px`);
      assert(await page.getByText('近 90 天', { exact: false }).count(), 'independent trend window is explicit');
      await page.getByRole('button', { name: '放大', exact: true }).click();
      await page.locator('.ex').waitFor(); await shot(page, 'overview-390-expanded');
      state.count = 1200; await page.getByRole('button', { name: '更多操作', exact: true }).click(); await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.keyboard.press('Escape');
      await page.getByText('显示 1–20 / 1200', { exact: false }).waitFor();
      await shot(page, 'overview-390-large');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    } finally { await context.close(); }
  });
  await check('folder-failure-retains-readable-reports-and-retries', async () => {
    const { page, context, state } = await fixture({ failFolders: true });
    try {
      await page.goto(server.url + '/reports'); await page.getByText('目录信息未确认', { exact: false }).waitFor();
      await row(page).waitFor(); await row(page).getByRole('button', { name: '打开报告操作菜单' }).click();
      const menu = page.getByRole('menu');
      assert.equal(await menu.getByRole('menuitem', { name: '未归类', exact: true }).isEnabled(), false, 'unconfirmed directory cannot mutate');
      await page.keyboard.press('Escape'); await shot(page, 'reports-folder-error');
      state.failFolders = false; await page.getByRole('button', { name: '重试读取目录' }).click();
      await page.getByText('目录信息未确认', { exact: false }).waitFor({ state: 'hidden' });
      await row(page).waitFor();
    } finally { await context.close(); }
  });
  await check('reader-return-keeps-list-and-keyboard-directory', async () => {
    const { page, context } = await fixture({ width: 390, count: 35 });
    try {
      await page.goto(server.url + '/reports'); await row(page).waitFor();
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      assert.equal(await page.locator('#reports-ledger tbody tr').count(), 15, 'last report page retains all fifteen records');
      const lastReport = page.locator('#reports-ledger tbody tr').last();
      await lastReport.getByText(makeReports(35)[34].title, { exact: true }).waitFor();
      await lastReport.scrollIntoViewIfNeeded();
      const lastBox = await lastReport.boundingBox();
      assert(lastBox.y < 844 && lastBox.y + lastBox.height > 0, 'last report is reachable');
      const record = page.locator('#reports-ledger tbody tr').first();
      const title = await record.getByText(/^功能验收 · 阅读对象/).innerText(); await record.scrollIntoViewIfNeeded();
      const scroll = await page.locator('.cds-main').evaluate(el => el.scrollTop);
      await record.click(); await page.frameLocator('iframe').getByRole('heading', { name: '阅读正文已到达' }).waitFor();
      await page.getByRole('button', { name: '打开报告目录' }).click();
      const dialog = page.getByRole('dialog', { name: '报告目录' }); await dialog.waitFor();
      await page.keyboard.press('Shift+Tab');
      assert(await dialog.evaluate(el => el.contains(document.activeElement)), 'reverse Tab remains in directory');
      await page.keyboard.press('Tab'); assert(await dialog.evaluate(el => el.contains(document.activeElement)), 'forward Tab remains in directory');
      await shot(page, 'reports-directory-mobile'); await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '打开报告目录');
      await page.getByRole('button', { name: '返回报告首页' }).click();
      await page.locator('#reports-ledger tbody tr').filter({ hasText: title }).waitFor(); await settled(page);
      assert((await page.evaluate(() => document.activeElement?.textContent || '')).includes(title), 'return focuses original report');
      assert(Math.abs((await page.locator('.cds-main').evaluate(el => el.scrollTop)) - scroll) < 2, 'return preserves list scroll');
    } finally { await context.close(); }
  });

  await check('report-read-failure-retains-list-and-retries', async () => {
    const { page, context, state } = await fixture({ failReports: true });
    try {
      await page.goto(server.url + '/reports');
      await page.getByRole('button', { name: '重试读取报告', exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: '还没有报告' }).count(), 0);
      state.failReports = false; await page.getByRole('button', { name: '重试读取报告', exact: true }).click(); await row(page).waitFor();
      state.failReports = true; await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByText('报告刷新失败', { exact: false }).waitFor(); await row(page).waitFor();
      await shot(page, 'reports-last-known-list');
    } finally { await context.close(); }
  });
  await check('classification-deeplink-and-overview-failure', async () => {
    const { page, context, state } = await fixture();
    try {
      await page.goto(server.url + '/reports?project=fixture-project&systems=unknown'); await row(page).waitFor();
      await page.getByText('分类筛选 · 已选 1 项', { exact: true }).waitFor();
      await page.getByRole('button', { name: '清空分类筛选', exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.has('systems'), false); assert.equal(new URL(page.url()).searchParams.get('project'), 'fixture-project');
      state.failOverview = true; await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByText('版本关系汇总未读取成功', { exact: false }).waitFor(); await row(page).waitFor();
      await page.getByRole('group', { name: '报告类型', exact: true }).getByRole('button', { name: /^功能验收\s*2$/ }).click(); await row(page).waitFor();
      await shot(page, 'reports-classification-fallback');
    } finally { await context.close(); }
  });

  await check('project-evidence-keeps-project-and-clears-other-filters', async () => {
    const { page, context } = await fixture();
    try {
      await page.goto(server.url + '/reports?project=fixture-project&systems=unknown&target=fixture-monitor&view=overview');
      await page.getByRole('button', { name: '验收概况', exact: true }).waitFor();
      await page.getByRole('button', { name: '1 份', exact: true }).first().click();
      await row(page).waitFor(); await row(page).getByText('功能验收 · 阅读对象00 · 2026-11-15', { exact: true }).waitFor();
      const query = new URL(page.url()).searchParams;
      assert.equal(query.get('project'), 'fixture-project');
      for (const key of ['view', 'systems', 'target']) assert.equal(query.has(key), false, key + ' cannot hide selected evidence');
      await shot(page, 'reports-project-evidence');
      await page.getByRole('button', { name: '返回原验收概况', exact: true }).click();
      const restored = new URL(page.url()).searchParams;
      assert.equal(restored.get('view'), 'overview'); assert.equal(restored.get('project'), 'fixture-project');
      assert.equal(restored.get('systems'), 'unknown'); assert.equal(restored.get('target'), 'fixture-monitor');
      await page.getByRole('button', { name: '1 份', exact: true }).first().waitFor(); await settled(page);
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-report-cluster-target') === '阅读对象00');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-report-cluster-target')), '阅读对象00', 'return focuses originating evidence');
    } finally { await context.close(); }
  });

  await check('empty-reports-remains-confirmed-empty', async () => {
    const { page, context } = await fixture({ count: 0 });
    try {
      await page.goto(server.url + '/reports'); await page.getByText('还没有验收报告', { exact: true }).waitFor();
      await shot(page, 'reports-empty'); assert.equal(await page.getByRole('alert').count(), 0);
    } finally { await context.close(); }
  });

  for (const total of [0, 2, 25]) await check(`review-pagination-${total}`, async () => {
    const { page, context } = await fixture({ reviews: total });
    try {
      await page.goto(server.url + '/code-reviews');
      await page.getByText(`共 ${total} 条`, { exact: false }).waitFor();
      await shot(page, `code-reviews-${total}`);
      assert.equal(await page.getByRole('navigation', { name: '任务分页' }).count(), total > 10 ? 1 : 0);
      if (total > 10) { await page.getByRole('button', { name: '下一页任务' }).click(); await page.locator('#review-record-t10').waitFor(); await page.getByRole('button', { name: '第 3 页', exact: true }).click(); await page.locator('#review-record-t24').waitFor(); await page.locator('#review-record-t24').scrollIntoViewIfNeeded(); }
    } finally { await context.close(); }
  });
  await check('review-first-read-error-is-not-empty-and-retry', async () => {
    const { page, context, state } = await fixture({ failReview: true });
    try {
      await page.goto(server.url + '/code-reviews'); await page.getByRole('button', { name: '重试读取', exact: true }).waitFor();
      await shot(page, 'code-reviews-read-error');
      assert.equal(await page.getByRole('heading', { name: '还没有代码审查记录' }).count(), 0);
      state.failReview = false; await page.getByRole('button', { name: '重试读取', exact: true }).click();
      await page.locator('#review-record-t0').waitFor();
    } finally { await context.close(); }
  });
  await check('review-out-of-range-has-return', async () => {
    const { page, context } = await fixture({ reviews: 2 });
    try {
      await page.goto(server.url + '/code-reviews?page=5'); await page.getByText('当前页无记录，共 2 条', { exact: true }).waitFor();
      await page.getByRole('button', { name: '第 1 页', exact: true }).click(); await page.locator('#review-record-t0').waitFor();
    } finally { await context.close(); }
  });
  assert.deepEqual([...unknown], [], 'every requested API path registered');
  assert.deepEqual(writes, [], 'reading paths never write');
  assert.deepEqual(pageErrors, [], 'no page runtime errors');
} finally {
  await browser.close(); server.stop();
  const files = ['web/src/pages/ReportsPage.tsx', 'web/src/pages/CodeReviewsPage.tsx', 'web/src/pages/reports/CompactStrip.tsx', 'web/src/pages/code-reviews/ReviewUi.tsx'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(source, file))).digest('hex')])));
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ provenance: 'deterministic-fixture', commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), source, hashes, scriptSha256: createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'), results, metrics, unknown: [...unknown], writes, pageErrors }, null, 2));
}
if (results.some(result => !result.pass)) process.exitCode = 1;
