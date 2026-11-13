// Deterministic UI contract; fixture results do not replace authenticated preview acceptance.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { resolveFixture, isEventStream, FIXTURE_PROJECT_ID } from './fixtures/mobile-layout-fixtures.mjs';
import { startViteDevServer } from './lib/vite-dev-server.mjs';
const server = process.argv.includes('--offline') ? await startViteDevServer() : null;
const base = server?.url || process.argv.find(arg => /^https?:/.test(arg)) || 'http://127.0.0.1:8870';
const out = path.resolve(process.env.CDS_RESOURCE_DENSITY_OUT || '/tmp/cds-resource-variables-density');
fs.mkdirSync(out, { recursive: true });
const failures = [], measurements = [], unexpected = new Set();
let browser;
const check = (ok, message) => { if (!ok) failures.push(message); };
try {
  browser = await chromium.launch({ executablePath: process.env.CDS_CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    let variableCount = 3;
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390, colorScheme: theme, reducedMotion: 'reduce' });
    const resource = () => ({ id: 'infra:mongodb', source: 'infra', kind: 'database', runtime: 'MongoDB', displayName: 'MongoDB :10001', serviceName: 'MongoDB', branchId: 'fixture-branch-alpha', branchName: 'feature/alpha', projectId: FIXTURE_PROJECT_ID, port: 10001, containerPort: 27017, status: 'running', access: 'internal', envKeys: Array.from({ length: variableCount }, (_, i) => variableCount === 3 ? ['MONGODB_HOST', 'MONGODB_PORT', 'MONGODB_URL'][i] : `MONGODB_FIXTURE_KEY_${i}`), dependsOn: [], consumers: ['api'], raw: { id: 'mongodb', status: 'running' } });
    await context.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET') { unexpected.add(`${route.request().method()} ${pathname}`); return route.fulfill({ status: 405, json: {} }); }
      if (isEventStream(pathname)) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      let body;
      if (/\/resources$/.test(pathname)) body = { resources: [resource()] };
      else if (/\/resources\/[^/]+\/permissions$/.test(pathname)) body = { role: 'member', productionLike: true, actions: Object.fromEntries(['resource-restart','external-temporary-access','external-policy-admin','database-clone','database-connect-existing','backup-create','backup-restore','credentials-reset','connection-inject','data-clear','data-write','resource-delete'].map(key => [key, { allowed: false, requiredRole: 'admin', reason: '布局合成只读权限' }])) };
      else if (/\/resources\/[^/]+\/logs$/.test(pathname)) body = { logs: '合成日志内容，未调用真实数据库。' };
      else { body = resolveFixture(pathname); if (body === null) { unexpected.add(pathname); body = {}; } }
      await route.fulfill({ json: body });
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => failures.push(`${width}/${theme}: ${error.message}`));
    const open = async () => {
      await page.goto(`${base}/branches/${FIXTURE_PROJECT_ID}`, { waitUntil: 'domcontentloaded' });
      await page.locator('[aria-label^="打开 "][aria-label$=" 详情"]').first().click();
      const drawer = page.locator('.cds-branch-detail-drawer'); await drawer.waitFor();
      await drawer.getByRole('button', { name: '资源', exact: true }).click();
      await drawer.getByRole('button', { name: '变量', exact: true }).last().click();
      await drawer.getByText(variableCount === 3 ? 'MONGODB_HOST' : 'MONGODB_FIXTURE_KEY_0', { exact: true }).waitFor();
      return drawer;
    };
    const drawer = await open();
    await page.evaluate(() => document.fonts.ready);
    const metric = await drawer.getByText('MONGODB_HOST', { exact: true }).evaluate(element => {
      const list = element.parentElement.parentElement, frame = list.parentElement.parentElement;
      const rows = [...list.children], last = rows.at(-1).getBoundingClientRect(), box = frame.getBoundingClientRect();
      return { firstDataY: element.getBoundingClientRect().y, frameHeight: box.height, trailingBlank: box.bottom - last.bottom, lastDataBottom: last.bottom, frameBottom: box.bottom, font: getComputedStyle(element).fontSize, rowHeight: rows[0].getBoundingClientRect().height, minHeight: getComputedStyle(frame).minHeight };
    });
    measurements.push({ width, theme, ...metric });
    check(metric.trailingBlank <= 32, `${width}/${theme}: three scalar variable rows leave ${metric.trailingBlank}px forced blank frame`);
    check(await drawer.getByText('可注入依赖应用', { exact: true }).count() === 3, `${width}/${theme}: variable meaning lost`);
    for (const name of ['启动', '重启', '停止']) check(await drawer.getByRole('button', { name, exact: true }).isDisabled(), `${width}/${theme}: read-only ${name} permission changed`);
    await page.screenshot({ path: `${out}/variables-few-${width}-${theme}.png` });
    check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `${width}/${theme}: horizontal overflow`);
    variableCount = 30; const manyDrawer = await open();
    const last = manyDrawer.getByText('MONGODB_FIXTURE_KEY_29', { exact: true }); await last.scrollIntoViewIfNeeded();
    check(await last.isVisible(), `${width}/${theme}: last variable unreachable`);
    check(await manyDrawer.locator('code').filter({ hasText: /^MONGODB_FIXTURE_KEY_/ }).count() === 30, `${width}/${theme}: variables omitted`);
    await page.screenshot({ path: `${out}/variables-many-${width}-${theme}.png` });
    await manyDrawer.getByRole('button', { name: '日志', exact: true }).last().click();
    const selectedLogTab = manyDrawer.getByRole('button', { name: '日志', exact: true }).last();
    const workspace = selectedLogTab.locator('../..');
    const minimum = await workspace.evaluate(element => ({ actual: parseFloat(getComputedStyle(element).minHeight), expected: parseFloat(getComputedStyle(document.documentElement).fontSize) * 38.75 }));
    check(minimum.actual >= minimum.expected - 1, `${width}/${theme}: log workspace minimum space reduced`);
    await context.close();
  }
} catch (error) { failures.push(`execution: ${error.message}`); }
finally { if (browser) await browser.close(); server?.stop(); }
fs.writeFileSync(`${out}/measurements.json`, JSON.stringify({ provenance: 'deterministic-fixture', measurements, failures, unexpected: [...unexpected] }, null, 2));
console.log(JSON.stringify({ out, measurements, failures, unexpected: [...unexpected] }));
if (failures.length || unexpected.size) process.exitCode = 1;
