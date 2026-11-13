// 确定性布局回归：不连接真实服务，不证明外部集成成功。
// pnpm --dir llmgw/web build && node e2e/llmgw-content-density.mjs
// 对旧/新构建运行同一脚本：LLMGW_DIST=... LLMGW_DENSITY_OUT=... node ...
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(process.env.LLMGW_DIST || path.join(ROOT, 'llmgw/web/dist'));
const OUT = path.resolve(process.env.LLMGW_DENSITY_OUT || path.join(os.tmpdir(), 'llmgw-content-density'));
if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`缺少构建产物：${DIST}`);
fs.mkdirSync(OUT, { recursive: true });
const FIXED_TIME = '2026-11-13T08:00:00Z';
const scenarios = { count: 2, role: 'owner', failure: false, proxyFailure: false };
const provider = i => ({ id: `provider-${i}`, name: `供应方 ${String(i + 1).padStart(2, '0')}`, platformType: 'openai', providerId: 'fixture', apiUrl: 'https://provider.example.test/v1', enabled: i % 2 === 0, maxConcurrency: 4, hasKey: true, keyStatus: 'ok', keyFingerprint: 'sk-fi…test', authority: 'llm_gateway', sourceCollection: 'platforms', proxy: { mode: 'inherit' }, recentCallStatus: i === 1 ? 'quota_exhausted' : 'succeeded', createdAt: FIXED_TIME, updatedAt: FIXED_TIME });
const json = (res, data, success = true) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success, data: success ? data : null, error: success ? null : { code: 'FIXTURE_UNAVAILABLE', message: data } })); };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://fixture.test').pathname;
  if (/^\/(llmgw\/)?gw\//.test(pathname)) {
    const api = pathname.replace(/^\/(llmgw\/)?gw/, '');
    if (api === '/auth/login') return json(res, { token: 'deterministic-fixture-session', username: 'density-fixture', displayName: '密度验收', expiresAt: '2099-11-13T08:00:00Z', mustChangePassword: false, tenant: { id: 'density-fixture', name: '布局验收组织', isInternal: false, role: scenarios.role, teamIds: [] } });
    if (api === '/platforms') return scenarios.failure ? json(res, '供应方加载失败，请刷新后重试', false) : json(res, { items: Array.from({ length: scenarios.count }, (_, i) => provider(i)), total: scenarios.count });
    if (api === '/upstream-proxy' && req.method === 'PUT' && scenarios.proxyFailure) return json(res, '代理保存失败，请检查配置后重试', false);
    if (api === '/upstream-proxy') return json(res, { mode: 'inherit', effectiveMode: 'direct', effectiveSource: 'deployment' });
    if (api === '/organization') return json(res, { tenant: { id: 'density-fixture', name: '布局验收组织' }, teams: [], members: [] });
    if (api === '/legacy-key-cutover') return json(res, { applicable: false });
    if (api === '/service-keys') return json(res, Array.from({ length: 2 }, (_, i) => ({ id: `key-${i}`, name: `验收密钥 ${i + 1}`, keyPrefix: `gwk_fixture${i}`, enabled: true, sourceSystem: 'external', clientCode: `fixture-${i}`, environment: 'test', purpose: 'runtime', appCallerCodes: ['fixture.chat::chat'], ingressProtocols: ['openai-compatible'], scopes: ['invoke'], allowedCidrs: [], rotationState: 'active', createdAt: FIXED_TIME })));
    if (api === '/catalog-entries') return json(res, { items: [], total: 0, builtin: [], builtinCount: 0, knownCapabilities: ['chat'] });
    if (api === '/imagegen-configs') return json(res, { items: [], total: 0, builtin: [], builtinCount: 0, refreshSeconds: 60, staleAfterSeconds: 180, syncedAt: FIXED_TIME, syncedPatterns: [], syncHosts: [] });
    if (api === '/capabilities/image-layering') return json(res, { state: 'not-installed', installed: false, verified: false });
    if (api === '/exchanges/meta') return json(res, { modelTypes: [{ value: 'chat', label: '对话' }], transformerTypes: [], authSchemes: [] });
    if (api === '/logical-models') return json(res, { items: Array.from({ length: 31 }, (_, i) => ({ id: `logical-${i}`, publicId: `fixture-model-${i + 1}`, name: `验收模型 ${i + 1}`, modelType: 'chat', capabilities: ['chat'], allowedAppCallerCodes: [], routingStrategy: 'priority', enabled: true, isDefaultForType: false, defaultForAppCallerCodes: [], displayOrder: i, offerings: [] })), total: 31 });
    if (api === '/healthz') return json(res, { status: 'ok' });
    if (/^\/platforms\/[^/]+\/upstream-models$/.test(api)) return json(res, { items: [], total: 0, alreadyImportedCount: 0, pricingProvided: false, fetchedAt: FIXED_TIME, probedUrl: 'https://provider.example.test/v1/models' });
    return json(res, { items: [], total: 0 });
  }
  const rel = pathname.replace(/^\/llmgw(?=\/|$)/, '');
  const filename = !path.extname(rel) || rel === '/' ? 'index.html' : rel.replace(/^\//, '');
  const full = path.resolve(DIST, filename);
  if (!full.startsWith(`${DIST}${path.sep}`) || !fs.existsSync(full)) { res.writeHead(404); res.end(); return; }
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
  res.writeHead(200, { 'Content-Type': mime[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const launch = async () => {
  if (process.env.LLMGW_CHROMIUM) return chromium.launch({ executablePath: process.env.LLMGW_CHROMIUM });
  try { return await chromium.launch(); } catch (error) {
    if (!fs.existsSync('/usr/bin/chromium')) throw error;
    return chromium.launch({ executablePath: '/usr/bin/chromium' });
  }
};
let browser;
const results = [];
const failures = [];
const check = (name, pass, detail) => { if (!pass) failures.push({ name, detail }); };
async function visibleAndUncovered(locator) {
  if (!await locator.isVisible()) return false;
  return locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return r.width > 0 && r.height >= 24 && x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight && !!top && (top === el || el.contains(top));
  });
}
async function snapshot(page, id) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  const metrics = await page.evaluate(() => {
    const rect = selector => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom };
    };
    const table = document.querySelector('table');
    const scroll = table?.parentElement;
    const container = scroll?.parentElement;
    const firstRow = document.querySelector('tbody tr')?.getBoundingClientRect();
    const maintenanceBeforeData = Array.from(document.querySelectorAll('summary')).filter(el => /全局上游代理|批量轮换已有 Provider/.test(el.textContent || '')).map(el => el.parentElement.getBoundingClientRect()).filter(r => firstRow && r.bottom <= firstRow.top).reduce((height, r) => height + r.height, 0);
    return { maintenanceBeforeData, firstRow: rect('tbody tr'), table: rect('table'), container: container ? (() => { const r = container.getBoundingClientRect(); return { y: r.y, height: r.height, bottom: r.bottom }; })() : null, bodyScrollHeight: document.documentElement.scrollHeight, viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyFontSize: getComputedStyle(document.body).fontSize, theme: document.documentElement.dataset.theme };
  });
  await page.screenshot({ path: path.join(OUT, `${id}.png`), timeout: 30000, animations: 'disabled' });
  results.push({ id, provenance: 'deterministic-fixture', metrics });
  console.log(`${id}: row=${metrics.firstRow?.y ?? 'none'}, width=${metrics.documentWidth}`);
  check(`${id}:无文档横向溢出`, metrics.documentWidth <= metrics.viewportWidth + 1, metrics);
  return metrics;
}
async function login(page) {
  await page.goto(`${origin}/llmgw/platforms`, { waitUntil: 'domcontentloaded' });
  await page.locator('#llmgw-username').fill('density-fixture');
  await page.locator('#llmgw-password').fill('fixture-only');
  await page.getByRole('button', { name: '进入租户工作区' }).click();
  await page.waitForURL('**/llmgw/platforms');
  await page.getByRole('heading', { name: 'Provider（模型供应方）' }).waitFor();
}
try {
  browser = await launch();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) for (const theme of ['light', 'dark']) {
    const id = `${viewport.width}-${theme}`;
    const context = await browser.newContext({ viewport, colorScheme: theme });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => failures.push({ name: `${id}:运行异常`, detail: error.message }));
    scenarios.count = 2; scenarios.role = 'owner'; scenarios.failure = false;
    try {
      await login(page);
      await page.locator('tbody tr').first().waitFor();
      for (const [tab, heading] of [['模型名录', '模型名录'], ['生图契约', '生图契约'], ['转接上游', 'Exchange 映射'], ['Provider', 'Provider（模型供应方）']]) {
        const control = page.getByRole('tab', { name: tab, exact: true });
        check(`${id}:页签${tab}可见无遮挡`, await visibleAndUncovered(control), '导航不能因内容前置被裁剪或挤出视口');
        await control.click();
        await expect(control).toHaveAttribute('aria-selected', 'true');
        await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        if (tab !== 'Provider') await snapshot(page, `${id}-tab-${tab === '模型名录' ? 'catalog' : tab === '生图契约' ? 'imagegen' : 'exchange'}`);
      }
      await page.locator('tbody tr').first().waitFor();
      const small = await snapshot(page, `${id}-small`);
      check(`${id}:首条数据提前`, small.firstRow?.y <= (viewport.width > 600 ? 320 : 420), small.firstRow);
      check(`${id}:少量自然高度`, small.container && small.table && small.container.bottom - small.table.bottom <= 24, small);
      check(`${id}:单页无翻页操作`, await page.getByRole('button', { name: '上一页', exact: true }).count() === 0 && await page.getByRole('button', { name: '下一页', exact: true }).count() === 0, '两条数据只有一页');
      check(`${id}:添加主操作可见无遮挡`, await visibleAndUncovered(page.getByRole('button', { name: '添加 Provider', exact: true })), '主操作在首屏有可点击热区');
      const search = page.getByRole('searchbox', { name: '搜索供应方名称或接口' });
      await search.fill('供应方 02');
      await expect(page.locator('tbody tr')).toHaveCount(1);
      await expect(page.locator('tbody tr').first()).toContainText('余额或额度不足');
      await search.fill('没有这个供应方');
      await expect(page.getByText('没有匹配结果', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: '清除筛选', exact: true }).click();
      await expect(page.locator('tbody tr')).toHaveCount(2);
      await page.getByRole('combobox', { name: '清单状态筛选' }).selectOption('disabled');
      await expect(page.locator('tbody tr')).toHaveCount(1);
      await page.getByRole('combobox', { name: '清单状态筛选' }).selectOption('');
      await page.getByRole('button', { name: '还没有模型', exact: true }).first().click();
      await expect(page.getByRole('complementary', { name: '清单详情' })).toBeVisible();
      await expect(page.getByRole('button', { name: '关闭详情' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('complementary', { name: '清单详情' })).toHaveCount(0);
      await page.getByRole('button', { name: '添加 Provider', exact: true }).click();
      await expect(page.getByRole('button', { name: '保存并测试连接', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '收起配置', exact: true }).click();
      // 同一页面重新读取受控数据，不注入客户端鉴权或服务器业务状态。
      const proxySummary = page.locator('summary').filter({ hasText: '全局上游代理' });
      await proxySummary.click();
      await page.getByRole('button', { name: '应用全局设置', exact: true }).click();
      const savedNotice = page.getByText('全局代理已保存，跟随全局的上游会在新请求中使用此设置。', { exact: true });
      await expect(savedNotice).toBeVisible();
      await page.waitForTimeout(6200);
      check(`${id}:成功反馈自动退场`, await savedNotice.count() === 0, '成功后6秒不再占位');
      scenarios.proxyFailure = true;
      await page.getByRole('button', { name: '应用全局设置', exact: true }).click();
      await expect(page.getByText('代理保存失败，请检查配置后重试', { exact: true })).toBeVisible();
      await page.waitForTimeout(6200);
      await expect(page.getByText('代理保存失败，请检查配置后重试', { exact: true })).toBeVisible();
      scenarios.proxyFailure = false;
      scenarios.count = 31;
      await page.reload();
      await expect(page.locator('tbody tr')).toHaveCount(10);
      await snapshot(page, `${id}-many`);
      for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '下一页', exact: true }).click();
      await expect(page.locator('tbody tr')).toHaveCount(1);
      await expect(page.locator('tbody tr').first()).toContainText('供应方 31');
      await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
      await search.fill('供应方 01');
      await expect(page.locator('tbody tr')).toHaveCount(1);
      await expect(page.locator('tbody tr').first()).toContainText('供应方 01');
      check(`${id}:检索后单页不残留翻页`, await page.getByRole('button', { name: '上一页', exact: true }).count() === 0, '从第4页搜索一条结果应自然展示');
      scenarios.count = 0;
      await page.reload();
      await page.getByRole('button', { name: '保存并测试连接', exact: true }).waitFor();
      await snapshot(page, `${id}-empty`);
      check(`${id}:空态有新增入口`, await page.getByRole('button', { name: '保存并测试连接', exact: true }).count() > 0, '首次使用自动打开添加表单');
      scenarios.failure = true;
      await page.reload();
      await expect(page.getByText('供应方加载失败，请刷新后重试', { exact: true })).toBeVisible();
      await snapshot(page, `${id}-error`);
      await page.waitForTimeout(500);
      await expect(page.getByText('供应方加载失败，请刷新后重试', { exact: true })).toBeVisible();
      scenarios.failure = false; scenarios.count = 2;
      await page.reload();
      await expect(page.locator('tbody tr')).toHaveCount(2);
      // 共享CollectionView：密钥既有安全范围可读，窄屏卡片与桌面表格均可打开详情。
      async function navigateTo(label) {
        if (viewport.width < 700) await page.getByRole('button', { name: '打开导航', exact: true }).click();
        await page.getByRole('link', { name: label, exact: true }).click();
      }
      await navigateTo('接入密钥');
      const keySearch = page.getByRole('searchbox', { name: '搜索密钥名称、客户端或调用用途' });
      await keySearch.fill('验收密钥 2');
      await expect(page.getByText('验收密钥 2', { exact: true }).filter({ visible: true }).first()).toBeVisible();
      const keyDetail = viewport.width < 700 ? page.getByRole('button', { name: '1 个调用用途', exact: true }).filter({ visible: true }).first() : page.getByRole('button', { name: '详情', exact: true }).filter({ visible: true }).first();
      await keyDetail.click();
      await expect(page.getByRole('complementary', { name: '清单详情' })).toBeVisible();
      await expect(page.getByRole('button', { name: '权限范围', exact: true })).toBeVisible();
      await snapshot(page, `${id}-key-detail`);
      await page.getByRole('button', { name: '关闭详情', exact: true }).click();
      await navigateTo('模型');
      const modelSearch = page.getByRole('searchbox', { name: '搜索模型名称或公开标识' });
      await modelSearch.waitFor();
      await page.locator('.lg-collection-scroll').first().evaluate(el => { el.scrollTop = el.scrollHeight; });
      const loadMore = page.getByRole('button', { name: /继续加载/ });
      if (await loadMore.count()) await loadMore.click();
      await expect(page.getByText('验收模型 31', { exact: true })).toHaveCount(1);
      await page.getByText('验收模型 31', { exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByText('验收模型 31', { exact: true })).toBeVisible();
      await modelSearch.fill('fixture-model-31');
      await expect(page.getByRole('button', { name: '查看', exact: true })).toHaveCount(1);
      await page.getByRole('button', { name: '查看', exact: true }).click();
      await expect(page.getByRole('complementary', { name: '清单详情' })).toBeVisible();
      await snapshot(page, `${id}-model-detail`);
      await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    } catch (error) { failures.push({ name: `${id}:交互路径`, detail: error.message }); console.error(`${id}: ${error.message}`); await page.screenshot({ path: path.join(OUT, `${id}-failure.png`) }).catch(() => {}); }
    await context.close();
    scenarios.role = 'viewer'; scenarios.count = 2; scenarios.failure = false;
    const viewerContext = await browser.newContext({ viewport, colorScheme: theme });
    const viewer = await viewerContext.newPage(); viewer.setDefaultTimeout(15000);
    try {
      await login(viewer);
      await expect(viewer.locator('tbody tr')).toHaveCount(2);
      await snapshot(viewer, `${id}-viewer`);
      check(`${id}:只读无写入口`, await viewer.getByRole('button', { name: '添加 Provider', exact: true }).count() === 0, 'Viewer不得出现配置写入按钮');
      await expect(viewer.getByText('当前角色可以查看这些配置，但不能修改。需要变更时请联系 Owner 或 Admin。', { exact: true })).toBeVisible();
    } catch (error) { failures.push({ name: `${id}:只读路径`, detail: error.message }); }
    await viewerContext.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ provenance: 'deterministic-fixture', dist: DIST, results, failures }, null, 2));
}
console.log(JSON.stringify({ snapshots: results.length, failures, output: OUT }, null, 2));
process.exitCode = failures.length ? 1 : 0;
