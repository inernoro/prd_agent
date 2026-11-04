/** Synthetic local QA only; no production credentials, database actions or model calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8870';
if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base)) throw Error('Only a local fixture server is allowed');
const out = process.env.CDS_LOADING_EVIDENCE || '/tmp/cds-loading-coverage';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = []; let failOverview = false; let failHealth = true;
try {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname.replace(/^\/_cds/, '');
    if (isEventStream(pathname)) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (pathname === '/api/projects' || pathname === '/api/releases/center') await new Promise(r => setTimeout(r, 1200));
    if (pathname === '/api/cds-system/alarm-channels') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ channels: [], status: [] }) });
    if (pathname === '/api/cds-system/alarm-notify') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: false, source: null }) });
    if (pathname === '/api/cds-system/alarm-identity' || pathname === '/api/cds-system/alarm-relay') {
      await new Promise(r => setTimeout(r, pathname.endsWith('identity') ? 1200 : 2600));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(pathname.endsWith('identity') ? { identity: null } : { enabled: false, receiverHealthy: false, pending: 0 }) });
    }
    if (pathname === '/api/uptime/summary') {
      await new Promise(r => setTimeout(r, 1200));
      return route.fulfill({ status: failHealth ? 500 : 200, contentType: 'application/json', body: JSON.stringify(failHealth ? { error: 'fixture: 健康数据读取失败' } : { enabled: true, intervalSeconds: 45, timeoutMs: 5000, failureThreshold: 3, targets: [] }) });
    }
    if (pathname === '/api/overview/topology') {
      await new Promise(r => setTimeout(r, 1200));
      return route.fulfill({ status: failOverview ? 500 : 200, contentType: 'application/json', body: JSON.stringify(failOverview ? { error: 'fixture: 读取失败，请刷新重试' } : { generatedAt: new Date().toISOString(), summary: { errors: 0, warnings: 0, infos: 0 }, projects: [] }) });
    }
    if (/\/agent-requests$/.test(pathname)) {
      await new Promise(r => setTimeout(r, 1200));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [], users: [], apps: [], liveCount: 0, historyCount: 0 }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(resolveFixture(pathname) ?? {}) });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/cds-settings?loadingPage=common-loading-block&loadingScenario=content-rows#loading-pages');
  await page.locator('[data-content-loading="rows"]').waitFor();
  const style = await page.locator('[data-content-loading] .cds-loading-skeleton-line').first().evaluate(el => { const s = getComputedStyle(el); return { animation: s.animationName, duration: s.animationDuration, gradient: s.backgroundImage }; });
  assert.equal(style.animation, 'cds-loading-skeleton-pulse'); assert.equal(style.duration, '2s'); assert.equal(style.gradient, 'none');
  await page.getByText('仍在读取…', { exact: true }).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: '表格与结果', exact: true }).click();
  await page.locator('[data-content-loading="table"]').waitFor();
  await page.getByText('仍在读取…', { exact: true }).waitFor({ state: 'hidden' });
  for (const [button, variant] of [['日志区域', 'log'], ['资源与总览', 'panel'], ['列表与配置', 'rows']]) {
    await page.getByRole('button', { name: button, exact: true }).click();
    await page.locator(`[data-content-loading="${variant}"]`).waitFor();
  }
  await page.getByRole('button', { name: '切换到黑天主题', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('[data-content-loading] .cds-loading-skeleton-line').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.screenshot({ path: out + '/dark390-reduced.png' });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(base + '/overview');
  await page.locator('[data-content-loading="panel"]').waitFor();
  await page.locator('[data-testid="overview-page"]').waitFor();
  assert.equal(await page.locator('[data-content-loading]').count(), 0, 'data immediately replaces the skeleton');
  failOverview = true; await page.reload();
  await page.getByText(/读取失败/).first().waitFor();
  assert.equal(await page.locator('[data-content-loading]').count(), 0, 'error replaces waiting, rather than an eternal skeleton');
  failOverview = false; await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.locator('[data-testid="overview-page"]').waitFor();
  await page.goto(base + '/agent-requests/fixture-project');
  await page.locator('[data-testid="request-list"] [data-content-loading="table"]').waitFor();
  await page.getByText(/还没有 Agent 请求/).waitFor();
  assert.equal(await page.locator('[data-content-loading]').count(), 0);
  await page.goto(base + '/release-console');
  await page.getByRole('status', { name: '读取发布项目列表', exact: true }).waitFor();
  assert.equal(await page.getByText('没有匹配的项目。', { exact: true }).count(), 0);
  await page.getByRole('status', { name: '读取发布环境列表', exact: true }).waitFor();
  assert.equal(await page.getByText('这个项目还没有发布目标，去发布中心添加环境。', { exact: true }).count(), 0);
  await page.getByRole('status', { name: '读取发布环境列表', exact: true }).waitFor({ state: 'hidden' });
  await page.goto(base + '/cds-settings#alarm-notify');
  await page.getByRole('status', { name: '读取通知身份', exact: true }).waitFor();
  const notification = page.locator('section').filter({ has: page.getByRole('heading', { name: '通知来源与头像', exact: true }) });
  assert.equal(await notification.locator('input').count(), 0);
  assert.equal(await notification.getByText('暂未取得发送方式，请刷新后查看。', { exact: true }).count(), 0);
  await page.getByRole('status', { name: '读取通知发送方式', exact: true }).waitFor();
  await page.getByText('手机通知由当前实例发送。', { exact: true }).waitFor();
  await page.goto(base + '/release-center');
  await page.getByRole('button', { name: /健康监测/ }).click();
  await page.getByRole('status', { name: '读取发布健康数据', exact: true }).waitFor();
  assert.equal(await page.getByText('未配置健康检查地址，趋势不可绘制。', { exact: true }).count(), 0);
  await page.getByRole('alert').filter({ hasText: '健康数据读取失败' }).waitFor();
  failHealth = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('status', { name: '读取发布健康数据', exact: true }).waitFor();
  await page.getByRole('heading', { name: '探测配置', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await fs.writeFile(out + '/result.json', JSON.stringify({ sharedStyles: style, slowWaitClearsOnSceneChange: true, dark390: true, reducedMotion: true, dataErrorRetry: true, agentFirstLoadNoBlank: true, releaseConsoleNoPrematureEmpty: true, notificationNoPrematureFailure: true, healthErrorRetry: true, pageErrors: errors, artificialLatency: 'local synthetic API fixtures only', paidModelRequests: 0 }, null, 2));
  console.log('PASS shared content skeleton; 6s status; scene cleanup; dark390; reduced motion; data/error/retry; Agent first load; release-console pending/empty separation; no page errors');
} catch (error) { const pages=browser.contexts().flatMap(c=>c.pages()); if(pages[0]) { await fs.writeFile(out+'/failure.html',await pages[0].content()); await pages[0].screenshot({path:out+'/failure.png',fullPage:true}); } throw error; } finally { await browser.close(); }
