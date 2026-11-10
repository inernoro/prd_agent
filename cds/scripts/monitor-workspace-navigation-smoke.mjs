/**
 * 本机编译页面的导航回归。响应形状裁剪自真实录制，值与鉴权均为合成样本。
 * 只测渲染和导航，不证明操作员登录或生产集成；未知 API、导航写请求都失败。
 * 接入清理回归只拦截明确登记的本机 POST/DELETE，不请求真实后端。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

const recorded = JSON.parse(await fs.readFile(new URL('./fixtures/monitor-workspace-navigation-recording.json', import.meta.url), 'utf8'));
const services = [
  ['alpha-1', '分类甲', '同类异常一', 'down', '区域甲'],
  ['alpha-2', '分类甲', '同类异常二', 'down', '区域乙'],
  ['alpha-3', '分类甲', '正常服务甲', 'up', '区域甲'],
  ['alpha-4', '分类甲', '正常服务乙', 'up', '区域乙'],
  ['beta-1', '分类乙', '跨类异常', 'down', '区域甲'],
  ['beta-2', '分类乙', '正常服务丙', 'up', '区域乙'],
  ['beta-3', '分类乙', '正常服务丁', 'up', '区域甲'],
];
const names = Object.fromEntries(services.map(([id, , name]) => [id, name]));
const targetId = id => `monitor@navigation-${id}`;

function fixtureData() {
  const now = Date.now(), summary = structuredClone(recorded.summary);
  summary.generatedAt = summary.lastCycleAt = now;
  summary.cycle.lastCycleAt = summary.prober.lastCycleAt = now;
  summary.targets = services.map(([id, category, name, status, region], index) => {
    const target = structuredClone(recorded.target), up = status === 'up';
    Object.assign(target, {
      id: targetId(id), collectionTargetId: targetId(id), name, status,
      projectId: category, projectName: category, profileId: id, monitorId: id,
      availability24h: up ? 1 : 0.95, statusSince: now - (index + 1) * 60000,
      openIncidentSince: up ? null : now - (index + 1) * 60000,
      incidentCount: up ? 0 : 1,
      alarmIdentity: { observer: { id: 'fixture', name: '回归观察者', environment: 'test', location: region }, subject: { id, name, environment: 'test', location: region } },
    });
    Object.assign(target.lastSample, { t: now - 500, up, err: up ? undefined : '合成异常，用于导航回归', finding: up ? undefined : '合成异常，用于导航回归' });
    target.lastSample.measurement.actual = up ? 20 : 1240;
    return target;
  });
  summary.overall = { ...summary.overall, total: services.length, up: 4, down: 3, paused: 0, unknown: 0, excluded: 0, unmeasured: 0, ok: false };
  summary.coverage = { ...summary.coverage, total: services.length, covered: services.length };
  summary.prober.lastCycleTargets = services.length;
  return { summary, now };
}

async function installReadOnlyFixtures(context, issues) {
  const { summary, now } = fixtureData();
  await context.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname.replace(/^\/_cds/, '');
    if (request.method() !== 'GET') {
      issues.writes.push(`${request.method()} ${pathname}`);
      return route.abort();
    }
    if (isEventStream(pathname) || pathname === '/api/activity-stream') return route.fulfill({ contentType: 'text/event-stream', body: ': navigation regression\n\n' });
    let body;
    if (pathname === '/api/uptime/summary') body = summary;
    else if (pathname === '/api/uptime/incidents') body = { incidents: [] };
    else if (pathname === '/api/uptime/notifications') body = { settings: { acknowledgedAt: {}, mutedUntil: {}, defaultChannelIds: [], overrides: {} } };
    else if (pathname === '/api/cds-system/alarm-channels') body = { channels: [], status: [] };
    else if (pathname === '/api/cds-system/alarm-identity') body = { identity: null };
    else if (pathname === '/api/cds-system/alarm-deliveries') body = { deliveries: [] };
    else if (pathname === '/api/uptime/monitors') body = { monitors: [] };
    else if (/^\/api\/uptime\/targets\/[^/]+\/history$/.test(pathname)) {
      const id = decodeURIComponent(pathname.split('/')[4]), target = summary.targets.find(value => value.id === id);
      if (target) body = { ...recorded.history, id, name: target.name, from: now - 86400000, to: now, range: url.searchParams.get('range') ?? '24h' };
    } else body = resolveFixture(pathname);
    if (body == null) {
      issues.unregistered.push(pathname);
      return route.abort();
    }
    await route.fulfill({ json: body });
  });
}

async function ready(page, layer, name) {
  await page.waitForFunction(({ layer, name }) => {
    const element = document.querySelector(`.monitor-workspace .L${layer}`);
    if (!element || element.getAttribute('aria-hidden') !== 'false') return false;
    const style = getComputedStyle(element);
    return style.visibility === 'visible' && +style.opacity > 0.99
      && (!element.style.transition || element.style.transition === 'none')
      && (!name || element.querySelector('h2')?.textContent === name);
  }, { layer, name }, { timeout: 10000 });
}

async function beginTrace(page) {
  await page.evaluate(() => {
    window.__monitorNavigationFrames = [];
    window.__monitorNavigationTracing = false;
    document.addEventListener('click', () => {
      window.__monitorNavigationTracing = true;
      const sample = () => {
        if (!window.__monitorNavigationTracing) return;
        const layers = [...document.querySelectorAll('.monitor-workspace .layer')].map(element => {
          const style = getComputedStyle(element), matrix = new DOMMatrixReadOnly(style.transform);
          return { kind: element.classList.contains('Lg') ? 'g' : element.classList.contains('Lc') ? 'c' : 's', visible: style.visibility === 'visible' && +style.opacity > 0.03, matrix: [matrix.a, matrix.d, matrix.e, matrix.f] };
        });
        window.__monitorNavigationFrames.push({ layers, locations: [...document.querySelectorAll('.Lg .loc')].map(element => element.dataset.anchor) });
        requestAnimationFrame(sample);
      };
      sample();
    }, { capture: true, once: true });
  });
}

async function finishTrace(page) {
  return page.evaluate(() => { window.__monitorNavigationTracing = false; return window.__monitorNavigationFrames; });
}

const issueCard = (page, id) => page.locator('.al .ai').filter({ has: page.locator('.nm', { hasText: names[id] }) });
const categoryButton = (page, name) => page.locator('.Lg .ch,.Lg .sgh').filter({ has: page.locator('.cn', { hasText: name }) });

/** 由既有 loading 浏览器流水线调用，也可直接运行本文件；不需要登录或网络凭据。 */
export async function verifyMonitorWorkspaceNavigation(browser, base, out) {
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), '导航合成回归只允许本机');
  await fs.mkdir(out, { recursive: true });
  const results = [];
  const assets = new Set();
  for (const profile of [
    { theme: 'dark', width: 1280, reduced: false },
    { theme: 'light', width: 1600, reduced: false },
    { theme: 'dark', width: 1280, reduced: true },
  ]) {
    const label = `${profile.theme}-${profile.width}-${profile.reduced ? 'reduced' : 'motion'}`;
    const context = await browser.newContext({ viewport: { width: profile.width, height: 800 }, colorScheme: profile.theme, reducedMotion: profile.reduced ? 'reduce' : 'no-preference', ...(process.env.CDS_NAVIGATION_STORAGE_STATE ? { storageState: process.env.CDS_NAVIGATION_STORAGE_STATE } : {}) });
    const issues = { errors: [], unregistered: [], writes: [] };
    await context.addInitScript(theme => localStorage.setItem('cds_theme', theme), profile.theme);
    await installReadOnlyFixtures(context, issues);
    const page = await context.newPage();
    page.on('pageerror', error => issues.errors.push(error.message));
    page.on('response', response => { if (/\/assets\/StatusPage-[^/]+\.js$/.test(response.url())) assets.add(new URL(response.url()).pathname); });
    const start = async () => { await page.goto(`${base}/status`); await ready(page, 'g'); await page.locator('.Lg .it').first().waitFor(); };
    const open = async id => { await issueCard(page, id).click(); await ready(page, 's', names[id]); };
    const run = async (name, action) => {
      const result = { profile: label, name };
      try { await start(); result.evidence = await action(); result.pass = true; }
      catch (error) { result.pass = false; result.error = String(error); await page.screenshot({ path: path.join(out, `${label}-${name}-failure.png`) }); }
      results.push(result);
      console.log(`${result.pass ? 'PASS' : 'FAIL'} monitor ${label}/${name}${result.error ? `: ${result.error}` : ''}`);
    };
    try {
      await run('global-location-preview', async () => {
        await beginTrace(page); await open('alpha-1');
        const frames = await finishTrace(page);
        if (!profile.reduced) assert(frames.some(frame => frame.locations.length), '从右侧进入前没有全局位置高亮');
        return { previewSeen: frames.some(frame => frame.locations.length), frames };
      });
      await run('same-category-swap', async () => {
        await open('alpha-1'); await beginTrace(page); await open('alpha-2');
        const frames = await finishTrace(page);
        assert(frames.length > 1, '切换过程未采到帧');
        assert(!frames.some(frame => frame.layers.some(layer => layer.visible && layer.kind !== 's')), '同分类右侧切换露出了父层');
        return { frames };
      });
      await run('cross-category-swap', async () => {
        await open('alpha-1'); await beginTrace(page); await open('beta-1');
        const frames = await finishTrace(page);
        assert(!frames.some(frame => frame.layers.some(layer => layer.visible && layer.kind !== 's')), '跨分类右侧切换露出了父层');
        return { frames };
      });
      await run('service-scroll-reset', async () => {
        await open('alpha-1');
        const area = await page.locator('.Ls').boundingBox();
        await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
        await page.mouse.wheel(0, 900);
        await page.waitForFunction(() => document.querySelector('.Ls').scrollTop > 20);
        const before = await page.locator('.Ls').evaluate(element => element.scrollTop);
        await open('alpha-2');
        const after = await page.locator('.Ls').evaluate(element => element.scrollTop);
        assert.equal(after, 0, '新服务详情仍停在旧服务的滚动位置');
        return { before, after };
      });
      await run('return-category-selection', async () => {
        await categoryButton(page, '分类甲').click(); await ready(page, 'c', '分类甲');
        await page.locator(`.Lc [data-anchor="svc:${targetId('alpha-1')}"]`).click(); await ready(page, 's', names['alpha-1']);
        await page.getByRole('button', { name: '返回分类', exact: true }).click(); await ready(page, 'c', '分类甲');
        const selected = await page.locator('.Lc .it.sel').getAttribute('data-anchor');
        assert.equal(selected, `svc:${targetId('alpha-1')}`, '返回分类未保留来源服务的选中');
        return { selected };
      });
      await run('other-anomaly-shortcut', async () => {
        await open('alpha-1'); await page.locator('.oth .ochip').filter({ hasText: '分类乙' }).click();
        await ready(page, 's', names['beta-1']);
        return { service: await page.locator('.Ls h2').textContent() };
      });
      await run('skip-return-service-origin', async () => {
        const origin = await page.locator(`.Lg [data-anchor="svc:${targetId('alpha-1')}"]`).evaluate(element => {
          const row = element.getBoundingClientRect(), canvas = document.querySelector('.ws').getBoundingClientRect();
          return { x: row.x + row.width / 2 - canvas.x, y: row.y + row.height / 2 - canvas.y };
        });
        await open('alpha-1'); await beginTrace(page);
        await page.getByRole('button', { name: '返回全部服务', exact: true }).click(); await ready(page, 'g');
        const frames = await finishTrace(page);
        if (!profile.reduced) {
          const zoom = frames.flatMap(frame => frame.layers).find(layer => layer.kind === 'g' && layer.matrix[0] > 1.05);
          assert(zoom, '返回过程没有采到来源视角');
          const [sx, sy, tx, ty] = zoom.matrix, fixed = { x: -tx / (sx - 1), y: -ty / (sy - 1) };
          assert(Math.hypot(fixed.x - origin.x, fixed.y - origin.y) < 4, `返回落点偏离来源服务行：${JSON.stringify({ origin, fixed })}`);
          return { origin, fixed, frames };
        }
        return { origin, frames };
      });
      assert.deepEqual(issues, { errors: [], unregistered: [], writes: [] });
      await page.screenshot({ path: path.join(out, `${label}-ready.png`) });
    } catch (error) { results.push({ profile: label, name: 'browser-or-contract', pass: false, error: String(error), issues }); }
    finally { await context.close(); }
  }
  const report = { scope: 'Loopback-only compiled application with recorded-shape synthetic data/auth; not operator-login or production acceptance', assets: [...assets], results };
  await fs.writeFile(path.join(out, 'monitor-navigation-results.json'), JSON.stringify(report, null, 2));
  assert.equal(assets.size, 1, '本轮必须始终使用同一份编译后的监控资源');
  assert(results.every(result => result.pass), results.filter(result => !result.pass).map(result => `${result.profile}/${result.name}: ${result.error}`).join('\n'));
  return report;
}

