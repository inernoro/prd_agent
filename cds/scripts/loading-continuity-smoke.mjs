/** 本机验收：分别拦住 lazy chunk 与 API。所有响应合成，不调用真实模型/部署。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { verifyPublicLoading } from './loading-public-smoke.mjs';
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
        await page.getByRole('button',{name:/^生效配置/}).click();
        await page.getByText('没有任何自定义环境变量层。',{exact:true}).waitFor();
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
      await verifyPublicLoading(browser, base, out);
      const refresh = await verifyLoadingRefresh(browser, base, out);
      await fs.writeFile(path.join(out, 'refresh-result.json'), JSON.stringify(refresh,null,2));
      console.log('PASS refresh retains content/input/focus; failure/retry; navigate away and reopen');
    } catch(e) {results.push({route:'refresh-regression',failure:String(e)}); console.log('FAIL refresh-regression '+String(e));}
  }
} finally { await browser.close(); }
await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ artificialWait: 'local synthetic API/chunk gates only', paidModelRequests: 0, before, results }, null, 2));
if (!before && results.some(r => r.failure)) process.exitCode = 1;
