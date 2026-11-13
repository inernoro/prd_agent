// 页面几何回归；固定数据只证明布局与交互，不替代真实预览验收。
// LLMGW_DIST=<旧/新 dist> LLMGW_CATALOG_OUT=<证据目录> node e2e/llmgw-catalog-density.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(process.env.LLMGW_DIST || path.join(ROOT, 'llmgw/web/dist'));
const OUT = process.env.LLMGW_CATALOG_OUT || path.join(os.tmpdir(), 'llmgw-catalog-density');
fs.mkdirSync(OUT, { recursive: true });
const state = { count: 2, failure: false, role: 'owner', promptVersion: 0, promptFailure: false };
const time = '2026-11-13T08:00:00Z';
const provider = { id: 'provider', name: '验收供应方', platformType: 'openai', enabled: true, authority: 'llm_gateway', apiUrl: 'https://example.test/v1', hasKey: true, proxy: { mode: 'inherit' } };
const model = i => ({ id: `m${i}`, platformId: 'provider', modelName: `fixture-model-${i}`, name: `验收模型 ${i}`, enabled: true, authority: 'llm_gateway', capabilities: [{ type: 'chat' }], createdAt: time });
const key = i => ({ id: `k${i}`, name: `验收密钥 ${i}`, keyPrefix: `gwk_fixture${i}`, enabled: true, sourceSystem: 'external', clientCode: `fixture-${i}`, environment: 'test', purpose: 'external-platform', appCallerCodes: ['fixture.access::chat'], ingressProtocols: ['openai-compatible'], scopes: ['invoke'], allowedCidrs: [], rotationState: 'active', createdAt: time });
const caller = i => ({ id: `a${i}`, appCallerCode: `fixture.app-${i}::chat`, title: `验收调用方 ${i}`, requestType: 'chat', sourceSystem: 'fixture', status: 'active', allowedModelPoolIds: [], totalSeen: 1, lastSeenAt: time });
const send = (res, data, success = true) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success, data: success ? data : null, error: success ? null : { code: 'FIXTURE_ERROR', message: '布局夹具读取失败，请重试' } })); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture.test');
  if (/^\/(llmgw\/)?gw\//.test(url.pathname)) {
    const api = url.pathname.replace(/^\/(llmgw\/)?gw/, '');
    if (api === '/auth/login') return send(res, { token: 'catalog-fixture-session', username: 'fixture', displayName: '布局验收', expiresAt: '2099-11-13T08:00:00Z', mustChangePassword: false, tenant: { id: 'fixture', name: '验收组织', role: state.role, isInternal: true, teamIds: [] } });
    if (state.failure && ['/models', '/app-callers', '/service-keys'].includes(api)) return send(res, null, false);
    if (/^\/app-callers\/[^/]+\/prompt-policy$/.test(api)) {
      if (req.method === 'PUT' && state.promptFailure) return send(res, null, false);
      if (req.method === 'PUT') state.promptVersion++;
      const current = { id: 'policy', appCallerCode: 'fixture.app-1::chat', requestType: 'chat', systemPromptPrefix: '', systemPromptSuffix: '', enabled: true, version: state.promptVersion, allowedVariables: [], maxChars: 8000, policyHash: 'fixture-policy-hash', policyChars: 0, updatedAt: time };
      return send(res, req.method === 'PUT' ? current : { appCallerId: 'a1', appCallerCode: 'fixture.app-1::chat', requestType: 'chat', current: state.promptVersion ? current : null, versions: state.promptVersion ? [current] : [] });
    }
    if (api === '/platforms') return send(res, { items: [provider], total: 1 });
    if (api === '/models') return send(res, { items: Array.from({ length: state.count }, (_, i) => model(i + 1)), total: state.count });
    if (api === '/service-keys') return send(res, Array.from({ length: state.count }, (_, i) => key(i + 1)));
    if (api === '/legacy-key-cutover') return send(res, { applicable: true, requiredIngressProtocols: ['openai-compatible'], requiredScopes: ['invoke'], status: 'observing', deadlineAt: '2099-11-13T08:00:00Z', allowedAppCallerCodes: ['fixture.access::chat'], successorServiceKeyIds: [], requiredSuccessorObservations: 1, successorObservedCount: 0, usage: [] });
    if (api === '/organization') return send(res, { tenant: { id: 'fixture', name: '验收组织' }, teams: [], members: [] });
    if (api === '/app-callers') {
      let all = Array.from({ length: state.count }, (_, i) => caller(i + 1));
      if (url.searchParams.get('search')) all = all.filter(item => item.appCallerCode.includes(url.searchParams.get('search')));
      const page = Number(url.searchParams.get('page') || 1), size = Number(url.searchParams.get('pageSize') || 50);
      return send(res, { items: all.slice((page - 1) * size, page * size), total: all.length, statuses: ['active'], sourceSystems: ['fixture'], ingressProtocols: ['openai-compatible'], requestTypes: ['chat'] });
    }
    return send(res, { items: [], total: 0, templates: [] });
  }
  const rel = url.pathname.replace(/^\/llmgw(?=\/|$)/, '');
  const file = path.resolve(DIST, !path.extname(rel) || rel === '/' ? 'index.html' : rel.replace(/^\//, ''));
  if (!file.startsWith(`${DIST}${path.sep}`) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const failures = [], results = [];
const check = (name, ok, metrics) => { if (!ok) failures.push({ name, metrics }); };
const browser = await chromium.launch(process.env.LLMGW_CHROMIUM ? { executablePath: process.env.LLMGW_CHROMIUM } : fs.existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {});
try {
  for (const narrow of [false, true]) for (const theme of ['light', 'dark']) {
    state.count = 2; state.failure = false; state.role = 'owner'; state.promptVersion = 0; state.promptFailure = false;
    const context = await browser.newContext({ viewport: narrow ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: narrow, hasTouch: narrow, colorScheme: theme });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('fixture pageerror', error.message); });
    await page.goto(`${origin}/llmgw/service-keys`);
    await page.locator('#llmgw-username').fill('fixture'); await page.locator('#llmgw-password').fill('fixture'); await page.getByRole('button', { name: '进入租户工作区', exact: true }).click();
    await page.waitForURL('**/llmgw/service-keys');
    await page.screenshot({ path: path.join(OUT, 'login-result.png') });
    async function snapshot(id, selector) {
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      const metrics = await page.locator(selector).first().evaluate(el => {
        const r = el.getBoundingClientRect(); let scroll = el.parentElement;
        while (scroll && !['auto', 'scroll'].includes(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
        const last = el.closest('tbody')?.lastElementChild?.getBoundingClientRect();
        return { y: r.y, height: r.height, font: getComputedStyle(el).fontSize, viewport: innerWidth, width: document.documentElement.scrollWidth, scrollTail: scroll && last ? scroll.getBoundingClientRect().bottom - last.bottom : null };
      });
      const name = `${narrow ? 'narrow' : 'desktop'}-${theme}-${id}`;
      await page.screenshot({ path: path.join(OUT, `${name}.png`) }); results.push({ id: name, provenance: 'deterministic-fixture', metrics });
      check(`${name}:无文档横向溢出`, metrics.width <= metrics.viewport + 1, metrics);
      return metrics;
    }
    await expect(page.getByPlaceholder('搜索密钥名称、客户端或调用用途')).toBeVisible();
    const keys = await snapshot('keys-two', narrow ? '.lg-service-key-card' : '.lg-service-key-table tbody tr');
    check('少量密钥前的包装降低且安全状态保留', keys.y < (narrow ? 510 : 400), keys);
    await expect(page.getByText('runtime 缺失', { exact: true })).toBeVisible();
    await page.locator('summary').filter({ hasText: 'Legacy shared key' }).click();
    await expect(page.getByRole('button', { name: '保存收口策略', exact: true })).toBeVisible();
    await page.locator('summary').filter({ hasText: 'Legacy shared key' }).click();
    await page.getByRole('button', { name: '新建密钥', exact: true }).click();
    await expect(page.getByText('高级权限与安全设置', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.goto(`${origin}/llmgw/models`); await expect(page.locator('tbody tr')).toHaveCount(2);
    const models = await snapshot('models-two', 'tbody tr');
    const maintenance = page.locator('summary').filter({ hasText: '高级：批量维护已有模型' });
    const before = await maintenance.evaluate(el => el.getBoundingClientRect().bottom);
    check('模型数据先于低频批量维护', models.y < before, { models, maintenanceBottom: before });
    if (!narrow) check('少量物理模型不撑空表体', models.scrollTail < 8, models);
    await maintenance.click(); await expect(page.getByRole('button', { name: '批量轮换密钥', exact: true })).toBeVisible(); await maintenance.click();
    await page.goto(`${origin}/llmgw/app-callers`); await expect(page.locator('tbody tr')).toHaveCount(2);
    const callers = await snapshot('callers-two', narrow ? '.lg-app-caller-mobile-card' : 'tbody tr');
    check('单页调用方无无效翻页', await page.getByRole('button', { name: '下一页', exact: true }).count() === 0, callers);
    if (!narrow) check('少量调用方不撑空表体', callers.scrollTail < 8, callers);
    const config = page.getByRole('button', { name: '配置', exact: true }).filter({ visible: true }).first();
    await config.click(); await expect(page.getByRole('button', { name: '保存配置', exact: true }).filter({ visible: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).filter({ visible: true }).first().click();
    await page.goto(`${origin}/llmgw/app-callers/view?code=fixture.app-1%3A%3Achat`); await expect(page.locator('h1')).toBeVisible();
    const appDetail = await snapshot('app-detail', '.lg-entity-detail-section');
    check('App详情先于重复包装出现', appDetail.y < (narrow ? 800 : 400), appDetail);
    await expect(page.getByText('月预算', { exact: true }).first()).toBeVisible();
    await page.goto(`${origin}/llmgw/app-callers/a1/prompt-policy`); await expect(page.getByRole('button', { name: '保存新版本', exact: true })).toBeVisible();
    await snapshot('prompt-policy', '.lg-prompt-policy-grid');
    if (!narrow && theme === 'light') {
      await page.getByRole('button', { name: '保存新版本', exact: true }).click();
      await expect(page.getByText('已保存版本 v1', { exact: true })).toBeVisible();
      await page.waitForTimeout(6500);
      check('明确成功回执自动退场', await page.getByText('已保存版本 v1', { exact: true }).count() === 0, { elapsed: 6500 });
      state.promptFailure = true; await page.getByRole('button', { name: '保存新版本', exact: true }).click();
      await expect(page.getByText('布局夹具读取失败，请重试', { exact: true })).toBeVisible(); await page.waitForTimeout(6500);
      await expect(page.getByText('布局夹具读取失败，请重试', { exact: true })).toBeVisible();
      state.promptFailure = false;
    }
    state.count = 51; await page.goto(`${origin}/llmgw/app-callers`); await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(page.getByText('fixture.app-51::chat', { exact: true }).filter({ visible: true })).toBeVisible();
    await snapshot('callers-many-last', narrow ? '.lg-app-caller-mobile-card' : 'tbody tr');
    state.count = 0; await page.reload(); await expect(page.getByText('没有匹配的 appCaller', { exact: true }).filter({ visible: true })).toBeVisible();
    state.failure = true; await page.reload(); await expect(page.getByText('布局夹具读取失败，请重试', { exact: true })).toBeVisible();
    check('页面无运行时错误', errors.length === 0, errors); await context.close();
  }
} finally { await browser.close(); server.close(); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, failures }, null, 2)); }
console.log(JSON.stringify({ snapshots: results.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