/** 过期轮询和关闭竞态：回放录制的 session-created 形状，不创建任何真实会话。 */
export async function verifyMonitorOnboardingSessionCleanup(browser, base, out) {
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), '接入清理合成回归只允许本机');
  await fs.mkdir(out, { recursive: true });
  const results = [];
  const assets = new Set();
  const cases = [
    { name: 'poll404-cancel', pollStatus: 404, action: 'cancel' },
    { name: 'poll410-mcp', pollStatus: 410, action: 'mcp' },
    { name: 'close-before-poll-delete404', deleteStatus: 404, action: 'close' },
    { name: 'mcp-before-poll-delete410', deleteStatus: 410, action: 'mcp' },
    { name: 'delete401-preserves-dialog', deleteStatus: 401, action: 'close', mustFail: true },
    { name: 'delete403-preserves-dialog', deleteStatus: 403, action: 'close', mustFail: true },
    { name: 'delete-network-preserves-dialog', deleteStatus: 'network', action: 'close', mustFail: true },
  ];
  for (const scenario of cases) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', ...(process.env.CDS_NAVIGATION_STORAGE_STATE ? { storageState: process.env.CDS_NAVIGATION_STORAGE_STATE } : {}) });
    const issues = { errors: [], unregistered: [], writes: [] }, calls = [];
    await context.addInitScript(() => localStorage.setItem('cds_theme', 'dark'));
    await installReadOnlyFixtures(context, issues);
    const created = structuredClone(recorded.onboardingCreated);
    created.expiresAt = Date.now() + 3600000;
    created.timeline[0].at = new Date().toISOString();
    let releasePoll, closing = false, deleteStatus = scenario.deleteStatus ?? 404;
    const pollGate = new Promise(resolve => { releasePoll = resolve; });
    await context.route('**/api/uptime/onboarding**', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname.replace(/^\/_cds/, ''), method = request.method();
      calls.push({ method, pathname });
      if (pathname === '/api/uptime/onboarding' && method === 'POST') return route.fulfill({ status: 201, json: created });
      if (pathname === `/api/uptime/onboarding/${created.id}` && method === 'GET') {
        if (scenario.pollStatus) return route.fulfill({ status: scenario.pollStatus, json: { error: scenario.pollStatus === 404 ? '接入会话不存在，请重新开始。' : '接入令牌已过期，请重新开始。' } });
        // 关闭先于轮询结果：不要依赖鼠标是否赶在500ms定时器前执行。
        await pollGate;
        if (closing) return route.abort().catch(() => undefined);
        const { token: _token, scope: _scope, ...view } = created;
        return route.fulfill({ json: view });
      }
      if (pathname === `/api/uptime/onboarding/${created.id}` && method === 'DELETE') {
        if (deleteStatus === 'network') return route.abort('connectionfailed');
        return route.fulfill({ status: deleteStatus, json: deleteStatus === 200 ? { ok: true } : { error: deleteStatus === 404 ? '接入会话不存在，请重新开始。' : deleteStatus === 410 ? '接入令牌已过期，请重新开始。' : '没有管理本次接入会话的权限，请重新登录后重试。' } });
      }
      issues.unregistered.push(`${method} ${pathname}`);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => issues.errors.push(error.message));
    page.on('response', response => { if (/\/assets\/StatusPage-[^/]+\.js$/.test(response.url())) assets.add(new URL(response.url()).pathname); });
    const result = { name: scenario.name, calls };
    try {
      await page.goto(`${base}/status`); await ready(page, 'g');
      await page.getByRole('button', { name: '接入我的服务', exact: true }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: '已交给智能体', exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('.drawer .code')?.textContent.includes('INVALID_NAVIGATION_REPLAY_TOKEN'));
      if (scenario.pollStatus) {
        await dialog.getByRole('alert').waitFor();
        assert(!(await dialog.locator('.code').textContent()).includes('INVALID_NAVIGATION_REPLAY_TOKEN'), '过期轮询仍保留已失效令牌');
      }
      const action = scenario.action === 'mcp' ? dialog.getByRole('button', { name: '连接 MCP', exact: true }) : scenario.action === 'cancel' ? dialog.getByRole('button', { name: '取消', exact: true }) : dialog.getByRole('button', { name: '关闭', exact: true });
      await action.click();
      if (scenario.mustFail) {
        await dialog.getByRole('alert').waitFor();
        assert(await dialog.isVisible(), '鉴权或网络失败被当作清理成功');
        await page.waitForFunction(() => document.querySelector('.drawer .xb')?.disabled === false);
        assert.equal(calls.filter(call => call.method === 'DELETE').length, 1, '失败时不应自行重复撤销');
        deleteStatus = 200;
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await dialog.waitFor({ state: 'hidden', timeout: 5000 });
        result.failureVisibleAndRetryCloses = true;
      } else if (scenario.action === 'mcp') await dialog.getByLabel('MCP 服务地址', { exact: true }).waitFor({ timeout: 5000 });
      else await dialog.waitFor({ state: 'hidden', timeout: 5000 });
      if (scenario.pollStatus) assert.equal(calls.filter(call => call.method === 'DELETE').length, 0, '轮询已终结会话，关闭时仍使用了旧active引用');
      else assert(calls.some(call => call.method === 'DELETE'), '关闭竞态没有执行合成撤销请求');
      assert.deepEqual(issues, { errors: [], unregistered: [], writes: [] });
      result.pass = true;
      await page.screenshot({ path: path.join(out, `${scenario.name}.png`) });
    } catch (error) { result.pass = false; result.error = String(error); result.issues = issues; await page.screenshot({ path: path.join(out, `${scenario.name}-failure.png`) }); }
    finally { closing = true; releasePoll(); await context.close(); }
    results.push(result);
    console.log(`${result.pass ? 'PASS' : 'FAIL'} onboarding cleanup ${scenario.name}${result.error ? `: ${result.error}` : ''}`);
  }
  const report = { scope: 'Loopback-only onboarding cleanup regression; recorded session shape and fully intercepted synthetic POST/DELETE, no backend sessions or monitors created', assets: [...assets], results };
  await fs.writeFile(path.join(out, 'onboarding-cleanup-results.json'), JSON.stringify(report, null, 2));
  assert.equal(assets.size, 1, '本轮接入回归必须使用同一份编译资源');
  assert(results.every(result => result.pass), results.filter(result => !result.pass).map(result => `${result.name}: ${result.error}`).join('\n'));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv.find(argument => /^https?:/.test(argument)) ?? 'http://127.0.0.1:8870';
  const outFlag = process.argv.indexOf('--out'), out = outFlag >= 0 ? process.argv[outFlag + 1] : '/tmp/cds-monitor-navigation';
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try { const report = await (process.argv.includes('--only-onboarding') ? verifyMonitorOnboardingSessionCleanup : verifyMonitorWorkspaceNavigation)(browser, base, out); console.log(`PASS monitor regression: ${report.results.length} cases`); }
  finally { await browser.close(); }
}
