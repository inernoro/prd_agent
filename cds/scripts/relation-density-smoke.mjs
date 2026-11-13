// Deterministic browser evidence. Injected API data does not prove preview or backend acceptance.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startViteDevServer } from './lib/vite-dev-server.mjs';
import { resolveFixture, isEventStream, FIXTURE_PROJECT_ID } from './fixtures/mobile-layout-fixtures.mjs';
import { relationFixtures } from './fixtures/relation-fixtures.mjs';

const out = path.resolve(process.env.CDS_RELATION_DENSITY_OUT || path.join(os.tmpdir(), 'cds-relation-density'));
const label = process.env.CDS_RELATION_DENSITY_LABEL || 'after';
const widths = process.env.CDS_RELATION_DENSITY_WIDTH ? [Number(process.env.CDS_RELATION_DENSITY_WIDTH)] : [1440, 390];
const server = process.argv[2] ? null : await startViteDevServer();
const base = process.argv[2] || server.url;
const results = [], failures = [];
const check = (value, message) => { if (!value) failures.push(message); };
const finding = (severity, index = 0) => ({ rule: `${severity === 'info' ? 'role-by-name' : severity === 'warn' ? 'prefix-by-convention' : 'prefix-conflict'}-${index}`, severity, services: ['web', 'api'], message: severity === 'info' ? '2 个服务的角色靠服务名或默认值推断：app-api-gateway、background-worker-service' : `配置${severity === 'error' ? '错误' : '警告'} ${index + 1}：服务的路径声明需要核实，避免请求落到错误的服务。`, fix: severity === 'info' ? '给它们声明 cds.role: web / api / worker，声明后不再依赖名字' : '检查服务声明，并保留唯一且正确的路径前缀。' });
const payload = (findings) => {
  const value = structuredClone(relationFixtures().minimal);
  value.lint = { findings, summary: { errors: findings.filter(x => x.severity === 'error').length, warnings: findings.filter(x => x.severity === 'warn').length, infos: findings.filter(x => x.severity === 'info').length } };
  return value;
};
const taskScroll = async (scope, steps) => {
  const scrolls = () => scope.evaluate(root => ({ document: document.scrollingElement.scrollTop, graph: root.querySelector('[data-testid="relation-graph"]').scrollTop }));
  const before = await scrolls();
  await scope.locator('[data-testid="relation-graph"] [data-role]').first().scrollIntoViewIfNeeded();
  const after = await scrolls();
  return { steps, scrollPx: Math.abs(after.document - before.document) + Math.abs(after.graph - before.graph) };
};
const stable = async page => { await page.evaluate(() => document.fonts.ready); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
const measure = async scope => {
  const metrics = await scope.evaluate(root => {
  const graph = root.querySelector('[data-testid="relation-graph"]');
  const box = element => { const r = element.getBoundingClientRect(); return { y: r.y, height: r.height, width: r.width, font: getComputedStyle(element).fontSize }; };
  return { viewport: [innerWidth, innerHeight], graph: box(graph), panel: box(root.firstElementChild), entry: box(graph.querySelector('[data-node="entry"]')), service: box(graph.querySelector('[data-role]')), documentOverflow: document.documentElement.scrollWidth > innerWidth, graphOverflow: graph.scrollWidth > graph.clientWidth + 1, visibleInfo: 0 };
  });
  // Chromium may retain layout boxes for descendants of closed native details;
  // use rendered visibility rather than a nonzero bounding box as the predicate.
  for (const finding of await scope.locator('[data-finding][data-severity="info"]').all()) if (await finding.isVisible()) metrics.visibleInfo += 1;
  return metrics;
};
fs.mkdirSync(out, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CDS_CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
  for (const width of widths) for (const theme of (process.env.CDS_RELATION_DENSITY_THEME ? [process.env.CDS_RELATION_DENSITY_THEME] : ['light', 'dark'])) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390, colorScheme: theme, reducedMotion: 'reduce' });
    let current = payload([finding('info')]);
    const unknown = new Set(), pageErrors = [];
    await context.addInitScript(theme => { localStorage.setItem('cds_theme', theme); }, theme);
    await context.route('**/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname.replace(/^\/_cds/, '');
      if (isEventStream(pathname)) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      let data;
      if (pathname.endsWith('/service-graph')) data = current;
      else { data = resolveFixture(pathname); if (data === null) { unknown.add(pathname); data = {}; } }
      await route.fulfill({ json: data });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', e => pageErrors.push(e.message));
    const name = `${label}-${width}-${theme}`;
    try {
      // Existing UI entry: branch list → detail → relationship card → expanded workspace.
      await page.goto(`${base}/branches/${encodeURIComponent(FIXTURE_PROJECT_ID)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.locator('[aria-label^="打开 "][aria-label$=" 详情"]').first().click();
      const card = page.locator('[data-testid="relation-card"]:not([data-loading])').first();
      await card.waitFor(); await card.scrollIntoViewIfNeeded();
      await card.getByRole('button', { name: '展开', exact: true }).click();
      const sheet = page.locator('[data-testid="relation-sheet"]');
      const workspace = sheet.locator('[data-testid="relation-workspace"]');
      await workspace.locator('[data-node="entry"]').waitFor(); await stable(page);
      const info = await measure(workspace);
      results.push({ label, width, theme, state: 'info-only-sheet', provenance: 'deterministic-fixture', ...info, task: await taskScroll(workspace, 2) });
      await page.screenshot({ path: path.join(out, `${name}-info-sheet.png`) });
      check(info.panel.height <= 65, `${name}: non-blocking suggestion details occupy ${info.panel.height}px before the graph (budget 65px)`);
      check(!(await workspace.innerText()).includes('需要处理'), `${name}: informational suggestions must not be labelled actionable problems`);
      check(info.visibleInfo === 0, `${name}: non-blocking suggestion details should be available on demand`);
      check(info.graph.height >= (width === 390 ? 500 : 600), `${name}: graph loses useful workspace height`);
      check(!info.documentOverflow && !info.graphOverflow, `${name}: relationship workspace has horizontal overflow`);
      const more = workspace.locator('summary[data-testid="relation-findings-more"]');
      if (await more.count()) {
        await more.focus(); await page.keyboard.press('Enter');
        check(await workspace.locator('[data-finding][data-severity="info"]').first().isVisible(), `${name}: Enter cannot open suggestion details`);
        await page.screenshot({ path: path.join(out, `${name}-info-expanded.png`) });
        results.push({ label, width, theme, state: 'info-expanded', provenance: 'deterministic-fixture', ...(await measure(workspace)) });
        await workspace.locator('[data-finding][data-severity="info"]').first().focus();
        await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('[data-testid="relation-sheet"] [data-node="entry"]')).opacity) < 0.5);
        const dimmed = await workspace.locator('[data-node="entry"]').evaluate(e => Number(getComputedStyle(e).opacity));
        check(dimmed < 0.5, `${name}: keyboard focus no longer highlights related services`);
        await more.focus(); await page.keyboard.press('Space');
        check(!(await workspace.locator('[data-finding][data-severity="info"]').first().isVisible()), `${name}: Space cannot close suggestion details`);
      } else check(false, `${name}: suggestion disclosure is not a native keyboard-accessible summary`);
      await page.keyboard.press('Escape');
      check(await sheet.count() === 0 && await card.isVisible(), `${name}: Escape must close only relationship sheet`);
      await card.getByRole('button', { name: '全屏', exact: true }).click();
      const full = page.locator('[data-testid="relation-workspace"]');
      await full.locator('[data-node="entry"]').waitFor(); await stable(page);
      const fullInfo = await measure(full);
      results.push({ label, width, theme, state: 'info-only-full', provenance: 'deterministic-fixture', ...fullInfo, task: await taskScroll(full, 3) });
      await page.screenshot({ path: path.join(out, `${name}-info-full.png`) });
      check(fullInfo.panel.height <= 65, `${name}: full-page suggestion details occupy ${fullInfo.panel.height}px before graph`);
      const topAction = async name => {
        if (width < 768) await page.getByRole('button', { name: '更多操作', exact: true }).click();
        await page.getByRole('button', { name, exact: true }).click();
        if (width < 768) await page.keyboard.press('Escape');
      };
      const refresh = { click: () => topAction('刷新') };
      for (const [state, findings] of [['mixed', [finding('error'), finding('warn'), finding('info')]], ['many', [...Array.from({ length: 9 }, (_, i) => finding(i % 2 ? 'warn' : 'error', i)), finding('info')]], ['none', []]]) {
        current = payload(findings); await refresh.click();
        await page.waitForFunction(expected => document.querySelector('[data-testid="relation-workspace"]')?.querySelectorAll('[data-finding][data-severity="error"], [data-finding][data-severity="warn"]').length === expected, findings.filter(x => x.severity !== 'info').length);
        await stable(page);
        const metrics = await measure(full);
        results.push({ label, width, theme, state, provenance: 'deterministic-fixture', ...metrics });
        await page.screenshot({ path: path.join(out, `${name}-${state}.png`) });
        const actionable = full.locator('[data-finding][data-severity="error"], [data-finding][data-severity="warn"]');
        if (findings.length) {
          check(await actionable.count() === findings.filter(x => x.severity !== 'info').length, `${name}/${state}: actionable findings were removed`);
          check(await actionable.evaluateAll(elements => elements.every(e => !e.closest('details:not([open])'))), `${name}/${state}: errors or warnings are hidden in a closed disclosure`);
          await actionable.last().scrollIntoViewIfNeeded();
          check(await actionable.last().isVisible(), `${name}/${state}: last actionable finding unreachable`);
          check(metrics.visibleInfo === 0, `${name}/${state}: suggestions expand by default`);
          check(metrics.graph.height >= (width === 390 ? 240 : 300), `${name}/${state}: findings consume entire graph workspace`);
        } else check(metrics.panel.height <= 65, `${name}/none: clear health status occupies ${metrics.panel.height}px`);
        check(!metrics.documentOverflow && !metrics.graphOverflow, `${name}/${state}: horizontal overflow`);
      }
      current = payload([finding('info')]); await refresh.click();
      await page.waitForFunction(() => Boolean(document.querySelector('[data-severity="info"]') || document.querySelector('[data-testid="relation-findings-more"]')));
      await topAction('只看问题'); await stable(page);
      check(await full.locator('[data-severity="info"]').count() === 0, `${name}: only-problems still includes informational suggestions`);
      check((await measure(full)).panel.height <= 65, `${name}: only-problems has empty health scaffolding`);
      check(pageErrors.length === 0, `${name}: unexpected browser errors: ${pageErrors.join(';')}`);
      check(unknown.size === 0, `${name}: unknown API fixtures: ${[...unknown].join(',')}`);
    } catch (error) { failures.push(`${name}: ${error.message}`); }
    finally { await context.close(); fs.writeFileSync(path.join(out, `${label}-results.json`), JSON.stringify({ provenance: 'deterministic-fixture', results, failures }, null, 2)); }
  }
} finally { await browser?.close(); server?.stop(); }
console.log(JSON.stringify({ output: out, measurements: results.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
