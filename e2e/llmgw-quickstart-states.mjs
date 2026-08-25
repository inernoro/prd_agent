// Quickstart 主线改版验收：五个状态、失败归因三环、产物首屏可见。
//
// 用法：
//   cd llmgw/web && pnpm build          # 先产出 dist
//   cd e2e && pnpm install && node llmgw-quickstart-states.mjs
//
// 可选环境变量：
//   LLMGW_DIST                构建产物目录（默认 <repo>/llmgw/web/dist）
//   PLAYWRIGHT_CHROMIUM_PATH  指定 chromium 可执行文件
//
// 这条守卫盯的是三件「改完看着都对、下一次改版最容易悄悄退化」的事：
//
//   1. **结果块必须在产物栏第一位，且首屏不滚动就能看见。**
//      改版前它排在地址与密钥之后，1440x900 下落在折叠线以下——「失败在哪」要再滚一屏
//      才看得到，等于把唯一有用的信息藏起来。这条断言取的是元素的真实 boundingBox，
//      不是「有没有渲染」。
//   2. **失败归因走 error.code，不走文案。** 三环（密钥鉴权 / 团队与作用域 /
//      调用用途 → 模型池）的着色必须随码变化：坏在第 N 环，之前判通过、之后判未知——
//      没走到的环不许画成绿色（那会让人以为模型池是好的）。
//   3. **失败态的主行动真的会去绑池。** 断言点击后发出 PUT /gw/app-callers/{id}，
//      而不是只换一句文案。
//
// 断言的是真实浏览器行为与真实网络请求，桩只负责让页面跑起来。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.LLMGW_DIST || path.join(REPO_ROOT, 'llmgw/web/dist');
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const PORT = 5627;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const nowIso = new Date().toISOString();
const REQUEST_ID = 'quickstart-8f2c41d9ab7e4c30';

/** 数据面桩行为：pass / fail-pool / fail-scope / fail-key。 */
let gatewayMode = 'pass';
/** 浏览器真正发出的控制台写请求。 */
const posted = [];

const LIST = { items: [], total: 0, page: 1, pageSize: 20 };
const STUBS = {
  '/auth/tenants': [],
  '/service-keys': [],
  '/app-callers': { ...LIST },
  '/pool-types': { items: [{ code: 'chat', name: '对话默认池', purpose: '常规对话', sortOrder: 1, defaultPoolId: 'pool-1', modelCount: 2, ready: true, version: 1 }], total: 1, ready: 1, waiting: 0 },
  '/organization': {
    tenant: { id: 't1', name: 'Miduo 平台', slug: 'miduo', status: 'active', isInternal: false },
    teams: [{ id: 'team-1', name: '核心平台组', status: 'active', createdAt: nowIso, updatedAt: nowIso }],
    members: [],
  },
};

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': REQUEST_ID, 'X-Gateway-Upstream-Called': 'false' });
  res.end(JSON.stringify(body));
};

const GATEWAY_FAILURES = {
  'fail-pool': [424, { error: { code: 'APPCALLER_POOL_UNBOUND', message: 'GW appCaller 未绑定有效 GW 模型池' } }],
  'fail-scope': [403, { error: { code: 'GATEWAY_KEY_SCOPE_DENIED', message: 'gateway key scope does not allow this request' } }],
  'fail-key': [401, { error: { code: 'GATEWAY_KEY_INVALID', message: 'gateway key is invalid' } }],
};

