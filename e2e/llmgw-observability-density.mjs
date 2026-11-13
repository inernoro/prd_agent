// 浏览器布局与交互回归，所有接口均为确定性夹具；不代表外部集成或真实预览验收。
// LLMGW_DIST=<旧或新dist> LLMGW_OBSERVABILITY_DENSITY_OUT=<证据目录> node e2e/llmgw-observability-density.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(process.env.LLMGW_DIST || path.join(root, 'llmgw/web/dist'));
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error(`缺少构建产物：${dist}`);
const out = process.env.LLMGW_OBSERVABILITY_DENSITY_OUT || path.join(os.tmpdir(), 'llmgw-observability-density');
fs.mkdirSync(out, { recursive: true });
const fixed = '2026-11-13T08:00:00Z';
const state = { count: 2, role: 'owner', failure: '', ambiguous: false, business: false, delay: {} };
const log = i => ({ id: `log-${i}`, requestId: `request-${i}`, runId: 'run-fixture', model: 'fixture-chat', provider: 'fixture-provider', platformName: '供应方', status: i === 1 ? 'failed' : 'succeeded', statusCode: i === 1 ? 403 : 200, operation: 'invoke', startedAt: fixed, durationMs: 1000, inputTokens: 10, outputTokens: 20, estimatedCost: 0.01, estimatedCostCurrency: 'USD', providerReportedCost: i === 0 ? 0 : null, providerCostCurrency: 'USD', appCallerCode: 'fixture.chat', appCallerTitle: '业务对话', costKind: 'official_baseline_estimate' });
const audit = i => ({ id: `audit-${i}`, action: 'model.create', targetName: `审计模型 ${i + 1}`, targetType: 'llmgw_model', actorUsername: 'fixture', success: i % 2 === 0, createdAt: fixed, changesJson: JSON.stringify({ enabled: true }), remoteIp: '127.0.0.1', userAgent: 'Fixture Browser' });
const overview = () => ({ from: fixed, to: fixed, generatedAt: fixed, totalRequests: state.count, successRatePercent: state.count ? 50 : null, p95DurationMs: state.count ? 1000 : null, requestRatePerMinute: 1, rateWindowMinutes: 15, inputTokens: 10, outputTokens: 20, totalTokens: 30, activeUsers: 1, pricedRequests: state.count ? 1 : 0, unknownCostRequests: state.count ? 1 : 0, priceCoveragePercent: state.count ? 50 : 0, estimatedCosts: state.count ? [{ currency: 'USD', amount: 0.01, requests: 1 }] : [], topUsers: [], topAppCallers: [], topModels: [], serviceKeys: { total: 1, active: 1, disabled: 0, expiringSoon: 0, expired: 0, neverUsed: 0 }, canReadRecentRequests: state.role !== 'billing', recentRequests: state.role === 'billing' ? [] : Array.from({ length: Math.min(2, state.count) }, (_, i) => log(i)) });
const json = (res, data, success = true) => { const send = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success, data: success ? data : null, error: success ? null : { code: 'FIXTURE_UNAVAILABLE', message: data } })); };if (res.fixtureDelay) setTimeout(send, res.fixtureDelay);else send(); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  if (/^\/(llmgw\/)?gw\//.test(url.pathname)) {
    const api = url.pathname.replace(/^\/(llmgw\/)?gw/, '');res.fixtureDelay = state.delay[api] || 0;
    if (api === '/auth/login') return json(res, { token: 'fixture-only-session', username: 'fixture', displayName: '布局验收', expiresAt: '2099-01-01T00:00:00Z', mustChangePassword: false, tenant: { id: `fixture-${state.role}`, name: '验收租户', role: state.role, teamIds: [], isInternal: true } });
    if (api === '/auth/tenants') return json(res, []);
    if (api === '/healthz') return json(res, { status: 'ok' });
    if (api === '/organization') return json(res, { tenant: { id: 'fixture' }, teams: [{ id: 'team', status: 'active' }], members: [{ status: 'active' }, { status: 'active' }] });
    if (api === '/service-keys') return json(res, [{ id: 'key', enabled: true, scopes: ['invoke'], keyPrefix: 'gwk_fixture', lastUsedAt: fixed }]);
    if (api === '/overview') return state.failure === 'overview' ? json(res, '概览暂不可用', false) : json(res, overview());
    if (api === '/audits') {
      if (state.failure === 'audits') return json(res, '审计加载失败，请稍后重试', false);
      const page = Number(url.searchParams.get('page') || 1), count = url.searchParams.get('search') ? 1 : state.count;
      return json(res, { items: Array.from({ length: Math.min(50, Math.max(0, count - (page - 1) * 50)) }, (_, i) => audit((page - 1) * 50 + i)), total: count, page, pageSize: 50, actions: ['model.create'], targetTypes: ['llmgw_model'], actors: ['fixture'] });
    }
    if (api === '/logs/trace') {
      if (state.failure === 'trace') return json(res, '关联记录暂不可用', false);
      if (state.ambiguous && !url.searchParams.get('anchorId')) return json(res, { ambiguous: true, candidates: [{ id: 'log-0', runId: 'run-fixture' }, { id: 'log-1', runId: 'another-run' }], hasMoreCandidates: false });
      const page = Number(url.searchParams.get('page') || 1);
      return json(res, { ambiguous: false, reference: 'run-fixture', anchorId: 'log-0', total: state.count, page, pageSize: 50, business: state.business ? { runId: 'run-fixture', status: 'succeeded', providerTaskId: 'task-fixture', upstreamStatus: 'completed', artifactSha256: 'abc0123456789'.repeat(5) } : null, items: Array.from({ length: Math.min(50, Math.max(0, state.count - (page - 1) * 50)) }, (_, i) => ({ log: log((page - 1) * 50 + i), recordKind: 'request', sameReceiptRecords: i === 1 ? 2 : 1, attempts: [{ order: 1, stage: 'send', provider: '供应方', model: 'fixture-chat', status: i === 1 ? 'failed' : 'succeeded', reachedProvider: true, statusCode: i === 1 ? 403 : 200, error: i === 1 ? '上游额度耗尽' : null }], evidenceGap: i === 1 ? '历史记录缺少逐次费用证据' : null })) });
    }
    if (api === '/logs/meta') return json(res, Object.fromEntries(['models', 'statuses', 'providers', 'appCallers', 'transports', 'requestTypes', 'sourceSystems', 'ingressProtocols', 'modelPolicies', 'serviceKeyIds', 'clientCodes', 'environments', 'operations'].map(key => [key, []])));
    if (api === '/logs/summary') return json(res, { total: state.count, upstreamCalls: state.count, succeeded: 1, failed: 1, totalTokens: 30, unknownCostRequests: 1, estimatedCostUsd: 0.01 });
    if (api === '/logs/timeseries') return json(res, { items: [{ date: fixed, count: 2 }] });
    if (api === '/logs/consumption-alerts') return json(res, { items: [] });
    if (api === '/logs/sessions') return json(res, { items: state.count ? [{ sessionId: 'session-fixture', requestCount: state.count, start: fixed, primaryModel: 'fixture-chat', supportingModels: [] }] : [], total: state.count ? 1 : 0, page: 1, pageSize: 30 });
    if (api === '/logs') { if (state.failure === 'logs') return json(res, '请求记录加载失败，请稍后重试', false);const page = Number(url.searchParams.get('page') || 1);const requestId=url.searchParams.get('requestId');const items=Array.from({length:state.count},(_,i)=>log(i)).filter(item=>!requestId||item.requestId===requestId||item.id===requestId);return json(res, { items: items.slice((page-1)*30,page*30), total: items.length, page, pageSize: 30 }); }
    if (/^\/logs\/[^/]+$/.test(api) && state.failure === 'detail') return json(res, '详情加载失败，请返回后重试', false);
    if (/^\/logs\/[^/]+$/.test(api)) { const index=Number(api.match(/log-(\d+)/)?.[1]||0);return json(res, { ...log(index), error:index===1?'上游额度耗尽，请检查额度后重试':null, upstreamCallCount: 1, statusQueryCount: 0, providerAttempts: [], answerText: '夹具响应内容', questionText: '夹具请求内容' }); }
    return json(res, { items: [], total: 0 });
  }
  const rel = url.pathname.replace(/^\/llmgw(?=\/|$)/, '');
  const filename = !path.extname(rel) || rel === '/' ? 'index.html' : rel.slice(1);
  const full = path.resolve(dist, filename);
  if (!full.startsWith(`${dist}${path.sep}`) || !fs.existsSync(full)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[path.extname(full)] || 'application/octet-stream' });fs.createReadStream(full).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}/llmgw`;
const browser = await chromium.launch({ executablePath: process.env.LLMGW_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
const results = [], failures = [];
const check = (name, pass, details) => { if (!pass) failures.push({ name, details }); };
async function snap(p, id) {
  await p.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
  const metrics = await p.evaluate(() => {
    const rect = selector => { const e = document.querySelector(selector); if (!e) return null; const r = e.getBoundingClientRect(); return { y: r.y, height: r.height, bottom: r.bottom }; };
    const table = document.querySelector('[data-audit-list]') || document.querySelector('table')?.parentElement;
    const last = document.querySelector('tbody')?.lastElementChild;
    const firstRequest = document.querySelector('.lg-recent-row');
    const quickstart = document.querySelector('.lg-home-quickstart-card');
    const quickstartBeforeRequest = !!(firstRequest && quickstart && quickstart.compareDocumentPosition(firstRequest) & Node.DOCUMENT_POSITION_FOLLOWING);
    const traceRecord = document.querySelector('.lg-log-trace-record') || [...document.querySelectorAll('.lg-log-trace h2')].find(e => e.textContent.includes('查看详情'))?.closest('div');
    const traceExplanationBeforeHeight = [...document.querySelectorAll('.lg-log-trace p')].filter(e => /^(每条记录代表|费用逐项保留)/.test(e.textContent || '') && traceRecord && e.getBoundingClientRect().bottom <= traceRecord.getBoundingClientRect().top).reduce((sum, e) => sum + e.getBoundingClientRect().height, 0);
    const auditIntro = document.querySelector('table') ? document.querySelector('.lg-page-heading p') : null;
    const logRows=[...document.querySelectorAll('.lg-log-table-row')];
    const statusIndex=[...document.querySelectorAll('.lg-log-table-head>div')].findIndex(e=>e.textContent.trim()==='状态');
    const status=statusIndex>=0?logRows[0]?.querySelectorAll(':scope>div')[statusIndex]:null;
    const sr=status?.getBoundingClientRect(), port=document.querySelector('.lg-log-table-scroll')?.getBoundingClientRect();
    const top=sr?document.elementFromPoint(sr.x+sr.width/2,sr.y+sr.height/2):null;
    const footer=document.querySelector('.lg-log-table-footer')?.getBoundingClientRect();
    const statusVisible=!!(sr&&sr.x>=0&&sr.right<=innerWidth&&sr.y>=0&&sr.bottom<=innerHeight&&top&&(top===status||status.contains(top)));

    return { firstLog:rect('.lg-log-table-row'), logRowCount:logRows.length, logTail:footer&&logRows.length?footer.top-logRows.at(-1).getBoundingClientRect().bottom:null, statusVisible, statusReadScrollX:sr&&port?Math.max(0,sr.right-port.right):null, detailError:rect('.lg-generation-error'), detailMetrics:rect('.lg-generation-metrics'), nonessentialQuickstartBeforeHeight: quickstartBeforeRequest ? quickstart.getBoundingClientRect().height : 0, traceExplanationBeforeHeight, auditIntroHeight: auditIntro?.getBoundingClientRect().height ?? null, coreTaskScrollToFirstRequest: firstRequest ? Math.max(0, firstRequest.getBoundingClientRect().bottom - innerHeight) : null, firstRequest: rect('.lg-recent-row'), firstAudit: rect('tbody tr'), firstTrace: rect('.lg-log-trace-record') || (() => { const h = [...document.querySelectorAll('.lg-log-trace h2')].find(e => e.textContent.includes('查看详情')); return h ? { y: h.closest('div').getBoundingClientRect().y } : null; })(), quickstartBeforeRequest, auditTail: table && last ? table.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom : null, docWidth: document.documentElement.scrollWidth, innerWidth, touch: navigator.maxTouchPoints, font: getComputedStyle(document.body).fontSize, logBody: rect('.lg-log-table-body') };
  });
  await p.screenshot({ path: path.join(out, `${id}.png`), animations: 'disabled' });results.push({ id, provenance: 'deterministic-fixture', metrics });
  check(`${id}:无文档横向溢出`, metrics.docWidth <= metrics.innerWidth + 1, metrics);check(`${id}:视口未自动缩放`, metrics.innerWidth === p.viewportSize().width, metrics);
  return metrics;
}
async function uncovered(locator) {
  if (!await locator.isVisible()) return false;
  return locator.evaluate(el=>{const r=el.getBoundingClientRect(),top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight&&!!top&&(top===el||el.contains(top));});
}
async function toggleFilter(p,id) {
  const trigger=p.getByLabel('筛选日志',{exact:true});
  const visible=await uncovered(trigger);check(`${id}:筛选收起入口无遮挡`,visible);
  if(visible)await trigger.click();else{await trigger.focus();await trigger.press('Enter');}
}
async function nav(p, route, width) {
  if (width < 700) await p.getByRole('button', { name: '打开导航', exact: true }).click();
  await p.locator(`aside a[href="/llmgw${route}"]`).first().click();
}
async function login(p) {
  await p.goto(`${origin}/`);await p.locator('#llmgw-username').fill('fixture');await p.locator('#llmgw-password').fill('fixture-only');await p.getByRole('button', { name: '进入租户工作区' }).click();await p.getByRole('heading', { name: '概览', exact: true }).waitFor();
}
try {
for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  const id = `${width}-${theme}`;if (process.env.LLMGW_OBSERVABILITY_FILTER && !id.includes(process.env.LLMGW_OBSERVABILITY_FILTER)) continue;state.count = 2;state.role = 'owner';state.failure = '';state.ambiguous = false;state.business = false;state.delay = {};
  const c = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390, colorScheme: theme });const p = await c.newPage();p.on('pageerror', e => failures.push({ name: `${id}:页面异常`, details: e.message }));
  try {
    await login(p);await p.locator('.lg-recent-row').first().waitFor();const home = await snap(p, `${id}-home`);
    check(`${id}:已有请求的接入卡不挡近期记录`, !home.quickstartBeforeRequest, home);
    if (width === 390) check(`${id}:首条近期记录完整进入首屏`, home.firstRequest.bottom <= 844, home);
    state.delay['/overview'] = 600;await p.getByRole('button', { name: '24 小时', exact: true }).click();await expect(p.getByText('正在刷新当前时间范围…', { exact: true })).toBeVisible();await expect(p.getByText('正在刷新当前时间范围…', { exact: true })).toBeHidden();state.delay['/overview'] = 0;await expect(p.getByRole('button', { name: '24 小时', exact: true })).toHaveAttribute('aria-pressed', 'true');await p.getByRole('button', { name: '30 天', exact: true }).click();await expect(p.getByRole('button', { name: '30 天', exact: true })).toHaveAttribute('aria-pressed', 'true');
    state.count = 0;await p.reload();await p.locator('.lg-home-quickstart-card').waitFor();check(`${id}:无近期请求保留接入入口`, await p.getByRole('link', { name: '开始接入', exact: true }).count() > 0);await snap(p, `${id}-home-empty`);
    state.failure = 'overview';await p.reload();await expect(p.getByText(/部分首页数据不可用/)).toBeVisible();await snap(p, `${id}-home-error`);state.failure = '';state.count = 2;
    await nav(p, '/audits', width);await p.locator('tbody tr').first().waitFor();const auditSmall = await snap(p, `${id}-audits-two`);
    check(`${id}:少量审计自然高度`, auditSmall.auditTail <= 4, auditSmall);check(`${id}:单页审计无无用分页`, await p.getByRole('button', { name: '上一页', exact: true }).count() === 0);
    check(`${id}:审计前置说明减少`, auditSmall.firstAudit.y <= (width === 390 ? 430 : 270), auditSmall);
    const view = p.getByRole('button', { name: '查看', exact: true }).first();await view.click();await expect(p.locator('tbody pre')).toBeVisible();await p.getByRole('button', { name: '收起', exact: true }).click();
    const privacy = p.locator('summary').filter({ hasText: '记录范围与隐私' });if (await privacy.count()) { await privacy.focus();await privacy.press('Enter');await expect(p.getByText(/不含请求内容或提示词正文/)).toBeVisible();await privacy.press('Enter'); } else check(`${id}:隐私口径可按需打开`, false);
    state.delay['/audits'] = 600;await p.getByPlaceholder('搜索 action / target / actor').fill('审计模型');await expect(p.getByText('正在加载操作审计…', { exact: true })).toBeVisible();await expect(p.locator('tbody tr')).toHaveCount(1);state.delay['/audits'] = 0;await p.getByPlaceholder('搜索 action / target / actor').fill('');await expect(p.locator('tbody tr')).toHaveCount(2);
    state.count = 51;await p.reload();await p.locator('tbody tr').first().waitFor();await p.getByRole('button', { name: '下一页', exact: true }).click();await expect(p.getByText('审计模型 51', { exact: true })).toBeVisible();const lastAudit = await snap(p, `${id}-audits-last-page`);check(`${id}:末页少量审计自然高度`, lastAudit.auditTail <= 4, lastAudit);
    state.count = 0;await p.reload();await expect(p.getByText('暂无操作审计', { exact: true })).toBeVisible();await snap(p, `${id}-audits-empty`);
    state.failure = 'audits';await p.reload();await expect(p.getByText('审计加载失败，请稍后重试', { exact: true })).toBeVisible();await snap(p, `${id}-audits-error`);state.failure = '';state.count = 2;
    await nav(p, '/logs', width);await p.locator('.lg-log-table-row').first().waitFor();const logs = await snap(p, `${id}-logs`);check(`${id}:有限两条结果完成回执贴近记录`, logs.logTail <= 4 && logs.logBody.height <= 94, logs);if(width===390){check(`${id}:失败状态无需横向寻找`,logs.statusVisible&&logs.statusReadScrollX===0,logs);check(`${id}:窄屏首条记录更早出现`,logs.firstLog.y<=412,logs);}
    for (const tab of ['上游调用', '会话', '业务请求']) { await p.getByRole('tab', { name: tab, exact: true }).click();await p.locator('.lg-log-table-row').first().waitFor();await snap(p, `${id}-logs-${tab}`); }
    state.count = 0;await p.getByRole('button', { name: '刷新日志', exact: true }).click();await expect(p.locator('.lg-log-table-row')).toHaveCount(0);await snap(p, `${id}-logs-empty`);state.failure = 'logs';await p.getByRole('button', { name: '刷新日志', exact: true }).click();await expect(p.getByText('请求记录加载失败，请稍后重试', { exact: true })).toBeVisible();await snap(p, `${id}-logs-error`);state.failure = '';state.count = 31;state.delay['/logs'] = 600;await p.getByRole('button', { name: '刷新日志', exact: true }).click();await expect(p.getByText('正在加载…', { exact: true })).toBeVisible();state.delay['/logs'] = 0;await expect(p.locator('.lg-log-table-row')).toHaveCount(30);await p.getByRole('button', { name: '加载更多', exact: true }).click();await expect(p.locator('.lg-log-table-row')).toHaveCount(31);await p.locator('.lg-log-table-row').last().scrollIntoViewIfNeeded();const manyLogs=await snap(p, `${id}-logs-many-last`);check(`${id}:大量日志保留浏览空间`,manyLogs.logBody.height>=240,manyLogs);state.count = 2;await p.getByRole('button', { name: '刷新日志', exact: true }).click();await expect(p.locator('.lg-log-table-row')).toHaveCount(2);
    // 模拟真实requestId检索：打开详情只改transaction，关闭后必须仍是同一个有限结果。
    await p.getByLabel('筛选日志',{exact:true}).click();const requestSearch=p.getByLabel('按请求 ID 查找',{exact:true});await requestSearch.fill('request-1');await requestSearch.press('Enter');await p.getByRole('button',{name:'关闭详情',exact:true}).waitFor();await p.locator('.lg-generation-error').waitFor();const fault=await snap(p,`${id}-detail-failed-overview`);check(`${id}:失败原因优先于指标且首屏可读`,fault.detailError&&fault.detailError.y<fault.detailMetrics.y&&fault.detailError.bottom<=(width===390?844:900),fault);await p.getByRole('button',{name:'关闭详情',exact:true}).click();await p.waitForTimeout(80);const filtered=await snap(p,`${id}-logs-filtered-one`);check(`${id}:关闭详情不清空检索上下文`,filtered.logRowCount===1&&await requestSearch.inputValue()==='request-1',filtered);
    const filterMenu=p.locator('.lg-log-filter-menu');if(await filterMenu.getAttribute('open')===null)await toggleFilter(p,id);await requestSearch.fill('');await requestSearch.press('Enter');if(await filterMenu.getAttribute('open')!==null)await toggleFilter(p,id);await expect(p.locator('.lg-log-table-row')).toHaveCount(2);
    const row = p.locator('.lg-log-table-row').first();await row.focus();await row.press('Enter');await p.getByRole('button', { name: '关闭详情', exact: true }).or(p.getByRole('button', { name: '返回请求记录', exact: true })).first().waitFor();
    for (const tab of ['请求与响应', '路由', '审计', '概览']) { await p.getByRole('tab', { name: tab, exact: true }).click();if (tab === '请求与响应') for (const body of ['响应内容', '原始数据', '请求内容']) await p.getByRole('tab', { name: body, exact: true }).click();await snap(p, `${id}-detail-${tab}`); }
    const trace = p.getByRole('link', { name: '查看完整关联调用链' });state.delay['/logs/trace'] = 600;await trace.focus();await trace.press('Enter');await expect(p.getByText('正在读取关联记录…', { exact: true })).toBeVisible();state.delay['/logs/trace'] = 0;await p.getByRole('link', { name: '查看详情', exact: true }).first().waitFor();const traceTwo = await snap(p, `${id}-trace-two`);
    check(`${id}:调用链首记录前置`, traceTwo.firstTrace.y < (width === 390 ? 420 : 340), traceTwo);check(`${id}:调用链单页无无用翻页`, await p.getByRole('button', { name: '上一页', exact: true }).count() === 0);
    await expect(p.getByText(/暂无授权范围内的 MAP 视频产物证据/)).toBeVisible();await expect(p.getByText(/实际费用：\$0/).first()).toBeVisible();check(`${id}:失败和重复回执警告保留`, await p.getByText(/同一上游回执出现在 2 条/).count() === 1 && await p.getByText('上游额度耗尽', { exact: false }).count() === 1);
    const rules = p.locator('summary').filter({ hasText: '关联与费用口径' });if (await rules.count()) { await rules.focus();await rules.press('Enter');await expect(p.getByText(/相似正文、同一模型和时间接近/)).toBeVisible();await rules.press('Enter'); } else check(`${id}:证据口径可按需打开`, false);
    state.ambiguous = true;await p.getByRole('button', { name: '刷新', exact: true }).click();await p.getByRole('button', { name: 'run-fixture · log-0', exact: true }).click();await p.getByRole('link', { name: '查看详情', exact: true }).first().waitFor();state.ambiguous = false;
    state.failure = 'trace';await p.getByRole('button', { name: '刷新', exact: true }).click();await expect(p.getByRole('alert')).toHaveText('关联记录暂不可用');await snap(p, `${id}-trace-error`);state.failure = '';state.count = 0;await p.getByRole('button', { name: '刷新', exact: true }).click();await expect(p.getByText('共 0 条关联记录')).toBeVisible();await snap(p, `${id}-trace-empty`);
    state.count = 51;await p.getByRole('button', { name: '刷新', exact: true }).click();await expect(p.getByRole('link', { name: '查看详情', exact: true })).toHaveCount(50);const nextTrace = p.getByRole('button', { name: '下一页', exact: true });await nextTrace.focus();await nextTrace.press('Enter');await expect(p.getByRole('link', { name: '查看详情', exact: true })).toHaveCount(1);await expect(p.getByText(/请求 request-50/)).toBeVisible();await snap(p, `${id}-trace-many-last`);state.business = true;state.count = 2;await p.getByRole('textbox', { name: '业务操作或请求编号' }).fill('fixture-artifact');await p.getByRole('button', { name: '查找调用链', exact: true }).click();await expect(p.getByRole('heading', { name: 'MAP 视频业务结果', exact: true })).toBeVisible();await snap(p, `${id}-trace-artifact`);state.business = false;state.failure = 'detail';const details = p.getByRole('link', { name: '查看详情', exact: true }).first();await details.focus();await details.press('Enter');await expect(p.getByRole('alert')).toContainText('详情加载失败，请返回后重试');await snap(p, `${id}-detail-error`);state.failure = '';
  } catch (e) { failures.push({ name: `${id}:交互路径`, details: e.message });await p.screenshot({ path: path.join(out, `${id}-failure.png`) }); }
  await c.close();
}
// 真实权限边界由应用守卫驱动；夹具只证明页面状态，不声称服务器权限已验收。
state.role = 'billing';state.count = 2;const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });const p = await c.newPage();await login(p);await expect(p.getByText('当前角色只显示聚合用量', { exact: true })).toBeVisible();check('billing:审计入口隐藏', await p.locator('aside a[href$="/audits"]').count() === 0);await snap(p, 'billing-home');await c.close();
} finally { await browser.close();await new Promise(resolve => server.close(resolve));fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ provenance: 'deterministic-fixture', results, failures }, null, 2)); }
console.log(JSON.stringify({ snapshots: results.length, failures: failures.map(f => f.name), out }));if (failures.length) process.exitCode = 1;
