// Quickstart 两屏改版验收：创建屏三个决定、产物屏只剩复制、预算成对提交、失败归因三环。
//
// 用法：
//   cd llmgw/web && pnpm build          # 先产出 dist
//   cd e2e && pnpm install && node llmgw-quickstart-states.mjs
//
// 可选环境变量：
//   LLMGW_DIST                构建产物目录（默认 <repo>/llmgw/web/dist）
//   PLAYWRIGHT_CHROMIUM_PATH  指定 chromium 可执行文件
//
// 这条守卫盯的是五件「改完看着都对、下一次改版最容易悄悄退化」的事：
//
//   1. **创建屏与产物屏互斥。** 改版前左右两栏常驻，任何状态变化两栏一起重排，
//      用户找不到重点。断言取的是两屏各自元素的真实数量：签发前产物为 0，
//      签发后表单控件为 0，而不是「有没有渲染出某个 class」。
//   2. **预算必须成对提交。** 月预算与单次预占上限是一对：只提交月预算，
//      console-api 会 400；库里真落进单边配置，serving 启动自检会拒绝启动。
//      断言看的是浏览器真实发出的 PUT body，不是页面上的提示文案。
//      月预算留空时**两个都不许出现**——这正是「留空即不限」最容易写错的地方。
//   3. **密钥归团队，不归个人。** 提交体里必须有 teamId、必须**没有** owner——
//      「负责人」这个概念已经从本页移除，谁点的创建由服务端记进审计。
//      断言看的是真实提交体，不是页面上有没有那个控件。
//   4. **成功也要留下 requestId。** 失败态有归因链接，成功态如果只显示密钥，
//      这次试跑就没有任何可回查的凭据（断头验收）。断言成功条里有 requestId 深链。
//   5. **失败归因走 error.code，不走文案。** 三环着色随码变化：坏在第 N 环，
//      之前判通过、之后判未知——没走到的环不许画成绿色。
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
  '/pools': { items: [{
    id: 'pool-1', name: '对话默认池', code: 'chat-default', priority: 1, modelType: 'chat', isDefaultForType: true,
    strategyType: 0, sourceCollection: 'llmgw', authority: 'llmgw', models: [
      { modelId: 'demo/chat-1', platformId: 'p1', priority: 1, healthStatus: 0, healthStatusLabel: 'healthy', consecutiveFailures: 0, consecutiveSuccesses: 3, isMain: true, isIntent: false, isVision: false, isImageGen: false, capabilities: [] },
      { modelId: 'demo/chat-2', platformId: 'p1', priority: 2, healthStatus: 0, healthStatusLabel: 'healthy', consecutiveFailures: 0, consecutiveSuccesses: 1, isMain: false, isIntent: false, isVision: false, isImageGen: false, capabilities: [] },
    ],
    boundAppCallerCount: 0, boundAppCallers: [], recentRequests: 0, recentSucceeded: 0, recentFailed: 0,
    trafficWindowHours: 168, recentTenRequests: 0, health: 'healthy', healthyMembers: 2, degradedMembers: 0,
    unavailableMembers: 0, managedByRegistry: false, appendOnly: false,
  }], total: 1 },
  '/pool-types': { items: [{ code: 'chat', name: '对话默认池', purpose: '常规对话', sortOrder: 1, defaultPoolId: 'pool-1', modelCount: 2, ready: true, version: 1 }], total: 1, ready: 1, waiting: 0 },
  '/organization': {
    tenant: { id: 't1', name: 'Miduo 平台', slug: 'miduo', status: 'active', isInternal: false },
    teams: [{ id: 'team-1', name: '核心平台组', status: 'active', createdAt: nowIso, updatedAt: nowIso }],
    // 第一个成员就是登录用的那个账号：默认负责人必须落到他身上，而不是列表第一行。
    members: [
      { id: 'm2', userId: 'u2', username: 'lin', displayName: '林可', role: 'admin', teamIds: ['team-1'], status: 'active', version: 1 },
      { id: 'm1', userId: 'u1', username: 'zhou', displayName: '周越', role: 'owner', teamIds: ['team-1'], status: 'active', version: 1 },
    ],
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
        token: 'stub', username: 'zhou', displayName: '周越', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        mustChangePassword: false, tenant: { id: 't1', name: 'Miduo 平台', isInternal: false, role: 'owner', teamIds: ['team-1'] },
      } });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        posted.push({ method: req.method, api, body: raw ? JSON.parse(raw) : null });
        if (api === '/app-callers') return json(res, 200, { success: true, error: null, data: { id: 'ac-new', appCallerCode: 'miduo-agent.quickstart::chat', requestType: 'chat' } });
        if (api === '/service-keys') return json(res, 200, { success: true, error: null, data: { id: 'k-new', key: 'gwk_7f2c9a1e4b8d3f6021ca77e5db34QpZm1x9LkNvR2sT', keyPrefix: 'gwk_7f2c', name: 'miduo-agent-quickstart' } });
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

