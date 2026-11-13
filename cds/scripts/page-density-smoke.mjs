// Browser layout contract for the additional CDS pages. Synthetic API data is not live acceptance.
// --layout-only keeps geometry assertions but skips new interactions, so the old layout can fail on the same criteria.
// --measure-only records the baseline without setting an assertion exit code.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

const base = process.argv[2] || 'http://127.0.0.1:8870';
const measureOnly = process.argv.includes('--measure-only');
const layoutOnly = measureOnly || process.argv.includes('--layout-only');
const out = path.resolve(process.env.CDS_PAGE_DENSITY_OUT || path.join(os.tmpdir(), 'cds-page-density'));
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CDS_CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
const measurements = [], failures = [], unexpected = new Set();
const check = (condition, message) => { if (!condition) failures.push(message); };
const project = resolveFixture('/api/projects').projects[0];
const profile = id => ({ id, projectId: project.id, name: id, dockerImage: `fixture/${id}:latest`, command: 'node server.js', containerPort: 8080, workDir: '.', dependsOn: [] });
const task = i => ({ id: `review-${i}`, projectId: project.id, title: `布局审查 ${i + 1}`, sourceType: 'zip', sourceName: 'source.zip', status: 'completed', phase: '报告已归档', progress: { totalFiles: 2, scannedFiles: 2 }, createdAt: '2026-11-13T10:00:00Z', updatedAt: '2026-11-13T10:00:00Z', delivery: { status: 'not_requested' }, findingsSummary: { high: 0, medium: 0, low: 1 } });
try {
  for (const width of (process.env.CDS_PAGE_DENSITY_WIDTH ? [Number(process.env.CDS_PAGE_DENSITY_WIDTH)] : [1440, 390])) for (const theme of (process.env.CDS_PAGE_DENSITY_THEME ? [process.env.CDS_PAGE_DENSITY_THEME] : ['light', 'dark'])) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390, colorScheme: theme, reducedMotion: 'reduce' });
    let count = 2, mismatch = false, failed = false, owner = true, nodeCount = 2;
    const profiles = () => Array.from({ length: nodeCount }, (_, i) => profile(i ? `web-${i}` : 'api'));
    const branch = () => ({ ...resolveFixture('/api/branches').branches[0], githubCommitSha: (mismatch ? 'b' : 'a').repeat(40), commitSha: 'a'.repeat(40), subject: '', services: Object.fromEntries(profiles().map(p => [p.id, { profileId: p.id, containerName: `fixture-${p.id}`, status: 'running', hostPort: 8080, port: 8080 }])) });
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url()), pathname = url.pathname.replace(/^\/_cds/, '');
      if (isEventStream(pathname)) return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
      let data;
      if (pathname === '/api/auth/status') data = { authenticated: true, enabled: true, user: { name: '布局核验', isSystemOwner: owner } };
      else if (pathname === '/api/overview/topology') data = { generatedAt: '2026-11-13T10:00:00Z', summary: { errors: 1, warnings: 0, infos: 0 }, projects: [{ projectId: project.id, slug: project.slug, name: project.name, branch: { id: branch().id, name: branch().branch, status: 'running' }, branchCount: 1, counts: { services: 2, sites: 1, apis: 1, webs: 1, workers: 0 }, lint: { errors: 1, warnings: 0, infos: 0 }, headline: '样例依赖需要检查', findings: [{ rule: 'fixture-link', severity: 'error', services: ['api'], message: '样例引用目标没有运行', fix: '检查引用目标' }], edges: [], inboundEdges: 0 }] };
      else if (pathname === '/api/code-reviews') {
        if (failed) return route.fulfill({ status: 503, json: { error: '审查列表暂不可用' } });
        const limit = 10, offset = Math.min(Number(url.searchParams.get('offset') || 0), Math.max(0, Math.ceil(count / limit) - 1) * limit);
        data = { tasks: Array.from({ length: Math.min(limit, Math.max(0, count - offset)) }, (_, i) => task(offset + i)), totals: { source: count, report: 0, all: count }, newCount: 0, historyCount: 0, snapshotAt: '2026-11-13T10:00:00Z', page: { offset, limit, total: count, nextOffset: offset + limit < count ? offset + limit : null } };
      } else if (pathname === '/api/branches') data = { ...resolveFixture(pathname), branches: [branch()] };
      else if (pathname === '/api/releases/center') data = { ...resolveFixture(pathname), rows: resolveFixture(pathname).rows.map(row => ({ ...row, dora: { windowDays: 30, fromAt: '2026-10-13T10:00:00Z', toAt: '2026-11-13T10:00:00Z', frequency: { successCount: 12, perDay: 0.4, medianIntervalMs: 60000 }, changeFailure: { total: 14, failed: 2, ratio: 2 / 14 }, recovery: { sampleCount: 2, p50Ms: 300000, p90Ms: 600000, ongoingCount: 0, recoveredUnknownDurationCount: 0 }, leadTime: { sampleCount: 12, eligibleCount: 12, p50Ms: 60000, p90Ms: 60000 } }, commitPosition: { behindCount: 3 } })) };
      else if (pathname === '/api/uptime/summary') data = { enabled: true, generatedAt: Date.now(), intervalSeconds: 60, timeoutMs: 5000, failureThreshold: 3, firstDataEtaSeconds: 0, lastCycleAt: Date.now(), alarmChannels: [], overall: { total: 2, up: 1, down: 1, paused: 0, unknown: 0, ok: false }, targets: Array.from({ length: 2 }, (_, i) => ({ id: `monitor-${i}`, source: 'custom', name: `布局检查 ${i + 1}`, branchId: '', projectId: project.id, profileId: '', probeKind: 'http', status: i ? 'up' : 'down', lastSample: { t: Date.now(), up: !!i, ms: 20, code: i ? 200 : 503 }, availability24h: 0.99, availability7d: 0.99, avgLatencyMs24h: 20, sampleCount24h: 50, buckets: [], openIncidentSince: null, statusSince: Date.now(), incidentCount: 0, probeDescription: '检查样例业务结果', intervalSeconds: 60, timeoutMs: 5000, environment: 'production', environmentLabel: '正式', observeMode: 'active' })) };
      else if (/\/inspection-checks$/.test(pathname)) data = { inspections: [] };
      else if (pathname === '/api/cds-system/alarm-deliveries') data = { deliveries: [], suppressed: [], truncated: false };
      else if (pathname === '/api/build-profiles') data = { profiles: profiles() };
      else if (/\/profile-overrides$/.test(pathname)) data = { profiles: profiles().map(p => ({ profileId: p.id, profileName: p.name, baseline: p, effective: p, hasOverride: false, override: null, cdsEnvKeys: [] })) };
      else if (/\/git-log$/.test(pathname)) data = { commits: [] };
      else if (/\/container-logs$/.test(pathname)) data = { logs: '样例日志，没有真实服务被调用。' };
      else if (pathname === '/api/proxy-log') data = { events: [] };
      else if (pathname === '/api/routing-rules') data = { rules: [] };
      else {
        data = resolveFixture(pathname);
        if (data === null) { unexpected.add(pathname); data = {}; }
      }
      await route.fulfill({ json: data });
    });
    const page = await context.newPage();
    page.on('pageerror', error => failures.push(`${width}/${theme}: ${error.message}`));
    const settle = async () => { await page.evaluate(() => document.fonts.ready); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
    const save = async name => { await settle(); await page.screenshot({ path: `${out}/${name}-${width}-${theme}.png` }); check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), `${name}/${width}/${theme}: document overflow`); };
    // Real application navigation with fixture data, not a token/storage bypass.
    await page.goto(`${base}/project-list`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: project.name, exact: true }).waitFor();
    check(await page.evaluate(() => innerWidth) === width, `${width}/${theme}: viewport is not the requested CSS width`);
    if (width === 390) check(await page.evaluate(() => navigator.maxTouchPoints > 0 && matchMedia('(pointer:coarse)').matches), `${width}/${theme}: narrow run is not a touch context`);
    // Narrow navigation uses the shell's native menu, then follows the same anchor.
    const navigate = async href => {
      if (!(await page.locator(`a[href="${href}"]:visible`).count())) await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
      await page.locator(`a[href="${href}"]:visible`).first().click();
    };
    await navigate('/overview');
    await page.locator('[data-testid="overview-page"]').waitFor(); await save('overview');
    const graph = page.locator('[data-testid="overview-page"] > div').first();
    const graphBox = await graph.boundingBox();
    measurements.push({ page: 'overview', width, theme, graphWidth: graphBox.width, graphY: graphBox.y });
    if (width === 390) check(graphBox.width >= 320, `${width}/${theme}: problem sidebar squeezes relationship canvas`);
    if (!layoutOnly) { await graph.focus(); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(120); check(await graph.evaluate(e => e.scrollLeft > 0), `${width}/${theme}: graph cannot be scrolled by keyboard`); }
    // Direct route below is deliberately a deterministic layout fixture, not preview-live proof.
    await page.goto(`${base}/branch-panel/${branch().id}`, { waitUntil: 'domcontentloaded' });
    const service = page.getByRole('button', { name: /^api/ }).first(); await service.waitFor(); await save('branch-detail');
    const serviceBox = await service.boundingBox();
    measurements.push({ page: 'branch-detail', width, theme, firstServiceY: serviceBox.y });
    check(serviceBox.y < (width === 390 ? 560 : 370), `${width}/${theme}: metadata delays first service`);
    if (!layoutOnly) {
      const consistency = page.locator('summary').filter({ hasText: '提交一致性' });
      await consistency.focus(); await page.keyboard.press('Enter');
      check(await page.getByText('GitHub 目标', { exact: true }).isVisible(), `${width}/${theme}: version details unreachable`);
      await consistency.click();
      mismatch = true; await page.reload(); await page.getByText('当前运行提交与 GitHub 目标提交不一致，请重新部署并观察构建日志中的拉取前后版本。', { exact: true }).waitFor(); await page.locator('summary').filter({ hasText: '提交一致性' }).click(); check(await page.getByText('当前运行提交与 GitHub 目标提交不一致，请重新部署并观察构建日志中的拉取前后版本。', { exact: true }).isVisible(), `${width}/${theme}: collapsing SHA detail hides mismatch warning`); await save('branch-detail-mismatch'); mismatch = false;
    }
    await page.goto(`${base}/branch-topology?project=${project.id}`, { waitUntil: 'domcontentloaded' });
    const node = page.getByRole('button', { name: /^api/ }).first(); await node.waitFor(); await save('branch-topology');
    const nodeBox = await node.boundingBox(); measurements.push({ page: 'branch-topology', width, theme, firstNodeY: nodeBox.y });
    check(nodeBox.y < (width === 390 ? 760 : 355), `${width}/${theme}: repeated summaries delay topology nodes`);
    if (!layoutOnly) {
      const select = page.locator('select').filter({ has: page.locator('option[value=""]', { hasText: '共享视图' }) }).first();
      await select.selectOption(branch().id); check(await page.getByText('分支详情', { exact: true }).isVisible(), `${width}/${theme}: single-branch context missing`);
      await select.selectOption(''); nodeCount = 0; await page.reload(); await page.getByText('还没有服务节点', { exact: true }).waitFor(); await save('branch-topology-empty');
      nodeCount = 25; await page.reload(); await page.getByRole('button', { name: /^web-24/ }).scrollIntoViewIfNeeded(); await save('branch-topology-many'); nodeCount = 2;
    }
    await page.goto(`${base}/code-reviews`, { waitUntil: 'domcontentloaded' });
    await page.getByText('布局审查 1', { exact: true }).filter({ visible: true }).first().waitFor(); await save('code-reviews-few');
    const pager = page.locator('.cr-pagination');
    measurements.push({ page: 'code-reviews', width, theme, firstDataY: (await page.locator(width === 390 ? '[data-code-review-mobile-row]' : '[data-code-review-row]').first().boundingBox()).y, pagerHeight: (await pager.boundingBox()).height, pagerButtons: await pager.getByRole('button').count() });
    check(await pager.getByRole('navigation').count() === 0, `${width}/${theme}: single-page review has meaningless pagination`);
    if (width === 390) check((await page.locator('[data-code-review-mobile-row]').first().boundingBox()).y < 390, `${width}/${theme}: a low-frequency history control delays the first review row`);
    if (!layoutOnly) {
      count = 25; await page.reload(); await page.getByRole('button', { name: '下一页任务', exact: true }).click(); await page.getByText('布局审查 11', { exact: true }).filter({ visible: true }).first().waitFor(); await page.getByRole('button', { name: '第 3 页', exact: true }).click(); await page.getByText('布局审查 25', { exact: true }).filter({ visible: true }).first().waitFor(); await save('code-reviews-many');
      count = 0; await page.reload(); await page.getByRole('heading', { name: '还没有代码审查记录', exact: true }).waitFor(); check(await page.getByRole('navigation', { name: '任务分页', exact: true }).count() === 0, `${width}/${theme}: empty review pagination`); await save('code-reviews-empty');
      failed = true; await page.reload(); await page.getByText('任务列表暂时无法刷新，已保留上次结果。', { exact: true }).waitFor(); check(await page.getByRole('button', { name: '重试读取', exact: true }).isVisible(), `${width}/${theme}: missing retry`); failed = false;
      owner = false; await page.goto(`${base}/branch-panel/${branch().id}`); await page.getByRole('button', { name: /^api/ }).first().waitFor(); await save('branch-detail-readonly');
    }
    owner = true;
    await page.goto(`${base}/release-center?project=${project.id}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '环境与配置', exact: true }).click();
    await page.getByText('发布模式', { exact: true }).waitFor(); await save('release-center-config');
    measurements.push({ page: 'release-center-config', width, theme, firstFieldY: (await page.getByText('发布模式', { exact: true }).boundingBox()).y });
    check(!(await page.getByText('近 30 天发布', { exact: true }).isVisible()), `${width}/${theme}: low-frequency metrics crowd environment configuration`);
    if (!layoutOnly) {
      const metrics = page.locator('summary').filter({ hasText: '近 30 天发布指标' });
      await metrics.focus(); await page.keyboard.press('Enter');
      check(await page.getByText('近 30 天发布', { exact: true }).isVisible(), `${width}/${theme}: release metrics no longer reachable`);
    }
    await page.goto(`${base}/release-console?project=${project.id}`, { waitUntil: 'domcontentloaded' });
    const version = page.getByLabel('要发布的版本', { exact: true }); await version.waitFor(); await save('release-console');
    const versionBox = await version.boundingBox(); measurements.push({ page: 'release-console', width, theme, versionY: versionBox.y });
    if (width === 390) check(versionBox.y < 170, `${width}/${theme}: flex basis forces a separate decorative icon row`);
    await page.goto(`${base}/status/${project.id}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '全部常设检查', exact: true }).waitFor(); await save('project-status');
    const headerHeight = (await page.locator('.project-status-page > header').boundingBox()).height;
    measurements.push({ page: 'project-status', width, theme, headerHeight, firstCheckY: (await page.locator('#checks tbody tr').first().boundingBox()).y });
    check(headerHeight < (width === 390 ? 350 : 300), `${width}/${theme}: repeated status metric cards delay checks`);
    await page.goto(`${base}/preview-preparing?branch=fixture-audit`, { waitUntil: 'domcontentloaded' });
    const previewContext = page.getByText('fixture-audit', { exact: true }); await previewContext.waitFor(); await save('preview-preparing');
    measurements.push({ page: 'preview-preparing', width, theme, contextY: (await previewContext.boundingBox()).y });
    check(await page.getByText('68%', { exact: true }).count() === 0, `${width}/${theme}: preview transit presents fabricated progress`);
    check((await previewContext.boundingBox()).y < (width === 390 ? 400 : 350), `${width}/${theme}: repeated transit branding delays branch context`);
    await context.close();
  }
} finally { await browser.close(); }
fs.writeFileSync(`${out}/measurements.json`, JSON.stringify({ provenance: 'deterministic-fixture', measurements, failures, unexpected: [...unexpected] }, null, 2));
console.log(JSON.stringify({ out, measurements, failures, unexpected: [...unexpected] }));
if (!measureOnly && (failures.length || unexpected.size)) process.exitCode = 1;