const server = http.createServer((req, res) => {
  const p = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (p === '/v1/chat/completions' || p === '/gw/v1/invoke' || p === '/v1/messages' || p.startsWith('/v1beta/')) {
    const failure = GATEWAY_FAILURES[gatewayMode];
    if (failure) return json(res, failure[0], failure[1]);
    return json(res, 200, { model: 'demo/chat-1', gateway: { requestId: REQUEST_ID, upstreamCalled: false } });
  }
  if (p === '/gw/v1/resolve') return json(res, 200, { success: true, actualModel: 'demo/chat-1', actualPlatformName: '教程假上游', modelGroupName: '对话默认池', protocol: 'openai' });
  if (p.startsWith('/llmgw/gw/')) {
    const api = p.replace('/llmgw/gw', '');
    if (api === '/auth/login') {
      return json(res, 200, { success: true, error: null, data: {
        token: 'stub', username: 'zhou', displayName: 'zhou', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        mustChangePassword: false, tenant: { id: 't1', name: 'Miduo 平台', isInternal: false, role: 'owner', teamIds: ['team-1'] },
      } });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        posted.push({ method: req.method, api, body: raw ? JSON.parse(raw) : null });
        if (api === '/app-callers') return json(res, 200, { success: true, error: null, data: { id: 'ac-new', appCallerCode: 'miduo-agent.quickstart::chat', requestType: 'chat' } });
        if (api === '/service-keys') return json(res, 200, { success: true, error: null, data: { id: 'k-new', key: 'gwk_7f2c9a1e4b8d3f6021ca77e5db34', keyPrefix: 'gwk_7f2c', name: 'miduo-agent-quickstart' } });
        return json(res, 200, { success: true, error: null, data: { id: 'ac-new' } });
      });
      return undefined;
    }
    return json(res, 200, { success: true, error: null, data: STUBS[api.split('?')[0]] ?? { ...LIST, items: [] } });
  }
  const rel = p.replace(/^\/llmgw/, '');
  const file = rel === '' || rel === '/' || !path.extname(rel) ? '/index.html' : rel;
  const full = path.join(DIST, file);
  if (!fs.existsSync(full)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  res.end(fs.readFileSync(full));
});

const failures = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`);
  console.log(`${ok ? '通过' : '失败'}  ${label}  ${JSON.stringify(actual)}`);
};

await new Promise((r) => server.listen(PORT, r));
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`找不到构建产物：${DIST}\n请先执行 cd llmgw/web && pnpm build，或用 LLMGW_DIST 指定 dist 目录。`);
  process.exit(1);
}

const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const base = `http://localhost:${PORT}/llmgw`;

