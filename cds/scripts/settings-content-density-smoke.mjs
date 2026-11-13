// Browser layout evidence from deterministic fixtures; this is not live integration acceptance.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

const dist = path.resolve(process.env.CDS_SETTINGS_DIST || 'cds/web/dist');
const out = path.resolve(process.env.CDS_SETTINGS_EVIDENCE || path.join(os.tmpdir(), 'cds-settings-density'));
const measureOnly = process.argv.includes('--measure-only');
fs.mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const candidate = path.resolve(dist, `.${pathname}`);
  const file = candidate.startsWith(`${dist}${path.sep}`) && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : path.join(dist, 'index.html');
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
const measurements = [];
const assert = (ok, message) => { if (!ok) throw Error(message); };
try {
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390, colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript(value => localStorage.setItem('cds_theme', value), theme);
    let count = 2, failRead = false, failWrite = false, owner = true;
    const errors = [], unexpected = new Set();
    page.on('pageerror', error => errors.push(error.message));
    const users = () => Array.from({ length: count }, (_, i) => ({ id: `user-${i}`, username: `user${String(i + 1).padStart(2, '0')}`, name: `样例账号 ${i + 1}`, authProvider: 'local', status: i % 2 ? 'disabled' : 'active', isSystemOwner: false }));
    const keys = () => Array.from({ length: count }, (_, i) => ({ id: `key-${i}`, label: `布局 Key ${String(i + 1).padStart(2, '0')}`, scope: 'global', access: { canCreateProjects: true, projects: [] }, createdAt: '2026-11-13T10:00:00Z' }));
    const env = () => Object.fromEntries(Array.from({ length: count }, (_, i) => [`CDS_SAMPLE_${String(i + 1).padStart(2, '0')}`, `样例变量 ${i + 1}`]));
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), pathname = url.pathname.replace(/^\/_cds/, '');
      if (isEventStream(pathname)) return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
      if (failRead && ['/api/env', '/api/auth/users', '/api/global-agent-keys', '/api/cds-system/alarm-channels'].includes(pathname)) return route.fulfill({ status: 503, json: { error: '读取暂不可用，请重试' } });
      if (failWrite && request.method() === 'POST' && ['/api/auth/users', '/api/global-agent-keys'].includes(pathname)) return route.fulfill({ status: 503, json: { error: '保存暂不可用，请重试' } });
      let data;
      if (pathname === '/api/auth/status') data = { authenticated: true, enabled: true, user: { id: 'fixture-owner', name: '布局测试', isSystemOwner: owner } };
      else if (pathname === '/api/auth/public-status') data = { enabled: true, mode: 'basic', capabilities: { userManagement: true, userActivity: true, durableUsers: true } };
      else if (pathname === '/api/me') data = { user: { id: 'fixture-owner', username: 'owner', name: '布局测试', authProvider: 'legacy', isSystemOwner: owner } };
      else if (pathname === '/api/auth/users') data = request.method() === 'POST' ? { user: users()[0] } : { users: users() };
      else if (pathname === '/api/auth/activity') data = { activity: [] };
      else if (pathname === '/api/detect-stack') data = { databaseInit: null, summary: 'fixture' };
      else if (pathname === '/api/identity/connections') data = { users: [], requests: [], unclaimed: [] };
      else if (pathname === '/api/global-agent-keys') data = request.method() === 'POST' ? { keyId: 'new-key', plaintext: 'cdsg_fixture_not_a_credential', preview: 'fixture', access: { canCreateProjects: true, projects: [] } } : { keys: keys() };
      else if (pathname === '/api/cds-system/alarm-notify') data = { configured: false, source: null };
      else if (pathname === '/api/cds-system/alarm-identity') data = { identity: { instance: { id: 'fixture-instance', name: '样例实例', environment: '测试', location: '', iconUrl: '' } } };
      else if (pathname === '/api/cds-system/alarm-relay') data = { enabled: true, receiverHealthy: true, pending: 0 };
      else if (/^\/api\/cds-system\/alarm-channels\/[^/]+\/drill$/.test(pathname)) data = { ok: true };
      else if (pathname === '/api/cds-system/alarm-channels') data = { channels: Array.from({ length: count }, (_, i) => ({ id: `channel-${i}`, name: `样例通道 ${String(i + 1).padStart(2, '0')}`, kind: 'bark', enabled: true, projects: [], events: ['business-down', 'business-recovered'], bark: { keySet: true, keyTail: 'test' } })), status: Array.from({ length: count }, (_, i) => ({ id: `channel-${i}`, name: '样例通道', status: 'healthy', kind: 'bark', enabled: true, projects: [], events: [] })) };
      else if (pathname === '/api/env') data = { env: env(), inheritGlobal: false };
      else if (pathname === '/api/env/categorize') {
        assert(request.postDataJSON().dryRun === true, '整理预览不应绕过确认执行');
        data = { targetProjectId: 'fixture-project', groups: { duplicated: [], moved: ['SAMPLE_PROJECT'], globalOnly: ['CDS_SAMPLE_01'] }, summary: { changeCount: 1, movedCount: 1, globalOnlyCount: 1 } };
      } else {
        data = resolveFixture(pathname);
        if (data === null) { unexpected.add(pathname); data = {}; }
      }
      await route.fulfill({ json: data });
    });
    await page.goto(`${base}/project-list`);
    await page.locator('a[href="/cds-settings"]').first().click();
    const surfaces = [
      { tab: 'CDS 全局变量', id: 'global-vars', first: 'CDS_SAMPLE_01' },
      { tab: '用户管理', id: 'users', first: 'user01' },
      { tab: 'AI Access Key', id: 'access-keys', first: '布局 Key 01' },
      { tab: '通知通道', id: 'alarm-notify', first: '样例通道 01' },
    ];
    for (const surface of surfaces.filter(s => !process.env.CDS_SETTINGS_SURFACE || s.id === process.env.CDS_SETTINGS_SURFACE)) {
      await page.getByRole('tab', { name: surface.tab, exact: true }).click();
      await page.locator('.cds-settings-content').evaluate(e => e.scrollTo(0, 0));
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByText(surface.first, { exact: true }).first().waitFor();
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
      const first = page.getByText(surface.first, { exact: true }).first();
      const box = await first.boundingBox();
      const beforeScroll = await page.evaluate(() => [...document.querySelectorAll('*')].filter(e => e.scrollTop > 0).reduce((n, e) => n + e.scrollTop, 0));
      const row = { provenance: 'deterministic-fixture', surface: surface.id, width, theme, count, firstDataY: box.y, coreTask: '进入标签后定位首条数据', coreTaskSteps: 0, preDataOptionalHeight: await page.locator('[role=tabpanel][data-state=active]').evaluate((panel, {id, y}) => { const height = e => e?.getBoundingClientRect().height || 0; if (id === 'global-vars') return [...panel.querySelectorAll('div')].find(e => e.firstElementChild?.textContent?.trim() === '一键整理：把项目级变量迁到具体项目')?.getBoundingClientRect().height || 0; if (id === 'access-keys') { const input = panel.querySelector('input[placeholder^="可选标签"]'); return input?.closest('details') ? 0 : height(input?.parentElement); } if (id === 'users') { const headings = [...panel.querySelectorAll('h2')]; return headings.filter(h => ['修改密码', '创建本地账号'].includes(h.textContent) && h.getBoundingClientRect().y < y).reduce((n, h) => n + height(h.closest('section')), 0); } const identity = panel.querySelector('section'); return identity && identity.getBoundingClientRect().y < y ? height(identity) : 0; }, {id: surface.id, y: box.y}), firstDataFont: await first.evaluate(e => getComputedStyle(e).fontSize), initialScroll: beforeScroll, overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) };
      measurements.push(row);
      fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(measurements, null, 2));
      await page.screenshot({ path: path.join(out, `${surface.id}-${width}-${theme}.png`) });
      const scrollBefore = await first.evaluate(e => { const values = []; for (let p = e.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight) values.push(p.scrollTop); return values; });
      await first.scrollIntoViewIfNeeded();
      row.coreTaskScroll = await first.evaluate((e, before) => { const values = []; for (let p = e.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight) values.push(p.scrollTop); return values.reduce((n, v, i) => n + Math.abs(v - (before[i] || 0)), 0); }, scrollBefore);
      fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(measurements, null, 2));
      if (measureOnly) continue;
      assert(!row.overflow, `${surface.id}: 文档横向溢出`);
      if (surface.id === 'global-vars') {
        const organizer = page.locator('summary').filter({ hasText: '整理项目级变量' });
        assert(await organizer.count() === 1, '变量迁移应按需打开，不能先占据记录前空间');
        assert((await organizer.boundingBox()).y > box.y, '低频变量整理不应出现在变量数据前');
        await page.getByPlaceholder('搜索 key / value').fill('02');
        assert(await page.getByText('CDS_SAMPLE_01', { exact: true }).count() === 0, '变量筛选未生效');
        await page.getByRole('button', { name: '编辑 CDS_SAMPLE_02', exact: true }).click();
        await page.getByRole('button', { name: '取消编辑 CDS_SAMPLE_02', exact: true }).click();
        await page.getByPlaceholder('搜索 key / value').fill('');
        await organizer.focus(); await page.keyboard.press('Enter');
        await page.getByRole('button', { name: '预览整理方案', exact: true }).click();
        await page.getByRole('button', { name: '确认整理 1 个变量', exact: true }).waitFor();
        await page.getByRole('button', { name: '取消', exact: true }).click();
      } else if (surface.id === 'users') {
        assert(!await page.getByPlaceholder('如 alice', { exact: true }).isVisible(), '创建账号表单不应挤在用户数据前');
        const password = await page.getByRole('heading', { name: '修改密码', exact: true }).boundingBox();
        assert(password.y > box.y, '用户管理应先呈现既有账号');
        const create = page.locator('summary').filter({ hasText: '创建本地账号' });
        await create.focus(); await page.keyboard.press('Enter');
        await page.getByPlaceholder('如 alice', { exact: true }).fill('fixture-user');
        await page.getByPlaceholder('初始密码', { exact: true }).fill('fixture-password');
        failWrite = true;
        await page.getByRole('button', { name: '创建账号', exact: true }).click();
        await page.getByText(/保存暂不可用/).first().waitFor();
        if (width === 1440 && theme === 'light') { await page.waitForTimeout(3500); assert(await page.getByText(/保存暂不可用/).first().isVisible(), '表单错误不能随成功toast计时器退场'); }
        failWrite = false;
        await create.click();
      } else if (surface.id === 'access-keys') {
        assert(await page.getByText('安全警告:全局 Key 等同管理员权限', { exact: true }).isVisible(), '管理员权限安全警告丢失');
        assert(!await page.getByPlaceholder(/可选标签/).isVisible(), '完整签发表单不应先于已有密钥占据首屏');
        const sign = page.locator('summary').filter({ hasText: '签发新 Key' });
        await sign.focus(); await page.keyboard.press('Enter');
        assert(await page.getByText('授权范围', { exact: true }).isVisible(), '签发授权范围丢失');
        failWrite = true;
        await page.getByRole('button', { name: '签发', exact: true }).click();
        await page.getByText(/保存暂不可用/).first().waitFor();
        if (width === 1440 && theme === 'light') { await page.waitForTimeout(3500); assert(await page.getByText(/保存暂不可用/).first().isVisible(), '表单错误不能随成功toast计时器退场'); }
        failWrite = false;
        await page.getByRole('button', { name: '签发', exact: true }).click();
        await page.getByText('cdsg_fixture_not_a_credential', { exact: true }).waitFor();
        if (width === 1440 && theme === 'light') await page.waitForTimeout(6500);
        await sign.click();
        assert(await page.getByText('cdsg_fixture_not_a_credential', { exact: true }).isVisible(), '一次性明文不应随签发表单隐藏');
        await page.getByRole('button', { name: '我已保存,关闭提示', exact: true }).click();
      } else {
        const identity = await page.getByRole('heading', { name: '通知来源与头像', exact: true }).boundingBox();
        assert(identity.y > box.y, '低频通知身份配置不应把可用通道与演练挤出首屏');
        await page.getByRole('button', { name: '演练', exact: true }).first().click();
        await page.getByText(/演练已送达/).first().waitFor();
        await page.getByRole('button', { name: '编辑', exact: true }).first().click();
        await page.getByRole('button', { name: '取消', exact: true }).click();
        assert(await page.getByText('旧版 MAP 通道未配置', { exact: true }).isVisible(), '旧版通道状态应准确，不应否定已配置通道');
      }
      count = 31;
      await page.reload();
      const last = surface.id === 'global-vars' ? 'CDS_SAMPLE_31' : surface.id === 'users' ? 'user31' : surface.id === 'access-keys' ? '布局 Key 31' : '样例通道 31';
      await page.getByText(last, { exact: true }).first().scrollIntoViewIfNeeded();
      assert(await page.getByText(last, { exact: true }).first().isVisible(), `${surface.id}: 大集合末项不可达`);
      count = 0; await page.reload();
      const empty = surface.id === 'global-vars' ? '没有全局变量。跨项目共享的 CDS 配置可以直接在这里添加；项目独有配置请进入项目设置。' : surface.id === 'users' ? '还没有用户' : surface.id === 'access-keys' ? /还没有签发/ : /一条通知通道都没有/;
      await page.getByText(empty, { exact: typeof empty === 'string' }).first().waitFor();
      failRead = true; await page.reload();
      await page.getByText(/读取暂不可用/).first().waitFor();
      failRead = false; count = 2; await page.reload(); await page.getByText(surface.first, { exact: true }).first().waitFor();
    }
    {
      // The shared EnvEditor remains usable in project settings, including inheritance controls.
      await page.locator('a[href="/project-list"]').first().click();
      await page.locator('article[data-project-id] .cds-project-actions button').first().click();
      await page.locator('a[href^="/settings/"]').first().click();
      await page.getByRole('tab', { name: '项目环境变量', exact: true }).click();
      await page.getByText('CDS_SAMPLE_01', { exact: true }).first().waitFor();
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
      const projectFirst = page.getByText('CDS_SAMPLE_01', { exact: true }).first();
      measurements.push({ provenance: 'deterministic-fixture', surface: 'project-env', width, theme, count, preDataOptionalHeight: await page.getByText('配置向导', { exact: true }).evaluateAll(es => es.reduce((n, e) => n + (e.parentElement?.parentElement?.getBoundingClientRect().height || 0), 0)), firstDataY: (await projectFirst.boundingBox()).y, firstDataFont: await projectFirst.evaluate(e => getComputedStyle(e).fontSize), overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
      fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(measurements, null, 2));
      assert(await page.getByText(/继承.*全局/).first().isVisible(), '项目继承范围不可见');
      await page.screenshot({ path: path.join(out, `project-env-${width}-${theme}.png`) });
      if (!measureOnly) {
      await page.getByRole('button', { name: '打开向导', exact: true }).click();
      await page.getByRole('dialog').getByRole('heading', { name: '配置项目环境变量', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      owner = false; await page.reload();
      await page.locator('a[href="/cds-settings"]').first().click();
      assert(await page.getByRole('tab', { name: 'AI Access Key', exact: true }).count() === 0, '成员不应看到密钥管理入口');
      assert(await page.getByRole('tab', { name: '用户管理', exact: true }).count() === 0, '成员不应看到用户管理入口');
      }
    }
    assert(errors.length === 0, `页面异常: ${errors.join('; ')}`);
    assert(unexpected.size === 0, `未登记API fixture: ${[...unexpected].join(', ')}`);
    await page.close();
  }
  console.log(JSON.stringify({ provenance: 'deterministic-fixture', snapshots: measurements.length, status: measureOnly ? 'MEASURED' : 'PASS', out }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
