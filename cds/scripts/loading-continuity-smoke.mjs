/** 本机验收：分别拦住 lazy chunk 与 API。所有响应合成，不调用真实模型/部署。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { verifyPublicLoading } from './loading-public-smoke.mjs';
import { verifySettingsRefresh } from './project-settings-refresh-smoke.mjs';
import { verifyLoadingRefresh } from './loading-refresh-smoke.mjs';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv.find(a => /^http/.test(a)) ?? 'http://127.0.0.1:8870';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), '合成验收仅允许本机，不拦截真实公网请求');
const flag = process.argv.indexOf('--out');
const out = path.resolve(flag >= 0 ? process.argv[flag + 1] : '/tmp/cds-loading-smoke');
await fs.mkdir(out, { recursive: true });
const onlyFlag = process.argv.indexOf('--only');
const only = onlyFlag >= 0 ? process.argv[onlyFlag + 1].split(',') : null;
const before = process.argv.includes('--before');
const scenes = JSON.parse(await fs.readFile(path.join(here, '../web/src/components/skeletons/loading-scenes.json'), 'utf8'));
const selectors = {
  projects: '[aria-label="加载项目列表"]', branches: '[aria-label="加载项目与本地分支列表"]',
  'branch-detail': '[aria-label^="加载分支详情"]', relations: '[data-content-loading="panel"]',
  'agent-table': '[data-agent-requests-skeleton]', 'topology': '[data-topology-page-skeleton]', 'release-center': '[data-release-center-skeleton]', monitor: '[aria-label="正在读取监控数据"]',
  settings: '[data-settings-content-skeleton]', 'project-settings': '[data-settings-page-skeleton]',
  'release-console': '[data-release-console-skeleton]', rows: '[role="status"][aria-busy="true"]',
};
const gate = () => { let release; const promise = new Promise(r => release = r); return { promise, release }; };
const browser = await chromium.launch({ headless: true });
const results = [];

// REG-stsmk-report-external-link-001: real built viewer, isolated synthetic APIs only.
async function verifyAuthenticatedReportNavigation() {
  for (const format of ['html', 'md']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
    const supervisorId = '1'.repeat(32), appendixId = '2'.repeat(32), missingId = '3'.repeat(32);
    const project = 'fixture-project', canonicalProject = 'canonical-fixture-project', folder = '4'.repeat(32), title = `受保护主管-${format}`;
    const reports = [
      { id: supervisorId, title, format, projectId: canonicalProject, projectSlug: project, folderId: folder, sizeBytes: 300, createdAt: '2026-11-07T00:00:00Z' },
      { id: appendixId, title: `技术附录-${format}`, format, projectId: canonicalProject, projectSlug: project, folderId: folder, sizeBytes: 100, createdAt: '2026-11-07T00:00:00Z' },
    ];
    const target = `${base}/reports?project=${project}&report=${appendixId}`;
    const missing = `${base}/reports?project=${project}&report=${missingId}`;
    const raw = format === 'html'
      ? `<h1>${title}</h1><a target="_blank" href="${target}">打开技术附录</a><a target="_blank" href="${missing}">未列出报告</a>`
      : `# ${title}\n\n[打开技术附录](${target})\n\n[未列出报告](${missing})`;
    const rawRequests = [];
    await context.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname.replace(/^\/_cds/, '');
      if (p === '/api/auth/status') return route.fulfill({ json: { authenticated: true, enabled: true, mode: 'basic', user: { id: 'fixture-owner', name: '合成验收账号', isSystemOwner: true } } });
      if (/\/raw$/.test(p)) {
        rawRequests.push(p);
        if (p === `/api/reports/${supervisorId}/raw`) return route.fulfill({ contentType: 'text/plain', body: raw });
        if (p === `/api/reports/${appendixId}/raw`) return route.fulfill({ contentType: 'text/plain', body: `<h1>APPENDIX-${format}</h1>` });
        return route.fulfill({ status: 403, json: { message: '不可访问的合成报告' } });
      }
      if (p === '/api/reports') return route.fulfill({ json: { reports } });
      if (p === '/api/projects') return route.fulfill({ json: { projects: [{ id: canonicalProject, slug: project, name: '合成验收项目' }] } });
      if (p === '/api/report-folders') return route.fulfill({ json: { folders: [] } });
      if (p === '/api/cds-system/connections') return route.fulfill({ json: { connections: [] } });
      if (p === '/api/auth/activity') return route.fulfill({ json: { activity: [] } });
      if (p === '/api/reports/overview' || p === '/api/reports/pipeline') return route.fulfill({ status: 503, json: { message: '本项只验证报告查看器' } });
      if (isEventStream(p)) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      return route.fulfill({ json: resolveFixture(p) ?? {} });
    });
    const page = await context.newPage();
    try {
      await page.goto(`${base}/reports?project=${canonicalProject}&report=${supervisorId}`);
      let frame = page.frameLocator(`iframe[title="${title}"]`);
      await frame.getByRole('heading', { name: title }).waitFor();
      await page.evaluate((reportId) => window.postMessage({ type: 'cds:authenticated-report-navigation', reportId }, location.origin), appendixId);
      await frame.getByRole('heading', { name: title }).waitFor();
      await frame.getByRole('link', { name: '未列出报告' }).click();
      await page.getByRole('alert').filter({ hasText: '无法打开该报告' }).waitFor();
      assert(!rawRequests.some(p => p.includes(missingId)), 'frame must not request an ID outside the authenticated list');
      await frame.getByRole('link', { name: '打开技术附录' }).click();
      await page.waitForURL(url => url.searchParams.get('report') === appendixId);
      frame = page.frameLocator(`iframe[title="技术附录-${format}"]`);
      await frame.getByRole('heading', { name: `APPENDIX-${format}` }).waitFor();
      assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
      assert.equal(context.pages().length, 1, 'report navigation must not open a popup');
      assert.equal(new URL(page.url()).searchParams.get('folder'), folder, 'folder comes from authenticated metadata');
      assert(await frame.locator('body').evaluate(() => { try { void window.parent.document.body; return false; } catch { return true; } }), 'frame remains isolated from authenticated parent');
      await page.reload();
      await frame.getByRole('heading', { name: `APPENDIX-${format}` }).waitFor();
      await page.screenshot({ path: path.join(out, `report-auth-navigation-${format}.jpg`) });
      console.log(`PASS REG-stsmk-report-external-link-001 ${format}: protected navigation, refresh, missing-report rejection, unchanged sandbox`);
    } catch (error) {
      await page.screenshot({ path: path.join(out, `failure-report-navigation-${format}.jpg`) });
      console.log(`REPORT_NAV_DIAGNOSTIC ${format}: ${JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText()).slice(0, 2000), rawRequests })}`);
      throw error;
    } finally { await context.close(); }
  }
}

try {
  for (const scene of scenes.filter(s => s.scope !== 'standalone' && s.route !== '/branch-panel' && (!only || only.includes(s.route)))) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
    const code = gate(), data = gate();
    const errors = [], requests = [];
    let authRequests = 0;
    const chunk = path.basename(scene.page, '.tsx');
    await context.route(`**/assets/${chunk}-*.js`, async route => { await code.promise; await route.continue(); });
    await context.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname.replace(/^\/_cds/, '');
      if (isEventStream(p) || p === '/api/activity-stream') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      if (p === '/api/auth/status') {
        authRequests++;
        if (scene.kind === 'settings' && authRequests > 1) await data.promise;
        return route.fulfill({ json: { authenticated: true, enabled: true, mode: 'basic', user: { id: 'fixture-owner', name: '合成验收账号', isSystemOwner: true } } });
      }
      if (!p.startsWith('/api/auth/')) { requests.push(p); await data.promise; }
      let payload = resolveFixture(p) ?? {};
      if (p === '/api/auth/sso/config') payload = { enabled: false, providerId: 'fixture', label: '使用 SSO 登录', authorizationUrl: '', tokenUrl: '', clientId: '', defaultRedirect: '/project-list', hasClientSecret: false };
      if (p === '/api/overview/topology') payload = {generatedAt: new Date().toISOString(),summary:{errors:0,warnings:0,infos:0},projects:[]};
      if (p === '/api/reports/overview') payload = {overview:{window:{from:'2026-10-01',to:'2026-11-01',days:30,previousFrom:'2026-09-01'},headline:{status:'untested',statusLabel:'尚无记录',sentence:'合成空结果',supports:[]},releaseGate:{state:'unknown',reason:'尚无记录',latest:null,lastPass:null},totals:{archived:0,folded:0,counted:0,pass:0,conditional:0,fail:0,undetermined:0,previous:{counted:0,pass:0,conditional:0,fail:0,undetermined:0}},passRate:{kind:'acceptance',numerator:0,denominator:0,rate:null,previous:{numerator:0,denominator:0,rate:null}},kinds:[],clusters:[],daily:[],mergeCoverage:{items:[],counts:{verified:0,conditional:0,failed:0,unverified:0}},reports:[],supersededReports:[]}};
      if (p === '/api/reports/pipeline') payload = {pipeline:{generatedAt:new Date().toISOString(),recentDays:null,total:{changes:0,deployed:0,accepted:0,merged:0,pass:0,conditional:0,fail:0,undetermined:0},totalLeaks:{'deployed-not-accepted':0,'merged-not-accepted':0,'merged-while-failing':0,'report-missing-change-key':0},projects:[],staleReports:0,leaks:[]},series:null};
      if (/\/agent-requests$/.test(p)) payload = {items:[],users:[],apps:[],liveCount:0,historyCount:0};
      if (p === '/api/reports') payload = {reports:[]};
      if (p === '/api/report-folders') payload = {folders:[]};
      if (/\/identity-history$/.test(p)) payload = {records:[],nextCursor:null,coverage:'complete'};
      if (p === '/api/cds-system/connections') payload = {connections:[]};
      if (p === '/api/auth/activity') payload = { activity: [] };
      try { await route.fulfill({ json: payload }); } catch (e) { if (!/closed|handled|canceled/i.test(String(e))) throw e; }
    });
    const page = await context.newPage(); page.on('pageerror', e => {if(errors.length<10) errors.push(e.message);}); page.on('console', m => { if(errors.length<10 && m.type()==='error' && !m.text().startsWith('Failed to load resource:')) errors.push(m.text().slice(0,2000)); });
    let route = scene.route.replace(':projectId', 'fixture-project').replace(':branchId', 'fixture-branch-alpha');
    if (scene.kind === 'settings') route += '#auth';
    if (route === '/branch-list') route += '?project=fixture-project';
    if (route === '/branch-topology') route += '?project=fixture-project';
    const selector = selectors[scene.kind];
    const result = { route, kind: scene.kind, errors, syntheticApis: true };
    async function inspect(label) {
      const target = page.locator(`main .cds-workspace ${selector}`).first();
      const present = await target.count();
      if (!present) return { present: false };
      const measured = await target.evaluate(e => {
        const r = e.getBoundingClientRect(), w = e.closest('.cds-workspace').getBoundingClientRect();
        return { present: true, x: r.x - w.x, y: r.y - w.y, width: r.width, height: r.height,
          shape: e.outerHTML.replace(/aria-label="[^"]*"/g, '').replace(/id="[^"]*"/g, '').replace(/class="([^"]*)"/g, (_, cls) => `class="${cls.split(/\s+/).sort().join(' ')}"`) };
      });
      if (['settings', 'project-settings', 'release-console'].includes(scene.kind)) await page.screenshot({ path: path.join(out, `${before ? 'before' : 'after'}-${scene.kind}-${label}.jpg`) });
      return measured;
    }
    try {
      await page.goto(base + route);
      await page.getByRole('status', { name: '页面加载中', exact: true }).waitFor();
      result.code = await inspect('code');
      code.release();
      await page.getByRole('status', { name: '页面加载中', exact: true }).waitFor({ state: 'hidden' });
      await page.locator('main .cds-workspace .cds-loading-skeleton-line').first().waitFor();
      result.data = await inspect('data');
      await fs.writeFile(path.join(out, `pending-${scene.kind}.html`), await page.content());
      result.sameShape = result.code.present && result.data.present && result.code.shape === result.data.shape;
      result.maxGeometryDelta = result.code.present && result.data.present ? Math.max(...['x', 'y', 'width', 'height'].map(k => Math.abs(result.code[k] - result.data[k]))) : null;
      if (!before) {
        assert(result.sameShape, `${route}: code/data shape mismatch`);
        // 复杂页面内有固定筛选/说明区；这里只对整页专用轮廓断言无位移。
        if (['settings', 'project-settings', 'release-console', 'projects', 'branches', 'topology', 'release-center', 'agent-table', 'monitor', 'relations', 'rows', 'branch-detail'].includes(scene.kind)) assert(result.maxGeometryDelta < 1, `${route}: initial skeleton moved ${result.maxGeometryDelta}`);
      }
      if (!before) {
        await page.emulateMedia({reducedMotion:'reduce'});
        await page.getByRole('button',{name:'切换到黑天主题',exact:true}).click();
        await page.setViewportSize({width:390,height:844});
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${route}: horizontal overflow at 390`);
        assert.equal(await page.locator('main .cds-loading-skeleton-line').first().evaluate(e=>getComputedStyle(e).animationName),'none');
        if (['settings','project-settings','release-console','topology','release-center','agent-table'].includes(scene.kind)) await page.screenshot({path:path.join(out,`after-${scene.kind}-dark390.jpg`)});
        result.dark390ReducedMotion = true;
        await page.setViewportSize({width:1440,height:940});
        await page.emulateMedia({reducedMotion:'no-preference'});
        await page.getByRole('button',{name:'切换到白天主题',exact:true}).click();
      }
      data.release();
      await page.locator(`main .cds-workspace ${selector}`).first().waitFor({ state: 'hidden', timeout: 15000 });
      result.dataReplacedSkeleton = true;
      if (scene.kind === 'branch-detail') {
        await page.locator('summary').filter({hasText:'生效配置'}).click();
        await page.getByText('没有任何自定义环境变量层。',{exact:true}).waitFor();
        await page.getByText('这条分支还没有服务配置，没有可实测的数据库。',{exact:true}).first().waitFor();
      }
      assert.deepEqual(errors, []);
    } catch (e) { await page.screenshot({path:path.join(out,`failure-${scene.kind}.jpg`)}); result.failure = String(e); result.requests = [...new Set(requests)]; await fs.writeFile(path.join(out, `failed-${scene.kind}.html`), await page.content()); }
    finally { code.release(); data.release(); await context.close(); }
    results.push(result);
    console.log(`${result.failure ? 'FAIL' : 'PASS'} ${route} same=${result.sameShape} geometry=${result.maxGeometryDelta}`);
    if (result.failure) console.log(result.failure.slice(0,2000));
  }
  if (!before && !only) {
    try {
      await verifyAuthenticatedReportNavigation();
      await verifyPublicLoading(browser, base, out);
      const settings = await verifySettingsRefresh(browser, base, out);
      await fs.writeFile(path.join(out, 'project-settings-refresh-result.json'), JSON.stringify(settings,null,2));
      const refresh = await verifyLoadingRefresh(browser, base, out);
      await fs.writeFile(path.join(out, 'refresh-result.json'), JSON.stringify(refresh,null,2));
      console.log('PASS refresh retains content/input/focus; failure/retry; navigate away and reopen');
    } catch(e) {results.push({route:'refresh-regression',failure:String(e)}); console.log('FAIL refresh-regression '+String(e));}
  }
} finally { await browser.close(); }
await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ artificialWait: 'local synthetic API/chunk gates only', paidModelRequests: 0, before, results }, null, 2));
if (!before && results.some(r => r.failure)) process.exitCode = 1;