const create = (page) => page.getByRole('button', { name: '创建密钥' });
/** 用途现在是必选项：每条场景在点创建之前都得先选一个，否则按钮是禁用的。 */
async function pickPurpose(page, label = '桌面客户端') {
  await page.getByRole('radiogroup', { name: '用途' }).getByRole('radio', { name: label }).click();
  await page.waitForTimeout(250);
}

// ── 1) 创建屏：三个决定 + 一个主按钮，一件产物都不露 ───────────────────
gatewayMode = 'pass';
let page = await openQuickstart();
check('创建屏只有一个主按钮', await page.locator('.lg-qs-primary').count(), 1);
// 用途是唯一「系统无从得知」的必填项：不填就不许创建。
check('未填用途时主按钮禁用', await page.locator('.lg-qs-primary').isDisabled(), true);
posted.length = 0;
await page.locator('.lg-qs-primary').click({ force: true }).catch(() => {});
await page.waitForTimeout(800);
check('未填用途时点不出任何写请求', posted.length, 0);
await page.getByRole('radiogroup', { name: '用途' }).getByRole('radio', { name: '桌面客户端' }).click();
await page.waitForTimeout(300);
check('填了用途后主按钮可用', await page.locator('.lg-qs-primary').isDisabled(), false);
check('调用用途码按用途派生', (await page.locator('.lg-qs-decision .lg-qs-note').first().innerText()).includes('miduo-agent.desktop::chat'), true);
check('创建屏只有四个决定', await page.locator('.lg-qs-decision').count(), 4);
check('创建屏不出现一次性密钥', await page.locator('.lg-qs-secret-code').count(), 0);
check('创建屏不出现产物细条', await page.locator('.lg-qs-ribbon').count(), 0);
// 主行动钉在卡片右下角（向导式的「下一步」位置）：通栏按钮或左对齐都会让这条红。
check('主行动贴着创建卡右边缘', await page.evaluate(() => {
  const btn = document.querySelector('.lg-qs-primary');
  const card = document.querySelector('.lg-qs-create-card');
  if (!btn || !card) return 'missing';
  const b = btn.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  if (b.width > c.width * 0.5) return 'full-width';
  return Math.abs((c.right - b.right)) <= 40 ? 'right' : 'not-right';
}), 'right');
check('归属团队默认选中当前用户所在团队', await page.locator('.lg-qs-team-list button.is-active').innerText(), '核心平台组');
check('创建屏不出现任何个人归属控件', await page.locator('.lg-qs-owner-line, .lg-qs-owner-list').count(), 0);

// 月预算派生：极小额度时预占上限必须夹回月预算，否则后端拒收（预占 > 月预算）。
await page.getByLabel('月预算（美元）').fill('0.3');
await page.waitForTimeout(200);
const budgetNote = () => page.locator('.lg-qs-decision', { hasText: '月预算' }).locator('.lg-qs-note');
check('极小月预算时预占上限夹回月预算', (await budgetNote().innerText()).includes('0.3 USD'), true);
await page.getByLabel('月预算（美元）').fill('200');
await page.waitForTimeout(200);
check('常规月预算按 1% 派生预占上限', (await budgetNote().innerText()).includes('2 USD'), true);

// ── 2) 签发：登记用途 → 写治理（负责人 + 成对预算）→ 签密钥 ─────────────
posted.length = 0;
await create(page).click();
await page.waitForTimeout(2400);
check('三个写请求与顺序', posted.map((item) => `${item.method} ${item.api}`), ['POST /app-callers', 'PUT /app-callers/ac-new', 'POST /service-keys']);
check('治理只写成对预算，不写个人归属', posted.find((item) => item.method === 'PUT')?.body, { monthlyBudgetUsd: 200, budgetReservationUsd: 2 });
check('密钥归属团队', posted.find((item) => item.api === '/service-keys')?.body?.teamId, 'team-1');
check('调用用途也登记在同一个团队下', posted.find((item) => item.api === '/app-callers')?.body?.teamId, 'team-1');
check('提交体里不存在 owner 字段', posted.some((item) => item.body && 'owner' in item.body), false);

