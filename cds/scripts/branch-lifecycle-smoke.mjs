import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { startViteDevServer } from './lib/vite-dev-server.mjs';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';
// 真实浏览器、合成API，验证界面操作；不代替线上Docker验收。
const { chromium } = createRequire(import.meta.url)('playwright');
const output = process.env.BRANCH_LIFECYCLE_OUT || '/tmp/branch-lifecycle-acceptance';
fs.mkdirSync(output, { recursive: true });
const now = new Date().toISOString();
const runtime = { kind: 'release', label: '极速版', prebuilt: true, activeProfiles: 2, releaseProfiles: 2 };
const svc = (id, status) => ({ profileId: id, containerName: 'fixture-' + id, status, hostPort: id === 'api' ? 13001 : 13002 });
const seed = (id, extra) => ({ id, projectId: 'fixture-project', branch: 'feature/' + id, status: 'idle', services: {}, createdAt: now, lastPushAt: now, deployRuntime: runtime, ...extra });
const server = await startViteDevServer();
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
  for (const theme of ['dark', 'light']) {
    const branches = [
      seed('main', { branch: 'main', status: 'running', services: { api: svc('api', 'running'), web: svc('web', 'running') } }),
      seed('healthy', { status: 'running', services: { api: svc('api', 'running'), web: svc('web', 'running') } }),
      seed('partial', { services: { api: svc('api', 'running'), web: svc('web', 'error') }, errorMessage: '部分服务未就绪' }),
      seed('ci-timeout', { ciImageStatus: 'failed', ciWorkflowConclusion: 'timed_out_no_run' }),
      seed('ci-waiting', { ciImageStatus: 'waiting' }),
    ];
    const calls = [];
    const context = await browser.newContext({ viewport: { width: Number(process.env.BRANCH_LIFECYCLE_VIEWPORT_WIDTH) || 1920, height: 1080 } });
    await context.addInitScript(value => localStorage.setItem('cds_theme', value), theme);
    await context.route('**/api/**', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (isEventStream(pathname)) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
      let body = resolveFixture(pathname) || {};
      if (pathname === '/api/branches') body = { branches, capacity: { maxContainers: 50, runningContainers: 5, totalMemGB: 64 } };
      if (pathname === '/api/projects/fixture-project') body = { ...body, branchCount: branches.filter(b => !b.archive).length };
      if (pathname === '/api/build-profiles') body = { profiles: ['api', 'web'].map(id => ({ id, projectId: 'fixture-project', name: id, dockerImage: 'fixture/image', containerPort: 8080 })) };
      if (pathname === '/api/projects/fixture-project/branches/lifecycle-cleanup') {
        const input = request.postDataJSON(); calls.push(input);
        const candidates = branches.filter(b => !b.archive && b.id !== 'main' && (input.mode === 'all' || b.id !== 'healthy'));
        body = { candidates: candidates.map(b => ({ id: b.id, branch: b.branch, running: Object.values(b.services).some(s => s.status === 'running') })), skipped: [{ id: 'main', reason: '主干保护' }] };
        if (!input.dryRun) {
          assert.equal(input.confirm, true);
          for (const b of candidates) {
            for (const s of Object.values(b.services)) s.status = 'stopped';
            b.status = 'idle'; b.archive = { archivedAt: now, retireAt: new Date(Date.now() + 30 * 86400000).toISOString(), reason: '清理未完全启动分支，保留数据30天', actor: 'fixture-user' };
          }
          body = { archivedCount: candidates.length, failed: [], skipped: [{ id: 'main' }] };
        }
      }
      const restore = /^\/api\/projects\/fixture-project\/branches\/([^/]+)\/restore-archive$/.exec(pathname);
      if (restore) { branches.find(b => b.id === restore[1]).archive = null; body = { ok: true }; }
      const detail = branches.find(b => pathname === '/api/branches/' + b.id); if (detail) body = detail;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await context.newPage(), errors = [];
    const mobile = page.viewportSize().width < 768;
    const toolbar = async name => {
      const button = page.getByRole('button', { name, exact: true });
      if (mobile && !await button.isVisible()) await page.locator('.cds-topbar').getByRole('button', { name: '更多操作', exact: true }).click();
      return button;
    };
    const closeToolbar = async () => { if (mobile) await page.keyboard.press('Escape'); };
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url + '/branch-list?project=fixture-project');
    const group = page.locator('section[aria-label="未运行的分支"]'); await group.waitFor();
    assert.match(await group.innerText(), /2/);
    if (!await page.locator('[data-branch-card-id="ci-timeout"]').isVisible()) await group.getByRole('button').first().click();
    await page.locator('[data-branch-card-id="ci-timeout"]').waitFor();
    assert.equal(await group.locator('[data-branch-card-id]').count(), 2);
    await page.screenshot({ path: output + '/' + theme + '-01-grouping.png', fullPage: true, animations: 'disabled' });
    await (await toolbar('清理分支')).click();
    const primary = page.getByText('清理未完全启动的（主要）', { exact: true });
    assert.ok(await primary.evaluate(node => Boolean(node.compareDocumentPosition([...document.querySelectorAll('button')].find(b => b.textContent === '清理所有')) & Node.DOCUMENT_POSITION_FOLLOWING)));
    await page.screenshot({ path: output + '/' + theme + '-02-cleanup-menu.png', fullPage: true, animations: 'disabled' });
    await primary.click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor(); assert.match(await dialog.innerText(), /将归档 3 个分支/);
    assert.equal(calls.filter(c => c.confirm).length, 0);
    await page.screenshot({ path: output + '/' + theme + '-03-preview.png', fullPage: true, animations: 'disabled' });
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= page.viewportSize().width + 1, '确认弹窗不超出视口');
    await dialog.getByRole('button', { name: '确认停止并归档' }).click();
    await dialog.waitFor({ state: 'hidden' }); await closeToolbar();
    await page.waitForFunction(() => document.querySelectorAll('[data-branch-card-id]').length === 2);
    assert.equal(branches.find(b => b.id === 'partial').services.api.status, 'stopped');
    assert.equal(branches.find(b => b.id === 'main').services.api.status, 'running');
    assert.equal(branches.find(b => b.id === 'healthy').services.api.status, 'running');
    await page.screenshot({ path: output + '/' + theme + '-04-active-list.png', fullPage: true, animations: 'disabled' });
    await (await toolbar('归档 3')).click(); await closeToolbar();
    await page.locator('[data-archived-branch-id="ci-timeout"]').waitFor();
    assert.equal(await page.locator('[data-archived-branch-id]').count(), 3);
    assert.match(await page.locator('h2').first().innerText(), /3 个归档分支.*保留30天/);
    assert.doesNotMatch(await page.locator('h2').first().innerText(), /在构建|运行中/);
    await page.screenshot({ path: output + '/' + theme + '-05-archive.png', fullPage: true, animations: 'disabled' });
    await page.locator('[data-archived-branch-id="ci-timeout"]').getByRole('button', { name: '恢复分支' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-archived-branch-id]').length === 2);
    await (await toolbar('返回分支')).click(); await closeToolbar();
    await page.locator('[data-branch-card-id="ci-timeout"]').waitFor();
    await (await toolbar('清理分支')).click(); await page.getByText('清理所有', { exact: true }).click();
    await dialog.waitFor(); assert.match(await dialog.innerText(), /feature\/healthy/);
    await page.screenshot({ path: output + '/' + theme + '-06-all-confirm.png', fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Escape'); assert.equal(calls.filter(c => c.confirm).length, 1); assert.deepEqual(errors, []);
    console.log('PASS ' + theme + ': 未运行归类、菜单顺序、清理预览、归档恢复、主干与健康分支保护');
    await context.close();
  }
} finally { await browser?.close(); await server.stop(); }
