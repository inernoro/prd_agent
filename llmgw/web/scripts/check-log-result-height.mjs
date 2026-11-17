// Local actual-component geometry guard. All gateway responses are isolated fixtures.
// PLAYWRIGHT_MODULE may point to the workspace's installed @playwright/test module.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.CHECK_ROOT || fileURLToPath(new URL('../', import.meta.url));
const out = path.resolve(process.env.CHECK_OUT || path.join(tmpdir(), `llmgw-result-height-${Date.now()}`));
fs.mkdirSync(out, { recursive: true });
process.env.LLMGW_WEB_BASE = '/';
let mode = 'empty';
const results = [], failures = [], requests = [], errors = [];
const check = (passed, message) => { results.push({ check: message, passed: !!passed }); if (!passed) failures.push(message); };
const tenant = { id: 'fixture', name: '布局审核', role: 'owner', isInternal: true, teamIds: [] };
const rows = () => Array.from({ length: mode === 'empty' ? 0 : mode === 'few' ? 2 : 64 }, (_, i) => ({
  id: `record-${i + 1}`, requestId: `receipt-${i + 1}`, model: 'fixture-chat', provider: '受控供应方',
  appCallerCode: 'fixture.reader', appCallerTitle: '审核应用', requestType: 'chat', operation: 'invoke',
  status: i % 2 ? 'succeeded' : 'failed', statusCode: i % 2 ? 200 : 403,
  startedAt: '2026-11-15T08:30:00Z', durationMs: 950, inputTokens: 240, outputTokens: 120,
  estimatedCost: 0.004, estimatedCostCurrency: 'USD', upstreamCallCount: 1, statusQueryCount: 0,
}));
async function mock(route) {
  const request = route.request(), url = new URL(request.url()), endpoint = url.pathname.replace(/^\/gw/, '');
  requests.push({ mode, method: request.method(), endpoint, page: url.searchParams.get('page') });
  if (request.method() !== 'GET' && endpoint !== '/auth/login') throw Error('Business write forbidden');
  const dataRows = rows(); let data = { items: [], total: 0 };
  if (endpoint === '/auth/login') data = { token: 'fixture-only', expiresAt: '2099-01-01T00:00:00Z', username: 'owner', displayName: '布局审核', tenant, mustChangePassword: false };
  else if (endpoint === '/healthz') data = { status: 'ok', mapHomeUrl: 'https://example.invalid/' };
  else if (endpoint === '/overview') data = { totalRequests: 0, recentRequests: [], estimatedCosts: [], topUsers: [], topAppCallers: [], topModels: [], serviceKeys: { total: 0 } };
  else if (endpoint === '/logs/meta') data = { models: ['fixture-chat'], providers: ['受控供应方'], appCallers: ['fixture.reader'], statuses: ['failed', 'succeeded'] };
  else if (endpoint === '/logs/summary') data = { total: dataRows.length, upstreamCalls: dataRows.length, succeeded: dataRows.length / 2, failed: dataRows.length / 2, totalTokens: dataRows.length * 360, pricedRequests: dataRows.length, unknownCostRequests: 0, priceCoveragePercent: dataRows.length ? 100 : null, estimatedCostUsd: dataRows.length * .004 };
  else if (endpoint === '/logs') { const page = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('pageSize') || 30); data = { items: dataRows.slice((page - 1) * size, page * size), total: dataRows.length }; }
  return route.fulfill({ json: { success: true, data, error: null } });
}
const source = Object.fromEntries(['src/components/LogsView.tsx', 'src/components/LogsView.css'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const server = await createServer({ root, server: { host: '127.0.0.1', port: 8293, strictPort: true, fs: { allow: [root, fs.realpathSync(path.join(root, 'node_modules'))] } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
const matrices = process.env.CHECK_REPRESENTATIVE ? [[1440, 'light']] : [[1440, 'light'], [1440, 'dark'], [390, 'light'], [390, 'dark']];
try {
  for (const [width, theme] of matrices) {
    mode = 'empty';
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, reducedMotion: 'reduce' });
    await context.route('**/gw/**', mock);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push({ width, theme, message: error.message }));
    const active = new Set();
    page.on('request', request => { if (request.method() === 'GET' && request.url().includes('/gw/')) active.add(request); });
    page.on('requestfinished', request => active.delete(request)); page.on('requestfailed', request => active.delete(request));
    const settle = async () => { let quiet = 0; for (let i = 0; i < 100; i++) { await page.waitForTimeout(50); quiet = active.size ? 0 : quiet + 1; if (quiet >= 4) { await page.evaluate(() => document.fonts.ready); return; } } throw Error('Fixture reads did not settle'); };
    const nav = async name => { const link = page.getByRole('link', { name, exact: true }); if (!await link.isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click(); await link.click(); await settle(); };
    await page.goto('http://127.0.0.1:8293/login', { waitUntil: 'domcontentloaded' });
    await page.locator('#llmgw-username').fill('owner'); await page.locator('#llmgw-password').fill('fixture-only');
    await page.getByRole('button', { name: '进入租户工作区', exact: true }).click(); await page.waitForURL('http://127.0.0.1:8293/'); await page.locator('.lg-console-content').waitFor();
    await nav('请求记录'); assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
    await page.locator('.lg-log-empty').waitFor(); await settle();
    const geometry = async () => page.evaluate(() => {
      const box = selector => { const e = document.querySelector(selector), r = e?.getBoundingClientRect(); return r ? { y: r.y, bottom: r.bottom, height: r.height } : null; };
      return { card: box('.lg-log-table-card'), head: box('.lg-log-table-head'), empty: box('.lg-log-empty'), lastRow: box('.lg-log-table-row:last-child'), footer: box('.lg-log-table-footer'), body: (() => { const e = document.querySelector('.lg-log-table-body'); return { height: e.clientHeight, scroll: e.scrollHeight, top: e.scrollTop, overflowY: getComputedStyle(e).overflowY }; })(), outer: (() => { const e = document.querySelector('.lg-console-content'); return { height: e.clientHeight, scroll: e.scrollHeight, top: e.scrollTop }; })() };
    });
    let measured = await geometry(); results.push({ width, theme, state: 'empty', geometry: measured });
    check(measured.footer.y - measured.empty.bottom <= 8, `${width}/${theme}: empty footer follows content, no stretched empty body`);
    check(measured.card.height > measured.head.height && measured.empty.height > 40, `${width}/${theme}: empty content is not collapsed or clipped`);
    const emptyContents = await page.locator('.lg-log-empty').evaluate(e => [...e.querySelectorAll('strong,span,a,button')].map(node => {
      const r = node.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      return { text: node.textContent, x: r.x, right: r.right, y: r.y, bottom: r.bottom, inViewport: r.x >= 0 && r.right <= innerWidth && r.y >= 56 && r.bottom <= innerHeight, hit: node.contains(document.elementFromPoint(x,y)) };
    }));
    results.push({ width, theme, state: 'empty-content', items: emptyContents });
    check(emptyContents.every(item => item.inViewport && item.hit), `${width}/${theme}: complete empty title, guidance and actions are visible and hittable`);
    await page.screenshot({ path: path.join(out, `empty-${width}-${theme}.png`) });
    mode = 'few'; await page.getByRole('button', { name: '刷新日志', exact: true }).click(); await page.locator('.lg-log-table-row').first().waitFor(); await settle();
    measured = await geometry(); results.push({ width, theme, state: 'few', geometry: measured });
    check(await page.locator('.lg-log-table-row').count() === 2, `${width}/${theme}: two actual rows retained`);
    check(measured.footer.y - measured.lastRow.bottom <= 8, `${width}/${theme}: two-row footer naturally follows last record`);
    await page.screenshot({ path: path.join(out, `two-${width}-${theme}.png`) });
    mode = 'many'; await page.getByRole('button', { name: '刷新日志', exact: true }).click(); await settle();
    measured = await geometry(); results.push({ width, theme, state: 'many-initial', geometry: measured, loaded: await page.locator('.lg-log-table-row').count() });
    check(measured.body.height > 0 && (width > 680 ? measured.body.scroll > measured.body.height : measured.outer.scroll > measured.outer.height), `${width}/${theme}: many rows retain the actual scrolling workspace`);
    const wheel = async () => { const surface = page.locator(width > 680 ? '.lg-log-table-body' : '.lg-console-content'); const r = await surface.boundingBox(); const point = { x: r.x + 24, y: Math.max(80, Math.min(r.y + r.height / 2, page.viewportSize().height - 60)) }; await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, 600); await page.waitForTimeout(120); };
    await wheel();
    const afterWheel = await geometry();
    check(width > 680 ? afterWheel.body.top > measured.body.top : afterWheel.outer.top > measured.outer.top, `${width}/${theme}: real wheel moves the original scrolling surface`);
    let reached = false;
    for (let i = 0; i < 18; i++) {
      await settle();
      const last = page.locator('[data-log-row-id="record-64"]');
      if (await last.count()) { const r = await last.boundingBox(); const clip = await page.locator(width > 680 ? '.lg-log-table-body' : '.lg-console-content').boundingBox(); if (r && r.y >= Math.max(56, clip.y) && r.y + r.height <= Math.min(page.viewportSize().height, clip.y + clip.height) + 1) { reached = true; break; } }
      const more = page.getByRole('button', { name: '加载更多', exact: true });
      if (await more.count() && await more.isEnabled()) { const r = await more.boundingBox(); if (r && r.y >= 56 && r.y + r.height <= page.viewportSize().height) await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2); }
      await wheel();
    }
    check(reached && await page.locator('.lg-log-table-row').count() === 64, `${width}/${theme}: existing continuation reaches record64 by wheel without auto-scroll rescue`);
    await page.screenshot({ path: path.join(out, `many-last-${width}-${theme}.png`) });
    check(await page.getByRole('tab', { name: '业务请求', exact: true }).count() === 1 && await page.getByRole('tab', { name: '上游调用', exact: true }).count() === 1 && await page.getByRole('tab', { name: '会话', exact: true }).count() === 1, `${width}/${theme}: all original view tabs retained`);
    await context.close();
  }
} finally {
  await browser.close(); await server.close();
  check(errors.length === 0, 'no page error');
  const businessWrites = requests.filter(item => item.method !== 'GET' && item.endpoint !== '/auth/login');
  assert.equal(businessWrites.length, 0);
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ provenance: 'actual production components + isolated deterministic API fixtures; not live', source, results, failures, errors, requests, businessWrites }, null, 2));
  console.log(JSON.stringify({ out, failures, checks: results.filter(item => item.check).length }));
  if (failures.length) process.exitCode = 1;
}