// ── 3) 产物屏：表单让位，密钥 + 地址 + 单个复制区，成功也留 requestId ────
check('产物屏不再有表单决定块', await page.locator('.lg-qs-decision').count(), 0);
check('产物屏出现签发细条', await page.locator('.lg-qs-ribbon').count(), 1);
check('密钥明文可见', (await page.locator('.lg-qs-secret-code').innerText()).startsWith('gwk_'), true);
check('同一时刻只渲染一份片段', await page.locator('.lg-qs-artifacts pre').count(), 1);
check('左侧三张卡（地址 + 密钥 + 调用用途）+ 右侧片段', [
  await page.locator('.lg-qs-hero').count(),
  await page.locator('.lg-qs-code').count(),
], [3, 1]);
check('产物屏露出本次登记的调用用途码', (await page.locator('.lg-qs-hero.is-caller code').innerText()).trim(), 'miduo-agent.desktop::chat');
check('一键测试条列出池内成员', await page.locator('.lg-qs-testbar select option').allInnerTexts(), ['auto（由模型池调度）', 'demo/chat-1', 'demo/chat-2']);
// 产物屏必须一屏装下：内容区不许出现纵向滚动（片段太长时在它自己的框里滚）。
check('产物屏 1440x900 不出现纵向滚动', await page.evaluate(() => {
  const body = document.querySelector('.lg-page-body');
  if (!body) return 'missing';
  return body.scrollHeight <= body.clientHeight + 1 ? 'fits' : `overflow:${body.scrollHeight - body.clientHeight}`;
}), 'fits');
const okBox = await page.locator('.lg-test-result.is-ok').boundingBox();
const artifactsBox = await page.locator('.lg-qs-artifacts').boundingBox();
check('试跑结果块渲染出来了', Boolean(okBox), true);
// 「首屏可见」在 1440x900 下对多种排序都成立，单靠它红不了（形状 4：不会红的证据）。
// 真正的判据是它离产物区顶端多远：排到密钥与片段之后就会被推下去 200px 以上。
check('试跑结果块紧贴产物区顶部', Boolean(okBox && artifactsBox && okBox.y - artifactsBox.y < 120), true);
check('成功态留下 requestId 回查深链', await page.locator(`.lg-test-result.is-ok a[href*="requestId=${REQUEST_ID}"]`).count(), 1);
check('横向不滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
await page.close();

// ── 4) 月预算留空 = 不限：连治理写入本身都不该发生 ─────────────────────
gatewayMode = 'pass';
page = await openQuickstart();
posted.length = 0;
await pickPurpose(page);
await create(page).click();
await page.waitForTimeout(2400);
check('留空月预算时不发治理写入', posted.map((item) => `${item.method} ${item.api}`), ['POST /app-callers', 'POST /service-keys']);
await page.close();

// ── 5) 失败：调用用途没绑模型池（最高频的一类）──────────────────────
gatewayMode = 'fail-pool';
page = await openQuickstart();
await pickPurpose(page);
await create(page).click();
await page.waitForTimeout(2400);
check('失败块渲染出来了', await page.locator('.lg-qs-failure').count(), 1);
check('失败码来自 error.code', (await page.locator('.lg-qs-failure-head code').innerText()).trim(), 'APPCALLER_POOL_UNBOUND');
check('三环着色：坏在模型池', await chainTones(page), ['密钥鉴权=ok', '团队与作用域=ok', '调用用途 → 模型池=bad']);
const failBox = await page.locator('.lg-qs-failure').boundingBox();
const failArtifactsBox = await page.locator('.lg-qs-artifacts').boundingBox();
check('失败块紧贴产物区顶部', Boolean(failBox && failArtifactsBox && failBox.y - failArtifactsBox.y < 120), true);
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

// ── 6) 失败：作用域不匹配。没走到的环不许画成绿色 ────────────────────
gatewayMode = 'fail-scope';
page = await openQuickstart();
await pickPurpose(page);
await create(page).click();
await page.waitForTimeout(2400);
check('作用域失败的码', (await page.locator('.lg-qs-failure-head code').innerText()).trim(), 'GATEWAY_KEY_SCOPE_DENIED');
check('三环着色：坏在作用域，模型池判未知', await chainTones(page), ['密钥鉴权=ok', '团队与作用域=bad', '调用用途 → 模型池=unknown']);
await page.close();

// ── 7) 失败：密钥无效。第一环就坏，后两环都是未知 ──────────────────
gatewayMode = 'fail-key';
page = await openQuickstart('light');
await pickPurpose(page);
await create(page).click();
await page.waitForTimeout(2400);
check('密钥失败的码', (await page.locator('.lg-qs-failure-head code').innerText()).trim(), 'GATEWAY_KEY_INVALID');
check('三环着色：第一环就坏', await chainTones(page), ['密钥鉴权=bad', '团队与作用域=unknown', '调用用途 → 模型池=unknown']);
await page.close();

// ── 8) 窄屏：页面不横向滚动，但密钥串自己能滚（不能被裁掉）─────────────
gatewayMode = 'pass';
page = await openQuickstart('dark', 390);
await pickPurpose(page);
check('390 创建屏不出现横向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
await create(page).click();
await page.waitForTimeout(2400);
check('390 产物屏不出现横向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
// 真实密钥是 47 个字符，在 390 宽下一定放不下：要么给它自己的横向滚动条，
// 要么就是被裁掉——被裁掉意味着用户永远复制不到完整密钥，而它取不回来第二次。
check('390 密钥串自己可横向滚动', await page.evaluate(() => {
  const code = document.querySelector('.lg-qs-secret-code');
  if (!code) return 'missing';
  if (code.scrollWidth <= code.clientWidth) return 'not-overflowing';
  return getComputedStyle(code).overflowX;
}), 'auto');
await page.close();

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} 条断言失败：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nQuickstart 两屏改版与失败归因验收全部通过。');
