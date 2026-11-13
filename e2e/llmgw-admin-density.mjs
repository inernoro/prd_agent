// 管理页内容前置回归。确定性夹具不证明真实预览、授权或模型调用成功。
// LLMGW_DIST=<旧/新dist> LLMGW_ADMIN_DENSITY_OUT=<目录> node e2e/llmgw-admin-density.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(process.env.LLMGW_DIST || path.join(ROOT, 'llmgw/web/dist'));
const OUT = path.resolve(process.env.LLMGW_ADMIN_DENSITY_OUT || path.join(os.tmpdir(), 'llmgw-admin-density'));
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`缺少构建产物：${DIST}`);
const state = { members: 2, bills: 2, failure: '', role: 'owner', mustChange: false, loginFailure: false, teamFailure: true, createdTeam: false, missingCosts: false };
const TIME = '2026-11-13T08:00:00Z';
const tenant = () => ({ id: 'fixture', slug: 'fixture', name: '验收租户', isInternal: true, role: state.role, teamIds: ['team-a'] });
const bill = i => ({ id: `bill-${i}`, provider: '供应商验收', externalRecordId: `账单-${i + 1}`, granularity: 'request', requestId: `request-${i + 1}`, providerRequestId: `upstream-${i}`, estimatedCost: 0.12, estimatedCostCurrency: 'USD', providerReportedCost: 0.13, providerCostCurrency: 'USD', reconciliationDelta: 0.01, deltaCurrency: 'USD', reconciliationStatus: 'reconciled', createdAt: TIME });
const summary = { total: 2, totalTokens: 2500, pricedRequests: 1, unknownCostRequests: 1, priceCoveragePercent: 50, estimatedCosts: [{ currency: 'USD', amount: 0.12, requests: 1 }], topUnpricedModels: [], transportDistribution: [], statusDistribution: [], sourceSystemDistribution: [], ingressProtocolDistribution: [], modelPolicyDistribution: [] };
const governance = { tenantId: 'fixture', monthlyBudgetUsd: 100, budgetReservationUsd: 0.1, rateLimitPerMinute: 60, monthStart: TIME, reservedUsd: 0.2, spentUsd: 12, remainingBudgetUsd: 87.8, currentMinuteCount: 2, currentMinuteStart: TIME };
const errors = [], results = [], unknown = [];
const json = (res, data, success = true) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success, data: success ? data : null, error: success ? null : { code: 'FIXTURE_UNAVAILABLE', message: data } })); };
const server = http.createServer((req, res) => {
 const pathname = new URL(req.url, 'http://fixture.test').pathname;
 // Serving 兼容入口在 /gw 之外；必须给原始回执，不能让 SPA fallback 冒充安全试跑。
 if (/^\/v1\/(chat\/completions|messages)$/.test(pathname) || /^\/v1beta\/models\/.+:generateContent$/.test(pathname)) {
  if (req.headers['x-gateway-dry-run'] !== 'quickstart') { unknown.push(`禁止非dry-run的夹具请求 ${pathname}`);res.writeHead(400);res.end();return; }
  res.writeHead(200, { 'Content-Type': 'application/json', 'X-Gateway-Upstream-Called': 'false' });res.end(JSON.stringify({ success: true, upstreamCalled: false, requestId: 'fixture-dry-run' }));return;
 }
 if (/^\/(llmgw\/)?gw\//.test(pathname)) {
  const api = pathname.replace(/^\/(llmgw\/)?gw/, '');
  if (api === '/auth/login') return state.loginFailure ? json(res, '账号校验未通过，请重试', false) : json(res, { token: 'fixture-only', username: 'fixture-owner', displayName: '验收管理员', expiresAt: '2099-11-13T08:00:00Z', mustChangePassword: state.mustChange, tenant: tenant() });
  if (state.failure === api) return json(res, '验收接口不可用，请重试', false);
  if (api === '/app-callers/draft') { res.writeHead(200, { 'Content-Type': 'text/event-stream' });res.end(`data: ${JSON.stringify({ type: 'result', ok: true, requestType: 'chat', appCallerCode: 'fixture.chat::chat', reason: '仅布局验收的确定性推导', model: 'fixture' })}\n\n`);return; }
  if (api === '/app-callers' && req.method === 'POST') return json(res, { id: 'caller-fixture', appCallerCode: 'fixture.chat::chat', requestType: 'chat', title: '验收调用用途', status: 'configured' });
  if (api === '/service-keys') return json(res, req.method === 'POST' ? { id: 'key-fixture', key: 'gwk_deterministic_fixture_only_not_a_secret', keyPrefix: 'gwk_fixture' } : []);
  if (api === '/v1/resolve') { res.writeHead(200, { 'Content-Type': 'application/json' });res.end(JSON.stringify({ success: true, actualModel: 'fixture-chat', actualPlatformId: 'fixture', actualPlatformName: '验收上游', platformType: 'openai', protocol: 'openai' }));return; }
  if (api === '/v1/invoke') { res.writeHead(200, { 'Content-Type': 'application/json', 'X-Gateway-Upstream-Called': 'false' });res.end(JSON.stringify({ success: true, upstreamCalled: false, requestId: 'fixture-dry-run' }));return; }
  if (api === '/healthz') return json(res, { status: 'ok' });
  if (api === '/auth/tenants') return json(res, [{ ...tenant(), current: true }]);
  if (api === '/auth/account') return json(res, { username: 'fixture-owner', hasLocalPassword: true, requiresOldPassword: true, usernameIsGenerated: false, minPasswordLength: 12, tenant: tenant() });
  if (api === '/auth/change-password') return json(res, { requiresRelogin: true });
  if (api === '/organization') return json(res, { tenant: { ...tenant(), status: 'active' }, teams: [{ id: 'team-a', name: '验收团队', status: 'active', createdAt: TIME, updatedAt: TIME }, ...(state.createdTeam ? [{ id: 'team-new', name: '边界验收团队', status: 'active', createdAt: TIME, updatedAt: TIME }] : [])], members: Array.from({ length: state.members }, (_, i) => ({ id: `member-${i}`, userId: `user-${i}`, username: i === 0 ? 'fixture-owner' : `member-${i + 1}`, displayName: `验收成员 ${i + 1}`, role: i === 0 ? 'owner' : 'developer', teamIds: ['team-a'], status: 'active', version: 1 })) });
  if (api === '/logs/summary') return json(res, state.missingCosts ? { ...summary, estimatedCosts: undefined } : summary);
  if (api === '/tenant-governance') return json(res, governance);
  if (api === '/cost-reconciliations') return json(res, { totalRecords: state.bills, requestRecords: state.bills, windowRecords: 0, actualUnavailableRequests: 1, providerActualCosts: state.missingCosts ? undefined : state.bills ? [{ currency: 'USD', amount: 0.26, requests: state.bills }] : [], statusDistribution: [{ key: 'reconciled', count: state.bills }], items: Array.from({ length: state.bills }, (_, i) => bill(i)) });
  if (api === '/cost-reconciliations/import') return json(res, '账单匹配失败，未写入', false);
  if (api === '/teams') { if (state.teamFailure) return json(res, '团队创建失败，未写入', false);state.createdTeam = true;return json(res, { id: 'team-new', name: '边界验收团队', status: 'active' }); }
  if (api === '/system-settings') return json(res, { modelSource: 'auto', modelGroupId: null, modelName: null, teamId: 'system', teamName: '系统内部', teamIsSystemOwned: true, servingBaseUrl: 'https://serving.example.test', servingReachable: true, appCallerCode: 'gateway.internal::chat', credentialState: 'ready', credentialPrefix: 'gwk_fixture', credentialIssuedAt: TIME, pools: [{ id: 'pool-a', name: '验收池', isDefault: true }], models: [{ id: 'model-a', publicId: 'fixture-chat', name: '验收模型' }], modelQuery: '', modelTotal: 1, modelPageSize: 200, consumers: [{ feature: '用途推导', appCallerCode: 'gateway.intent::chat' }] });
  if (api === '/runtime-gates') return json(res, { status: 'blocked', readyForRelease: false, passed: 0, blocked: 1, waiting: 0, generatedAt: TIME, items: [{ id: 'fixture-gate', label: '验收阻塞项', status: 'blocked', blocking: true, detail: '尚缺本次提交的真实调用证据', evidence: 'fixture-only', nextAction: '查看请求记录补齐证据', links: [{ label: '查看请求记录', to: '/logs' }] }] });
  if (api === '/protocol-coverage') return json(res, { sinceHours: 24, generatedAt: TIME, totalLogRequests: 0, totalRegisteredAppCallers: 0, totalActiveAppCallers: 0, coveredProtocols: 0, missingRuntimeProtocols: 0, items: [] });
  if (api === '/key-health') return json(res, { summary: { primaryConfigured: true, total: 2, ok: 2, missing: 0, unreadable: 0, status: 'ok' }, items: [] });
  if (api === '/config-authority/report') return json(res, { summary: { mapOnlyPools: 0, mapOnlyPlatforms: 0, mapOnlyModels: 0, mapOnlyExchanges: 0, activeMissingGatewayPool: 0, activeBoundPoolWithoutUsableMember: 0, activeAppCallerMapFallbackReady: true, mapFallbackObjectsRemaining: 0, readinessPercent: 100, status: 'ready' }, gaps: [] });
  if (['/platforms', '/models', '/exchanges', '/app-callers', '/logical-models'].includes(api)) return json(res, { items: [], total: 0 });
  unknown.push(`${req.method} ${api}`); return json(res, '未登记的夹具接口', false);
 }
 const rel = pathname.replace(/^\/llmgw(?=\/|$)/, '');
 const filename = !path.extname(rel) || rel === '/' ? 'index.html' : rel.replace(/^\//, '');
 const full = path.resolve(DIST, filename);
 if (!full.startsWith(`${DIST}${path.sep}`) || !fs.existsSync(full)) { res.writeHead(404);res.end();return; }
 res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[path.extname(full)] || 'application/octet-stream' }); fs.createReadStream(full).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const check = (name, ok, detail) => { if (!ok) errors.push({ name, detail }); };
async function stable(page) { await page.evaluate(async () => { await document.fonts.ready;await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }); }
async function measureTaskScroll(page, selector) {
 const target = page.locator(selector).first();
 const positions = () => page.evaluate(() => ({ document: document.scrollingElement.scrollTop, body: document.querySelector('.lg-page-body')?.scrollTop ?? 0 }));
 const initial = await positions();let wheels = 0;
 const complete = async () => { const r = await target.boundingBox();return !!r && r.y >= 0 && r.y + r.height <= page.viewportSize().height; };
 while (!await complete() && wheels < 12) {
  const pane = page.locator('.lg-page-body');const r = await pane.count() ? await pane.boundingBox() : null;
  await page.mouse.move(r ? r.x + r.width / 2 : page.viewportSize().width / 2, r ? r.y + r.height / 2 : page.viewportSize().height / 2);
  await page.mouse.wheel(0, 400);await page.waitForTimeout(120);wheels += 1;
 }
 const final = await positions();const visible = await complete();
 await page.evaluate(initial => { document.scrollingElement.scrollTop = initial.document;const body = document.querySelector('.lg-page-body');if (body) body.scrollTop = initial.body; }, initial);
 return { wheelActions: wheels, actualVerticalScroll: Math.abs(final.document - initial.document) + Math.abs(final.body - initial.body), completeVisible: visible, initial, final };
}
async function screenshot(page, id, metrics = {}) {
 await stable(page);
 const taskGeometry = await page.evaluate(id => {
  const rect = el => { if (!el) return null;const r = el.getBoundingClientRect();return { y: r.y, height: r.height, bottom: r.bottom }; };
  let target, wrappers = [];
  if (id.endsWith('-login')) { target = document.querySelector('.lg-login-submit');wrappers = [...document.querySelectorAll('.lg-login-capabilities')]; }
  if (id.endsWith('-members-small')) { target = document.querySelector('tbody tr');wrappers = [...document.querySelectorAll('.lg-form-grid')]; }
  if (id.endsWith('-usage')) { target = [...document.querySelectorAll('.lg-card-kicker')].find(el => /USD Gateway 估算/.test(el.textContent))?.parentElement;wrappers = [...document.querySelectorAll('[aria-labelledby="tenant-governance-title"] .lg-form-grid')]; }
  if (id.endsWith('-settings')) { target = document.querySelector('[role=radio]');wrappers = [...document.querySelectorAll('.lg-eyebrow,.lg-settings-card > .lg-card-kicker')]; }
  const core = rect(target);
  const beforeTask = wrappers.map(rect).filter(r => r && r.height > 0 && core && r.bottom <= core.y);
  return { core, nonessentialBeforeTaskHeight: beforeTask.reduce((sum, r) => sum + r.height, 0), minimumScrollToReadCore: core ? Math.max(0, core.bottom - innerHeight) : null };
 }, id);
 metrics = { ...metrics, ...taskGeometry };
 if (id.endsWith('-login')) metrics.task = { name: '填写两项并到达登录提交', clicksOrEntries: 3, ...await measureTaskScroll(page, '.lg-login-submit') };
 if (id.endsWith('-members-small')) metrics.task = { name: '进入组织并查看首个成员', clicksOrEntries: 1, ...await measureTaskScroll(page, 'tbody tr') };
 if (id.endsWith('-usage')) metrics.task = { name: '进入用量并完整读取首项USD估算卡', clicksOrEntries: 1, ...await measureTaskScroll(page, '.lg-usage-grid > div:has-text("USD Gateway 估算")') };
 if (id.endsWith('-settings')) metrics.task = { name: '进入偏好并选择主题', clicksOrEntries: 2, ...await measureTaskScroll(page, '[role=radio]') };
 const width = await page.evaluate(() => document.documentElement.scrollWidth); check(`${id}:无文档横溢出`, width <= page.viewportSize().width + 1, width); await page.screenshot({ path: path.join(OUT, `${id}.png`), animations: 'disabled' }); results.push({ id, provenance: 'deterministic-fixture', metrics: { ...metrics, documentWidth: width, bodyFont: await page.locator('body').evaluate(e => getComputedStyle(e).fontSize) } }); }
async function nav(page, route) { const menu = page.getByRole('button', { name: '打开导航', exact: true }); if (await menu.isVisible()) await menu.click(); await page.locator(`aside a[href$="${route}"]`).last().click(); await stable(page); }
async function login(page) { await page.goto(`${origin}/llmgw/organization`); await page.locator('#llmgw-username').fill('fixture-owner'); await page.locator('#llmgw-password').fill('fixture-only-password'); await page.getByRole('button', { name: '进入租户工作区', exact: true }).click(); await page.getByRole('heading', { name: '团队与成员', exact: true }).waitFor(); }
let browser;
try {
 browser = await chromium.launch({ executablePath: process.env.LLMGW_CHROMIUM || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined) });
 for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  const id = `${width}-${theme}`;
  if (process.env.LLMGW_ADMIN_DENSITY_FILTER && !new RegExp(process.env.LLMGW_ADMIN_DENSITY_FILTER).test(id)) continue;
  Object.assign(state, { members: 2, bills: 2, failure: '', role: 'owner', mustChange: false, loginFailure: false, teamFailure: true, createdTeam: false, missingCosts: false });
  const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 900 : 844 }, colorScheme: theme, isMobile: width === 390, hasTouch: width === 390 });
  const page = await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror', e => errors.push({ name: `${id}:运行异常`, detail: e.message }));
  try {
   await page.goto(`${origin}/llmgw/organization`);await page.locator('#llmgw-username').waitFor(); await stable(page);
   const user = await page.locator('#llmgw-username').boundingBox(), submit = await page.getByRole('button', { name: '进入租户工作区', exact: true }).boundingBox();
   await screenshot(page, `${id}-login`, { username: user, submit });
   check(`${id}:登录主操作首屏可见`, submit && submit.y + submit.height <= (width === 1440 ? 900 : 844), submit);
   if (process.env.LLMGW_ADMIN_TASKS_ONLY === '1') {
    await login(page);await page.locator('tbody tr').first().waitFor();const row = await page.locator('tbody tr').first().boundingBox();await screenshot(page, `${id}-members-small`, { firstRow: row });
    await nav(page, '/usage');await page.locator('.lg-card-kicker').filter({ hasText: /USD Gateway 估算/ }).waitFor();await screenshot(page, `${id}-usage`, { usage: await page.locator('.lg-card-kicker').filter({ hasText: /USD Gateway 估算/ }).boundingBox() });
    await nav(page, '/settings');await page.getByRole('radio').first().waitFor();await screenshot(page, `${id}-settings`, { choice: await page.getByRole('radio').first().boundingBox() });await page.getByRole('radio', { name: /^深色/ }).click();await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    continue;
   }
   await page.getByRole('button', { name: '进入租户工作区', exact: true }).click();await expect(page.getByRole('alert')).toContainText('请输入用户名和密码');
   await login(page);await page.locator('tbody tr').first().waitFor();await stable(page);
   const row = await page.locator('tbody tr').first().boundingBox();await screenshot(page, `${id}-members-small`, { firstRow: row });
   check(`${id}:成员先于低频团队创建`, row && row.y < (width === 1440 ? 330 : 420), row);
   await page.getByRole('button', { name: '添加成员', exact: true }).click();await expect(page.getByRole('dialog', { name: '添加成员', exact: true })).toBeVisible();await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
   const createTeam = page.locator('summary').filter({ hasText: /^创建团队$/ });
   if (await createTeam.count()) { await createTeam.focus();await page.keyboard.press('Enter');await expect(page.getByPlaceholder('客服组')).toBeVisible(); }
   await page.getByPlaceholder('客服组').fill('边界验收团队');await page.getByRole('button', { name: '创建团队', exact: true }).click();await expect(page.getByText('团队创建失败，未写入', { exact: true })).toBeVisible();
   if (width === 390 && theme === 'light') {
    await page.waitForTimeout(6200);await expect(page.getByText('团队创建失败，未写入', { exact: true })).toBeVisible();
    state.teamFailure = false;await page.getByRole('button', { name: '创建团队', exact: true }).click();await expect(page.getByText('团队“边界验收团队”已创建', { exact: true })).toBeVisible();await expect(page.getByRole('button', { name: '重命名团队 边界验收团队', exact: true })).toBeVisible();
    await page.waitForTimeout(6200);await expect(page.getByText('团队“边界验收团队”已创建', { exact: true })).toHaveCount(0);state.createdTeam = false;
   }
   state.members = 35;await page.reload();await page.locator('tbody tr').last().scrollIntoViewIfNeeded();await expect(page.locator('tbody tr').last()).toContainText('验收成员 35');await screenshot(page, `${id}-members-many`);
   state.members = 0;await page.reload();await expect(page.locator('tbody tr')).toHaveCount(0);await screenshot(page, `${id}-members-empty`);state.members = 2;
   state.failure = '/organization';await page.reload();await expect(page.getByText('验收接口不可用，请重试', { exact: true })).toBeVisible();await screenshot(page, `${id}-members-error`);state.failure = '';
   await nav(page, '/usage');await page.getByRole('heading', { name: '预算与用量', exact: true }).waitFor();await page.locator('.lg-usage-grid').first().waitFor();await stable(page);
   const usage = await page.locator('.lg-card-kicker').filter({ hasText: /USD Gateway 估算/ }).boundingBox();await screenshot(page, `${id}-usage`, { usage });check(`${id}:用量先于限额配置`, usage && usage.y < (width === 1440 ? 300 : 350), usage);
   const quotas = page.locator('summary').filter({ hasText: /^调整租户硬限制$/ });
   if (await quotas.count()) { check(`${id}:低频限额修改默认收起`, !await page.getByRole('button', { name: '保存硬限制', exact: true }).isVisible(), null);await quotas.focus();await page.keyboard.press('Enter'); }
   await expect(page.getByRole('button', { name: '保存硬限制', exact: true })).toBeVisible();await page.getByRole('button', { name: '保存硬限制', exact: true }).click();await expect(page.getByText('本月预算占用', { exact: true })).toBeVisible();
   await page.getByRole('button', { name: '导入供应商账单', exact: true }).click();const dialog = page.getByRole('dialog', { name: '导入供应商账单', exact: true });await expect(dialog).toBeVisible();await dialog.getByRole('button', { name: '关闭', exact: true }).click();await expect(dialog).not.toBeVisible();
   state.bills = 0;await page.reload();await expect(page.getByText('还没有供应商账单记录', { exact: true })).toBeAttached();await screenshot(page, `${id}-usage-empty`);
   state.bills = 21;await page.reload();await page.locator('.lg-reconciliation-card').last().scrollIntoViewIfNeeded();await expect(page.locator('.lg-reconciliation-card').last()).toContainText('账单-21');await screenshot(page, `${id}-usage-many`);state.bills = 2;
   state.missingCosts = true;await page.reload();await expect(page.getByText('本月预算占用', { exact: true })).toBeVisible();await expect(page.locator('.lg-usage-grid')).toHaveCount(0);await screenshot(page, `${id}-usage-missing-totals`);state.missingCosts = false;
   state.failure = '/cost-reconciliations';await page.reload();await expect(page.getByText(/费用估算仍可查看，但当前不能宣称已完成供应商对账/)).toBeAttached();await screenshot(page, `${id}-usage-error`);state.failure = '';
   await nav(page, '/settings');await page.getByRole('radiogroup', { name: '界面主题', exact: true }).waitFor();await stable(page);const choice = await page.getByRole('radio').first().boundingBox();await screenshot(page, `${id}-settings`, { choice });check(`${id}:主题选项去重复层`, choice && choice.y < (width === 1440 ? 190 : 180), choice);
   await page.getByRole('radio', { name: /^深色/ }).focus();await page.keyboard.press('Enter');await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');await page.getByRole('radio', { name: /^浅色/ }).click();await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');await page.getByRole('radio', { name: theme === 'light' ? /^浅色/ : /^深色/ }).click();
   for (const [route, heading] of [['/learn', '学习中心'], ['/gateway-settings', '服务网关设置'], ['/governance', '系统运维'], ['/quickstart', 'Quickstart']]) {
    await nav(page, route);await page.getByRole('heading', { name: heading, exact: true }).waitFor();await screenshot(page, `${id}-${route.slice(1)}`);
    if (route === '/gateway-settings') for (const label of ['钉一个模型池', '钉一个模型', '交给网关挑']) { await page.getByRole('radio', { name: new RegExp(`^${label}\\s`) }).click(); }
    if (route === '/governance') { await expect(page.getByText('验收阻塞项', { exact: true })).toBeVisible();await page.locator('summary').filter({ hasText: /容器拓扑/ }).click();await expect(page.getByText('llmgw-serve', { exact: true })).toBeVisible(); }
    if (route === '/learn') { check(`${id}:概念索引完整`, await page.locator('.lg-topic-grid > *').count() === 10, null); }
    if (route === '/quickstart') {
     await page.getByRole('textbox', { name: '我想做什么', exact: true }).fill('为客服助手接入文字对话');await page.getByRole('button', { name: '准备接入', exact: true }).click();await page.getByRole('button', { name: '下一步', exact: true }).waitFor();await screenshot(page, `${id}-quickstart-draft`);
     await page.getByRole('button', { name: '下一步', exact: true }).click();await page.getByRole('button', { name: '创建密钥', exact: true }).waitFor();await screenshot(page, `${id}-quickstart-owner`);
     state.failure = '/service-keys';await page.getByRole('button', { name: '创建密钥', exact: true }).click();await expect(page.getByRole('alert')).toContainText('appCaller 已就绪，但密钥签发失败');
     check(`${id}:签发失败说明无遮挡`, await page.getByRole('alert').evaluate(el => { const r = el.getBoundingClientRect();return [r.y + r.height / 2, r.bottom - 4].every(y => { const top = document.elementFromPoint(r.x + r.width / 2, y);return top === el || el.contains(top); }); }), '错误说明必须与创建主操作同时可读');await screenshot(page, `${id}-quickstart-key-error`);state.failure = '';
     await page.getByRole('button', { name: '创建密钥', exact: true }).click();await page.getByRole('tablist', { name: '接入产物', exact: true }).waitFor();await expect(page.getByText(/团队边界和密钥鉴权均通过/)).toBeVisible();
     for (const label of ['接入信息', 'cURL', '提示词']) { const tab = page.getByRole('tab', { name: label, exact: true });await tab.click();await expect(tab).toHaveAttribute('aria-selected', 'true');await expect(page.getByText('一次性密钥', { exact: true })).toBeAttached();await screenshot(page, `${id}-quickstart-${label === 'cURL' ? 'curl' : label === '提示词' ? 'prompt' : 'access'}`); }
    }
   }
   await page.getByLabel('打开用户菜单', { exact: true }).click();await page.locator('a[href$="/account"]').click();await page.getByRole('heading', { name: '账号与安全', exact: true }).waitFor();
   const userMenu = page.getByLabel('打开用户菜单', { exact: true });if (await userMenu.evaluate(e => e.parentElement.open)) await userMenu.click();
   await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible();await page.locator('summary').filter({ hasText: /^口令与一键登录的关系$/ }).click();await screenshot(page, `${id}-account`);
   await page.getByRole('button', { name: '保存', exact: true }).click();await expect(page.getByText('请填写当前口令', { exact: true })).toBeVisible();
  } catch (e) { errors.push({ name: `${id}:场景执行`, detail: e.message }); }
  finally { await context.close(); }
  const authContext = await browser.newContext({ viewport: { width, height: width === 1440 ? 900 : 844 }, colorScheme: theme, isMobile: width === 390, hasTouch: width === 390 });
  const authPage = await authContext.newPage();authPage.setDefaultTimeout(12000);
  try {
   Object.assign(state, { role: 'viewer', mustChange: false, failure: '' });await login(authPage);await expect(authPage.getByRole('button', { name: '添加成员', exact: true })).toHaveCount(0);await screenshot(authPage, `${id}-members-readonly`);
   await nav(authPage, '/usage');await expect(authPage.getByText('Owner 或 Admin 可修改租户总限制；当前角色仍可查看实时使用量。', { exact: true })).toBeAttached();await expect(authPage.getByRole('button', { name: '导入供应商账单', exact: true })).toHaveCount(0);await screenshot(authPage, `${id}-usage-readonly`);
   await nav(authPage, '/learn');await expect(authPage.getByText('由其他角色执行', { exact: true }).first()).toBeAttached();await screenshot(authPage, `${id}-learn-readonly`);
  } catch (e) { errors.push({ name: `${id}:只读边界`, detail: e.message }); }
  finally { await authContext.close(); }
  const forcedContext = await browser.newContext({ viewport: { width, height: width === 1440 ? 900 : 844 }, colorScheme: theme, isMobile: width === 390, hasTouch: width === 390 });
  const forced = await forcedContext.newPage();forced.setDefaultTimeout(12000);
  try {
   Object.assign(state, { role: 'owner', mustChange: true, failure: '' });await forced.goto(`${origin}/llmgw/organization`);await forced.locator('#llmgw-username').fill('fixture-owner');await forced.locator('#llmgw-password').fill('fixture-only');await forced.getByRole('button', { name: '进入租户工作区', exact: true }).click();await forced.getByPlaceholder('旧口令', { exact: true }).waitFor();await screenshot(forced, `${id}-change-password`);
   await forced.getByRole('button', { name: '设置新口令并进入', exact: true }).click();await expect(forced.getByText('请填写旧口令与新口令', { exact: true })).toBeVisible();
   await forced.getByPlaceholder('旧口令', { exact: true }).fill('fixture-old-password');await forced.getByPlaceholder('新口令（至少 12 位）', { exact: true }).fill('fixture-new-password');await forced.getByPlaceholder('确认新口令', { exact: true }).fill('fixture-new-password');await forced.getByRole('button', { name: '设置新口令并进入', exact: true }).click();await expect(forced.getByText('口令已修改成功。原会话已到期，请用新口令重新登录。', { exact: true })).toBeVisible();await screenshot(forced, `${id}-change-password-relogin`);
   await forced.goto(`${origin}/llmgw/auth/map`);await expect(forced.getByRole('alert')).toContainText('登录链接无效或已过期');await screenshot(forced, `${id}-sso-invalid`);
  } catch (e) { errors.push({ name: `${id}:认证边界`, detail: e.message }); }
  finally { await forcedContext.close(); }
 }
} finally { if (browser) await browser.close();await new Promise(resolve => server.close(resolve)); }
check('夹具接口完整', unknown.length === 0, unknown);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ provenance: 'deterministic-fixture', results, errors }, null, 2));
for (const e of errors) console.error(`${e.name}: ${JSON.stringify(e.detail)}`);
console.log(`管理页密度回归 ${results.length} 个截图场景，${errors.length} 个失败`);
if (errors.length) process.exitCode = 1;