async function openQuickstart(theme = 'dark', width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${base}/quickstart`);
  await page.evaluate((value) => localStorage.setItem('llmgw.theme', value), theme);
  await page.reload();
  await page.waitForSelector('#llmgw-username');
  await page.fill('#llmgw-username', 'zhou');
  await page.fill('#llmgw-password', 'demo');
  await page.click('button[type=submit]');
  await page.waitForURL('**/llmgw/quickstart');
  await page.waitForTimeout(900);
  return page;
}

/** 三环着色：读的是真实 class，不是文案。 */
async function chainTones(page) {
  return page.$$eval('.lg-qs-chain-link', (nodes) => nodes.map((node) => {
    const tone = node.className.includes('is-ok') ? 'ok' : node.className.includes('is-bad') ? 'bad' : 'unknown';
    return `${node.textContent.trim()}=${tone}`;
  }));
}

// ── 1) 未签发：主行动唯一，产物栏是空态 ──────────────────────────────
gatewayMode = 'pass';
let page = await openQuickstart();
check('未签发时只有一个主按钮', await page.locator('.lg-qs-primary').count(), 1);
check('未签发时产物栏是空态', await page.locator('.lg-qs-empty-list').count(), 1);
check('未签发时不出现一次性密钥', await page.locator('.lg-quickstart-secret').count(), 0);

// ── 2) 已签发：先登记调用用途再签发密钥，结果块排在产物栏第一位且首屏可见 ──
posted.length = 0;
await page.getByRole('button', { name: '签出密钥并跑通一条请求' }).click();
await page.waitForTimeout(2200);
check('签发的两个写请求与顺序', posted.map((item) => `${item.method} ${item.api}`), ['POST /app-callers', 'POST /service-keys']);
check('已签发后密钥明文可见', (await page.locator('.lg-quickstart-secret code').innerText()).startsWith('gwk_'), true);

const okBox = await page.locator('.lg-test-result.is-ok').boundingBox();
const panelBox = await page.locator('.lg-qs-products').boundingBox();
check('试跑结果块渲染出来了', Boolean(okBox), true);
// 「首屏可见」在 1440x900 下对两种排序都成立，单靠它红不了（形状 4：不会红的证据）。
// 真正的判据是它离产物栏顶端多远：排在地址与密钥之后就会被推下去 200px 以上。
check('试跑结果块紧贴产物栏顶部', Boolean(okBox && panelBox && okBox.y - panelBox.y < 120), true);
const firstBlockIsResult = await page.evaluate(() => {
  const card = document.querySelector('.lg-qs-products .lg-card, .lg-qs-products > div');
  if (!card) return 'no-card';
  const blocks = [...card.children].filter((el) => !el.classList.contains('lg-qs-products-heading'));
  return blocks[0]?.className || 'empty';
});
check('产物栏第一块就是结果块', /lg-test-result|lg-qs-failure/.test(firstBlockIsResult), true);
check('横向不滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
await page.close();

// ── 3) 失败：调用用途没绑模型池（最高频的一类）──────────────────────
gatewayMode = 'fail-pool';
page = await openQuickstart();
await page.getByRole('button', { name: '签出密钥并跑通一条请求' }).click();
await page.waitForTimeout(2200);
check('失败块渲染出来了', await page.locator('.lg-qs-failure').count(), 1);
check('失败码来自 error.code', (await page.locator('.lg-qs-failure-head code').innerText()).trim(), 'APPCALLER_POOL_UNBOUND');
check('三环着色：坏在模型池', await chainTones(page), ['密钥鉴权=ok', '团队与作用域=ok', '调用用途 → 模型池=bad']);
const failBox = await page.locator('.lg-qs-failure').boundingBox();
const failPanelBox = await page.locator('.lg-qs-products').boundingBox();
check('失败块紧贴产物栏顶部', Boolean(failBox && failPanelBox && failBox.y - failPanelBox.y < 120), true);
check('失败块首屏可见（不滚动）', Boolean(failBox && failBox.y >= 0 && failBox.y + failBox.height <= 900), true);

// 主行动必须真的去绑池，而不是只换文案。
posted.length = 0;
gatewayMode = 'pass';
await page.getByRole('button', { name: '给这个调用用途绑定模型池' }).click();
await page.waitForTimeout(2500);
check('主行动发出了绑池请求', posted.filter((item) => item.method === 'PUT' && item.api.startsWith('/app-callers/')).length, 1);
check('绑池请求带上了默认池与池策略', posted.find((item) => item.method === 'PUT')?.body, { status: 'configured', modelPoolId: 'pool-1', modelPolicy: 'pool' });
check('绑池后失败块消失', await page.locator('.lg-qs-failure').count(), 0);
await page.close();

// ── 4) 失败：作用域不匹配。没走到的环不许画成绿色 ────────────────────
gatewayMode = 'fail-scope';
page = await openQuickstart();
await page.getByRole('button', { name: '签出密钥并跑通一条请求' }).click();
await page.waitForTimeout(2200);
check('作用域失败的码', (await page.locator('.lg-qs-failure-head code').innerText()).trim(), 'GATEWAY_KEY_SCOPE_DENIED');
check('三环着色：坏在作用域，模型池判未知', await chainTones(page), ['密钥鉴权=ok', '团队与作用域=bad', '调用用途 → 模型池=unknown']);
await page.close();

// ── 5) 失败：密钥无效。第一环就坏，后两环都是未知 ──────────────────
gatewayMode = 'fail-key';
page = await openQuickstart('light');
await page.getByRole('button', { name: '签出密钥并跑通一条请求' }).click();
await page.waitForTimeout(2200);
check('密钥失败的码', (await page.locator('.lg-qs-failure-head code').innerText()).trim(), 'GATEWAY_KEY_INVALID');
check('三环着色：第一环就坏', await chainTones(page), ['密钥鉴权=bad', '团队与作用域=unknown', '调用用途 → 模型池=unknown']);
await page.close();

// ── 6) 窄屏：两栏退化为上下，不出现横向滚动 ─────────────────────────
gatewayMode = 'pass';
page = await openQuickstart('dark', 390);
check('390 宽度不出现横向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
check('390 宽度两栏堆成一列', await page.evaluate(() => {
  const columns = document.querySelector('.lg-qs-columns');
  return columns ? getComputedStyle(columns).gridTemplateColumns.split(' ').length : 0;
}), 1);
await page.close();

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} 条断言失败：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nQuickstart 五状态与失败归因验收全部通过。');
