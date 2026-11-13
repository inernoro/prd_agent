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
const caller = i => ({ id: `a${i}`, appCallerCode: `fixture.app-${i}::chat`, title: i === 1 ? `fixture.app-${i}::chat` : i === 3 ? '' : `验收调用方 ${i}`, requestType: 'chat', sourceSystem: 'fixture', status: 'active', allowedModelPoolIds: [], totalSeen: 1, lastSeenAt: time });
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
    if (api === '/logical-models') return send(res, { items: [{ id: 'logical', publicId: 'fixture-logical', name: '验收对外模型', modelType: 'chat', capabilities: ['chat'], allowedAppCallerCodes: [], defaultForAppCallerCodes: [], routingStrategy: 'priority', enabled: true, offerings: Array.from({ length: state.count }, (_, i) => ({ id: `route-${i + 1}`, targetKind: 'model', targetId: `m${i + 1}`, providerName: provider.name, targetName: `fixture-model-${i + 1}`, upstreamModelId: `fixture-model-${i + 1}`, priority: i + 1, weight: 1, enabled: true, healthStatus: 0 })) }], total: 1 });
    if (api === '/models') return send(res, { items: Array.from({ length: state.count }, (_, i) => model(i + 1)), total: state.count });
    if (api === '/service-keys') return send(res, Array.from({ length: state.count }, (_, i) => key(i + 1)));
    if (api === '/legacy-key-cutover') return send(res, { applicable: true, requiredIngressProtocols: ['openai-compatible'], requiredScopes: ['invoke'], status: 'observing', deadlineAt: '2099-11-13T08:00:00Z', allowedAppCallerCodes: ['fixture.access::chat'], successorServiceKeyIds: [], requiredSuccessorObservations: 1, successorObservedCount: 0, usage: [] });
    if (api === '/upstream-proxy') return send(res, { mode: 'inherit', effectiveMode: 'direct', effectiveSource: 'deployment' });
    if (api === '/capabilities/image-layering') return send(res, { capabilityId: 'image-layering', state: 'not-installed', installed: false, verified: false, hasKey: false, modelId: 'fal-qwen-image-layered', publicId: 'image-layering' });
    if (api === '/capabilities/image-layering/install') return send(res, null, false);
    if (api === '/exchanges/meta') return send(res, { modelTypes: [{ value: 'chat', label: '对话' }], transformerTypes: [], authSchemes: [] });
    if (api === '/exchanges') return send(res, { items: [1, 2].map(i => ({ id: `exchange-${i}`, name: `验收转接 ${i}`, enabled: true, hasKey: true, authority: 'llm_gateway', transformerType: 'passthrough', targetUrl: 'https://example.test/chat', targetAuthScheme: 'Bearer', version: '1', proxy: { mode: 'inherit' }, models: [{ modelId: `fixture-model-${i}`, modelType: 'chat', enabled: true }] })), total: 2 });
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
    if (process.env.LLMGW_CATALOG_FILTER && !new RegExp(process.env.LLMGW_CATALOG_FILTER).test(`${narrow ? 'narrow' : 'desktop'}-${theme}`)) continue;
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
        const last = (el.closest('tbody')?.lastElementChild || el.closest('.lg-collection-scroll')?.lastElementChild)?.getBoundingClientRect();
        const ordinarySection = el.closest('.lg-entity-detail-collection')?.getBoundingClientRect();
        const area = selector => [...document.querySelectorAll(selector)].filter(node => { const box = node.getBoundingClientRect(); return box.height > 0 && box.bottom <= r.y + 1; }).reduce((sum, node) => sum + node.getBoundingClientRect().height, 0);
        const coveragePadding = [];
        for (const node of document.querySelectorAll('.lg-collection-key-overview > div, .lg-collection-key-legacy')) {
          const box = node.getBoundingClientRect(), css = getComputedStyle(node);
          if (box.height <= 0 || box.bottom > r.y) continue;
          coveragePadding.push([box.top, box.top + parseFloat(css.paddingTop) + parseFloat(css.borderTopWidth)], [box.bottom - parseFloat(css.paddingBottom) - parseFloat(css.borderBottomWidth), box.bottom]);
        }
        coveragePadding.sort((a, b) => a[0] - b[0]);
        let paddingHeight = 0, end = -Infinity;
        for (const [start, bottom] of coveragePadding) { paddingHeight += Math.max(0, bottom - Math.max(start, end)); end = Math.max(end, bottom); }
        const installer = document.querySelector('#image-layering > :last-child')?.getBoundingClientRect();
        const source = [...document.querySelectorAll('.lg-entity-detail-facts > div')].find(node => node.querySelector('dt')?.textContent === '来源系统')?.getBoundingClientRect();
        const heading = document.querySelector('.lg-page-heading,.lg-app-caller-header')?.getBoundingClientRect();
        const genericIntro = [...document.querySelectorAll('.lg-page-heading > div > p:not(.lg-summary-strip),.lg-app-caller-header p')].reduce((sum, node) => sum + node.getBoundingClientRect().height, 0);
        return { y: r.y, height: r.height, font: getComputedStyle(el).fontSize, viewport: innerWidth, width: document.documentElement.scrollWidth, headingHeight: heading?.height, genericIntro, scrollTail: scroll && last ? scroll.getBoundingClientRect().bottom - last.bottom : null,
          firstRecordScroll: Math.max(0, r.bottom - innerHeight),
          nonessentialBeforeData: { bulkMaintenance: [...document.querySelectorAll('summary')].filter(node => node.textContent.includes('高级：批量维护已有模型') && node.parentElement.getBoundingClientRect().bottom <= r.y).reduce((sum, node) => sum + node.parentElement.getBoundingClientRect().height, 0), coverageWrapperPadding: paddingHeight, genericAppIntroduction: area('.lg-app-detail-compact .lg-entity-detail-description, .lg-entity-detail-page:not(.lg-entity-detail-bounded) .lg-entity-detail-description'), installationForm: installer && installer.height > 0 && installer.bottom <= r.y ? installer.height : 0 },
          sourceFactScroll: source ? Math.max(0, source.bottom - innerHeight) : null, ordinarySectionTail: ordinarySection && last ? ordinarySection.bottom - last.bottom : null };
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
    check('模型登记解释不常驻数据前，标题与新增仍可见', models.genericIntro === 0 && models.headingHeight <= 44, models);
    const modelHelp = page.getByLabel('模型登记说明', { exact: true });
    if (await modelHelp.count()) { await modelHelp.focus(); await modelHelp.press('Enter'); const note = page.getByRole('note').filter({ hasText: '匹配的默认模型池' }); await expect(note).toBeVisible(); const r = await note.boundingBox(); check('模型说明未裁出视口', r.x >= 0 && r.x + r.width <= (narrow ? 390 : 1440), r); await modelHelp.press('Enter'); }
    const maintenance = page.locator('summary').filter({ hasText: '高级：批量维护已有模型' });
    const before = await maintenance.evaluate(el => el.getBoundingClientRect().bottom);
    check('模型数据先于低频批量维护', models.y < before, { models, maintenanceBottom: before });
    if (!narrow) check('少量物理模型不撑空表体', models.scrollTail < 8, models);
    await maintenance.click(); await expect(page.getByRole('button', { name: '批量轮换密钥', exact: true })).toBeVisible(); await maintenance.click();
    await page.goto(`${origin}/llmgw/app-callers`); await expect(page.locator('tbody tr')).toHaveCount(2);
    const callers = await snapshot('callers-two', narrow ? '.lg-app-caller-mobile-card' : 'tbody tr');
    check('调用方通用说明不重复占据默认首屏', callers.genericIntro === 0 && callers.headingHeight <= 44, callers);
    const firstIdentity = page.locator(narrow ? '.lg-app-caller-mobile-card .lg-app-caller-identity' : 'tbody tr .lg-app-caller-identity').first();
    check('同名标题不重复标识，来源保留', (await firstIdentity.innerText()).split('fixture.app-1::chat').length === 2 && (await firstIdentity.innerText()).includes('fixture'), await firstIdentity.innerText());
    await expect(page.getByText('验收调用方 2 · fixture', { exact: true }).filter({ visible: true })).toBeVisible();
    check('单页调用方无无效翻页', await page.getByRole('button', { name: '下一页', exact: true }).count() === 0, callers);
    if (!narrow) check('少量调用方不撑空表体', callers.scrollTail < 8, callers);
    const config = page.getByRole('button', { name: '配置', exact: true }).filter({ visible: true }).first();
    if (narrow) check('窄屏卡片不裁掉主操作', await config.evaluate(el => el.getBoundingClientRect().bottom <= el.closest('article').getBoundingClientRect().bottom + 1), '主操作不能依赖自动滚动overflow:hidden容器才出现');
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
    await page.goto(`${origin}/llmgw/platforms?view=exchange`); await expect(page.getByTestId('exchange-list')).toBeVisible();
    const exchange = await snapshot('exchange-two', '[data-testid="exchange-list"] > div');
    check('转接映射先于低频安装表单出现', exchange.y < (narrow ? 600 : 450), exchange);
    check('图片分层默认保留状态且按需安装', !await page.locator('#fal-image-layering-key').isVisible(), exchange);
    await expect(page.locator('#image-layering').getByText('未安装', { exact: true })).toBeVisible();
    const ability = page.locator('details#image-layering');
    if (await ability.count()) {
      await ability.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
      await expect(page.locator('#fal-image-layering-key')).toBeVisible();
    }
    await page.locator('#fal-image-layering-key').fill('fixture-only-not-a-real-key');
    await page.getByRole('button', { name: '安装能力', exact: true }).click();
    await expect(page.getByText('布局夹具读取失败，请重试', { exact: true })).toBeVisible();
    if (await ability.count()) await ability.locator(':scope > summary').click();
    await expect(page.getByText('布局夹具读取失败，请重试', { exact: true })).toBeVisible();
    await page.goto(`${origin}/llmgw/platforms?view=exchange#image-layering`);
    await expect(page.locator('#fal-image-layering-key')).toBeVisible();
    for (const kind of ['model', 'provider']) {
      state.count = 2;
      await page.goto(`${origin}/llmgw/${kind === 'model' ? 'models/view?modelId=m1&platformId=provider&model=fixture-model-1' : 'platforms/view?id=provider&name=fixture'}`);
      const data = kind === 'model' ? '.lg-entity-detail-collection .lg-collection-detail-card' : '.lg-collection-hosted-table tbody tr';
      await expect(page.locator(data)).toHaveCount(kind === 'model' ? 1 : 2);
      const few = await snapshot(`${kind}-detail-few`, data);
      check(`${kind}少量记录不由详情容器撑空`, few.ordinarySectionTail < 8, few);
      check(`${kind}单页不展示无效翻页`, await page.getByRole('button', { name: '下一页', exact: true }).count() === 0, few);
      state.count = 31;
      await page.goto(`${origin}/llmgw/${kind === 'model' ? 'models/view?logicalModelId=logical&model=fixture-logical' : 'platforms/view?id=provider&name=fixture'}`);
      await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeVisible();
      for (let index = 0; index < 3; index++) await page.getByRole('button', { name: '下一页', exact: true }).click();
      await expect(page.getByText(kind === 'model' ? 'fixture-model-31' : 'fixture-model-9', { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
      await snapshot(`${kind}-detail-many-last`, 'tbody tr');
      if (kind === 'provider') {
        await page.getByRole('searchbox', { name: '搜索模型名称、标识或协议' }).fill('fixture-model-31');
        await expect(page.getByText('fixture-model-31', { exact: true }).first()).toBeVisible();
      }
    }
    state.count = 51; await page.goto(`${origin}/llmgw/app-callers`); await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下一页', exact: true }).click(); await expect(page.getByText('fixture.app-51::chat', { exact: true }).filter({ visible: true })).toBeVisible();
    await snapshot('callers-many-last', narrow ? '.lg-app-caller-mobile-card' : 'tbody tr');
    state.count = 0; await page.reload(); await expect(page.getByText('没有匹配的 appCaller', { exact: true }).filter({ visible: true })).toBeVisible();
    state.failure = true; await page.reload(); await expect(page.getByText('布局夹具读取失败，请重试', { exact: true })).toBeVisible();
    check('页面无运行时错误', errors.length === 0, errors); await context.close();
  }
} catch (error) { failures.push({ name: '浏览器核心路径', error: error.message }); console.error(error.message); } finally { await browser.close(); server.close(); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, failures }, null, 2)); }
console.log(JSON.stringify({ snapshots: results.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
