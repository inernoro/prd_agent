/** 确定性前端诊断，不能替代同提交预览或真实外部依赖验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.resolve(process.env.CDS_TASK_HEALTH_EVIDENCE || path.join(root, '../work/task-health-recovery'));
fs.mkdirSync(evidence, { recursive: true });
const port = Number(process.env.CDS_TASK_HEALTH_PORT || 18937), base = `http://127.0.0.1:${port}`;
const vcs = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { provenance: 'deterministic-fixture', testedCommit: vcs(['rev-parse', 'HEAD']), dirty: Boolean(vcs(['status', '--porcelain', '--untracked-files=no'])), outcome: 'failed', cases: [] };
const now = new Date().toISOString(), originalError = '隔离诊断：执行进程中断，外部结果未知';
const job = { id: 'recovery-fixture', projectId: 'fixture-project', name: '恢复后仍可追溯的任务', enabled: true,
  schedule: { type: 'interval', intervalMinutes: 30 }, timeoutSeconds: 60, retryCount: 0,
  target: { type: 'command', command: 'never-executed-fixture' }, nextRunAt: new Date(Date.now() + 3600000).toISOString(),
  health: { state: 'waiting', message: '未到执行时间', recoveryRequired: false } };
const run = { id: 'recovered-fixture-run', jobId: job.id, projectId: job.projectId, trigger: 'schedule', status: 'success',
  queuedAt: now, startedAt: now, finishedAt: now, durationMs: 1000, exitCode: 0,
  recovery: { failureKind: 'interrupted', error: originalError, failedAt: now, verifiedAt: now } };
const vite = spawn(process.execPath, [path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: path.join(root, 'web'), stdio: 'ignore' });
let browser;
try {
  let ready = false;
  for (let n = 0; n < 150; n++) {
    if (vite.exitCode !== null) throw new Error('隔离 Vite 服务未成功启动');
    try { ready = (await fetch(base)).ok; } catch { /* 等待本轮启动 */ }
    if (ready) break; await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, '隔离前端未就绪');
  const executablePath = process.env.CDS_CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] });
  const widths = process.argv.includes('--desktop-only') ? [1440] : [1440, 375];
  for (const width of widths) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, timezoneId: 'Asia/Shanghai' });
    const item = { width, theme, outcome: 'failed' }; report.cases.push(item);
    let writes = 0, catalogs = 0, documentBoots = 0;
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentBoots++; });
    await page.addInitScript(() => {
      window.__taskHistoryWrites = 0;
      window.__taskLoaderAppearances = 0;
      let loading = false;
      new MutationObserver(() => {
        const visible = Boolean(document.querySelector('[role="status"][aria-label="加载任务调度配置"]'));
        if (visible && !loading) window.__taskLoaderAppearances++;
        loading = visible;
      }).observe(document, { childList: true, subtree: true });
      for (const name of ['pushState', 'replaceState']) {
        const original = history[name];
        history[name] = function(...args) { window.__taskHistoryWrites++; return original.apply(this, args); };
      }
    });
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      return u.origin === base ? route.continue() : route.abort();
    });
    await context.route('**/api/**', route => {
      const request = route.request(), u = new URL(request.url()), p = u.pathname;
      if (request.method() !== 'GET') { writes++; return route.fulfill({ status: 409, json: { error: '诊断禁止执行任何写操作' } }); }
      if (isEventStream(p) || p === '/api/activity-stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      let data = resolveFixture(p) || {};
      if (p === '/api/scheduled-jobs') { catalogs++; data = { jobs: [job] }; }
      if (p === '/api/scheduled-jobs/runs') data = { runs: !u.searchParams.get('jobId') || u.searchParams.get('jobId') === job.id ? [run] : [] };
      return route.fulfill({ json: data });
    });
    try {
      await page.goto(`${base}/project-list`, { waitUntil: 'domcontentloaded' });
      if (width < 1024) await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
      await page.getByRole('link', { name: '任务调度', exact: true }).click();
      await page.locator(`[data-job-row="${job.id}"]`).waitFor();
      const before = { catalogs, documentBoots, history: await page.evaluate(() => window.__taskHistoryWrites), loaders: await page.evaluate(() => window.__taskLoaderAppearances) };
      const actionStarted = performance.now();
      await page.locator(`[data-job-row="${job.id}"]`).click();
      await page.getByRole('button', { name: '返回值班概览', exact: true }).waitFor();
      item.selectionFeedbackMs = Math.round(performance.now() - actionStarted);
      assert.ok(item.selectionFeedbackMs <= 2000, '选中任务的首反馈应在2秒内');
      await page.getByRole('button').filter({ hasText: 'exit 0' }).click();
      await page.locator('[data-recovery-record]').waitFor();
      assert.ok((await page.locator('[data-recovery-record]').innerText()).includes(originalError));
      item.originalFailureVisible = true;
      item.originalFailureVisibleMs = Math.round(performance.now() - actionStarted);
      assert.ok(item.originalFailureVisibleMs <= 3000, '原失败信息应在3秒内可见');
      assert.equal(new URL(page.url()).searchParams.get('job'), job.id, '选中任务必须进入URL，保证刷新能回到原任务');
      await page.waitForTimeout(200);
      assert.equal(catalogs, before.catalogs, '仅改变任务选择不能重新拉取整页目录');
      assert.equal(documentBoots, before.documentBoots, '任务选择不能整页重启');
      assert.equal(await page.evaluate(() => window.__taskLoaderAppearances), before.loaders, '任务选择不能重复展示整页加载器');
      assert.equal(await page.evaluate(() => window.__taskHistoryWrites) - before.history, 1, '每次选择仅写一次history');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '返回值班概览', exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('job'), job.id);
      await page.getByRole('button').filter({ hasText: 'exit 0' }).click();
      await page.locator('[data-recovery-record]').waitFor();
      assert.ok((await page.locator('[data-recovery-record]').innerText()).includes(originalError));
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '不能横向溢出');
      await page.screenshot({ path: path.join(evidence, `${width}-${theme}.png`), fullPage: true });
      await page.getByRole('button', { name: '返回值班概览', exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.get('job'), null);
      assert.equal(writes, 0); assert.deepEqual(errors, []);
      item.outcome = 'passed'; item.writes = writes; item.explicitReloads = 1; item.identityPreserved = true;
    } catch (error) {
      item.error = error.message;
      await page.screenshot({ path: path.join(evidence, `${width}-${theme}-failed.png`), fullPage: true }).catch(() => {});
      throw error;
    }
    finally { await context.close(); }
  }
  report.outcome = 'passed';
} finally {
  await browser?.close();
  const exit = new Promise(resolve => vite.once('exit', resolve));
  vite.kill('SIGTERM'); if (vite.exitCode === null) await exit;
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
