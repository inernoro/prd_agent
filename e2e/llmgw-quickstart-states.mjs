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
// 这条守卫盯的是六件「改完看着都对、下一次改版最容易悄悄退化」的事：
//
//   0. **没说要做什么就不许颁发码。** 调用用途码只从「我想要做什么」那句话派生，
//      两段（谁在调用 / 要做什么）都落实了才颁发。改版前预填成 `{租户}.quickstart::chat`，
//      一个字不写也能签出密钥，签出来的码谁也说不出是干嘛的。断言取的是页面上
//      真的有没有那个码、主按钮真的能不能点，以及真实提交体里的 appCallerCode。
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
import { Buffer } from 'node:buffer';
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
/** 推导端点收到的请求体：断言送过去的就是用户写的那句话。 */
const drafted = [];
/** 推导桩的行为：model = 给出草案；unavailable = 模型没接通，前端应降级到本地关键词表。 */
let draftMode = 'model';
/** 真实调用发出的请求体：用来断言上传的内容真的进了 payload。 */
const realBodies = [];

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
      { modelId: 'demo/chat-degraded', platformId: 'p1', priority: 3, healthStatus: 1, healthStatusLabel: 'degraded', consecutiveFailures: 4, consecutiveSuccesses: 0, isMain: false, isIntent: false, isVision: false, isImageGen: false, capabilities: [] },
      { modelId: 'demo/chat-down', platformId: 'p1', priority: 4, healthStatus: 2, healthStatusLabel: 'unavailable', consecutiveFailures: 9, consecutiveSuccesses: 0, isMain: false, isIntent: false, isVision: false, isImageGen: false, capabilities: [] },
    ],
    boundAppCallerCount: 0, boundAppCallers: [], recentRequests: 0, recentSucceeded: 0, recentFailed: 0,
    trafficWindowHours: 168, recentTenRequests: 0, health: 'healthy', healthyMembers: 2, degradedMembers: 0,
    unavailableMembers: 0, managedByRegistry: false, appendOnly: false,
  }, {
    id: 'pool-2', name: '实验池', code: 'chat-lab', priority: 2, modelType: 'chat', isDefaultForType: false,
    strategyType: 0, sourceCollection: 'llmgw', authority: 'llmgw', models: [
      { modelId: 'lab/should-not-be-listed', platformId: 'p2', priority: 1, healthStatus: 0, healthStatusLabel: 'healthy', consecutiveFailures: 0, consecutiveSuccesses: 1, isMain: true, isIntent: false, isVision: false, isImageGen: false, capabilities: [] },
    ],
    boundAppCallerCount: 0, boundAppCallers: [], recentRequests: 0, recentSucceeded: 0, recentFailed: 0,
    trafficWindowHours: 168, recentTenRequests: 0, health: 'healthy', healthyMembers: 1, degradedMembers: 0,
    unavailableMembers: 0, managedByRegistry: false, appendOnly: false,
  }], total: 2 },
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
    // 没有 dry-run 头 = 真实调用：按 OpenAI 的 SSE 形状分帧回文字，验证前端真的边收边渲染。
    if (!req.headers['x-gateway-dry-run']) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        realBodies.push(raw ? JSON.parse(raw) : null);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Request-Id': REQUEST_ID });
        const frames = ['你好', '，这是', '流式', '输出'];
        let i = 0;
        const timer = setInterval(() => {
          if (i < frames.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: frames[i] } }] })}\n\n`);
            i += 1;
            return;
          }
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
        }, 120);
      });
      return undefined;
    }
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
    // 调用用途码草案：真实后端是 SSE，桩照同一套帧协议吐，前端解析路径才是被测的那条。
    if (api === '/app-callers/draft') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        drafted.push(raw ? JSON.parse(raw) : null);
        if (draftMode === 'unavailable') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ type: 'error', code: 'INTENT_DRAFT_UNAVAILABLE', message: '系统级用途码还没绑上可用的模型池。去「服务网关设置」选一个对话池或指定一个模型。已退回本地关键词判定。' })}\n\n`);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'stage', stage: 'thinking', text: '模型正在推导两段码' })}\n\n`);
        const frames = ['{"app":"xiaomi-', 'speaker","feature":"command-', 'intent","requestType":"chat",', '"reason":"从「小米音响」判出调用方，从「指令集」判出场景。"}'];
        let i = 0;
        const timer = setInterval(() => {
          if (i < frames.length) {
            res.write(`data: ${JSON.stringify({ type: 'delta', text: frames[i] })}\n\n`);
            i += 1;
            return;
          }
          clearInterval(timer);
          res.write(`data: ${JSON.stringify({
            type: 'result', ok: true, app: 'xiaomi-speaker', feature: 'command-intent', requestType: 'chat',
            reason: '从「小米音响」判出调用方，从「指令集」判出场景。',
            appCallerCode: 'xiaomi-speaker.command-intent::chat', model: 'demo/chat-1',
          })}\n\n`);
          res.end();
        }, 90);
      });
      return undefined;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const parsedBody = raw ? JSON.parse(raw) : null;
        posted.push({ method: req.method, api, body: parsedBody });
        if (api === '/app-callers') return json(res, 200, { success: true, error: null, data: { id: 'ac-new', appCallerCode: parsedBody?.appCallerCode ?? '', requestType: 'chat' } });
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
const askInput = (page) => page.getByLabel('我想做什么');
const issuedCode = (page) => page.locator('.lg-qs-issue code');

/**
 * 走完创建线：写那句话 → 等推导出码 → 下一步 → 到归属屏。
 * 每条场景在点「创建密钥」之前都得走这一遍，因为码只能从那句话来。
 */
async function walkToOwner(page, text = '接入小米音响，对接大模型网关指令集') {
  await askInput(page).fill(text);
  await page.getByRole('button', { name: '准备接入' }).click();
  await page.waitForSelector('.lg-qs-issue code', { timeout: 15000 });
  await page.getByRole('button', { name: '下一步' }).click();
  await page.waitForTimeout(400);
}

// ── 1) 创建屏：三个决定 + 一个主按钮，一件产物都不露 ───────────────────
gatewayMode = 'pass';
let page = await openQuickstart();
// 第一屏：整块画布只有一个输入框，没有码、没有团队、没有预算。
check('第一屏只有一个输入框', [
  await page.getByLabel('我想做什么').count(),
  await page.locator('.lg-qs-issue code').count(),
  await page.locator('.lg-qs-team-list, .lg-qs-own-row').count(),
], [1, 0, 0]);
check('太短的一句话不许提交', await page.getByRole('button', { name: '准备接入' }).isDisabled(), true);
check('页面上不存在 quickstart 占位码', (await page.locator('.lg-qs-flow').innerText()).includes('quickstart::'), false);
// 示例句点一下就填进去：省掉对着空白框发呆那几秒。
await page.locator('.lg-qs-ask-samples > button').first().click();
await page.waitForTimeout(200);
check('点示例句直接填进输入框', (await askInput(page).inputValue()).length > 0, true);
check('填了之后才可提交', await page.getByRole('button', { name: '准备接入' }).isDisabled(), false);

// 第二屏：交给模型推，边推边吐，推完把码亮出来。
// 这句话正是关键词表认不出来的那种说法——上一版在这里判「既没看出谁在调用，也没看出要做什么」。
drafted.length = 0;
await askInput(page).fill('接入小米音响，对接大模型网关指令集');
await page.getByRole('button', { name: '准备接入' }).click();
await page.waitForTimeout(180);
check('推导中把模型吐出来的原文显示出来', (await page.locator('.lg-qs-thinking pre').innerText()).length > 0, true);
await page.waitForSelector('.lg-qs-issue code', { timeout: 15000 });
check('送去推导的就是用户写的那句话', drafted[0]?.intent, '接入小米音响，对接大模型网关指令集');
check('采用模型推出来的码', (await issuedCode(page).innerText()).trim(), 'xiaomi-speaker.command-intent::chat');
check('标明这条码是模型推的', (await page.locator('.lg-qs-draft-source').innerText()).includes('模型推导'), true);
check('给出模型判定的依据', (await page.locator('.lg-qs-draft-reason').innerText()).includes('小米音响'), true);
// 模型给出结果时不该再摊开本地关键词清单——那是降级路径的出口，不是常驻控件。
check('模型给出结果时不摊开本地清单', await page.locator('.lg-qs-facets').count(), 0);
check('第二屏还没有团队与预算', await page.locator('.lg-qs-own-row').count(), 0);

// 模型没接通：必须退回本地关键词表，并且**明说这是降级**，不假装模型给过意见。
draftMode = 'unavailable';
await page.getByRole('button', { name: '重新生成' }).click();
await page.waitForTimeout(1200);
check('模型不可用时明说已降级', (await page.locator('.lg-test-result.is-error').innerText()).includes('退回本地关键词判定'), true);
// 裸状态码对用户没有意义（他会问「系统就是网关，还 401?」），失败必须指出去哪一页自救。
check('降级消息指出自救入口', (await page.locator('.lg-test-result.is-error').innerText()).includes('服务网关设置'), true);
check('降级后本地关键词表接住这句话', (await issuedCode(page).innerText()).trim(), 'smart-device.command-parse::chat');
check('降级时标明是本地判定', (await page.locator('.lg-qs-draft-source').innerText()).includes('降级'), true);
check('降级时摊开本地清单供手动改', await page.locator('.lg-qs-facets').count(), 1);
draftMode = 'model';
await page.getByRole('button', { name: '重新生成' }).click();
await page.waitForSelector('.lg-qs-draft-source', { timeout: 15000 });
await page.waitForTimeout(300);

// 第三屏：算谁的。只有团队与预算两件事。
await page.getByRole('button', { name: '下一步' }).click();
await page.waitForTimeout(400);
check('第三屏是归属与预算', [
  await page.locator('.lg-qs-own-row').count(),
  await page.getByLabel('我想做什么').count(),
], [1, 0]);
check('第三屏仍显示即将登记的码', (await issuedCode(page).innerText()).trim(), 'xiaomi-speaker.command-intent::chat');
check('归属团队默认选中当前用户所在团队', await page.locator('.lg-qs-team-list button.is-active').innerText(), '核心平台组');
check('创建屏不出现任何个人归属控件', await page.locator('.lg-qs-owner-line, .lg-qs-owner-list').count(), 0);
check('创建屏不出现一次性密钥', await page.locator('.lg-qs-key-hero').count(), 0);
check('创建屏不出现产物细条', await page.locator('.lg-qs-ribbon').count(), 0);
// 主行动钉在卡片右下角（向导式的「下一步」位置）：通栏按钮或左对齐都会让这条红。
check('主行动贴着创建卡右边缘', await page.evaluate(() => {
  const btn = document.querySelector('.lg-qs-primary');
  const card = document.querySelector('.lg-qs-step-card');
  if (!btn || !card) return 'missing';
  const b = btn.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  if (b.width > c.width * 0.5) return 'full-width';
  return Math.abs((c.right - b.right)) <= 40 ? 'right' : 'not-right';
}), 'right');

// 月预算派生：极小额度时预占上限必须夹回月预算，否则后端拒收（预占 > 月预算）。
await page.getByLabel('月预算（美元）').fill('0.3');
await page.waitForTimeout(200);
const budgetNote = () => page.locator('.lg-qs-own-col', { hasText: '月预算' }).locator('.lg-qs-note');
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
check('产物屏不再有创建向导', await page.locator('.lg-qs-step-card, .lg-qs-ask').count(), 0);
check('产物屏是三个页签', await page.$$eval('.lg-qs-result-tabs > button', (nodes) => nodes.map((n) => n.textContent.trim())), ['接入信息', 'cURL', '提示词']);
check('默认停在接入信息页', await page.locator('.lg-qs-access-grid').count(), 1);
check('产物屏出现签发细条', await page.locator('.lg-qs-ribbon').count(), 1);
check('密钥明文可见', (await page.locator('.lg-qs-key-value').innerText()).startsWith('gwk_'), true);
// 页签互斥：接入信息页上不该出现请求片段，反之亦然——「一页只讲一件事」就是这条断言。
// 密钥已经提到页签之上，接入信息页只剩地址与用途两张卡。
check('接入信息页两张卡、没有片段', [
  await page.locator('.lg-qs-hero').count(),
  await page.locator('.lg-qs-code').count(),
], [2, 0]);
/*
  密钥常驻在页签之上——这是产物屏最重要的一条结构约束，也是最容易被改回去的一条：
  它是全屏唯一取不回来的东西，一旦被塞回某个页签，切一下页签它就消失了。
  判据不是「密钥存在」（那在接入信息页上恒真），而是**它排在页签容器之上**。
*/
check('密钥主区排在页签之上', await page.evaluate(() => {
  const key = document.querySelector('.lg-qs-key-hero');
  const tabs = document.querySelector('.lg-qs-result-tabs');
  if (!key || !tabs) return 'missing';
  return key.getBoundingClientRect().bottom <= tabs.getBoundingClientRect().top + 1;
}), true);
check('产物屏露出本次登记的调用用途码', (await page.locator('.lg-qs-hero.is-caller code').innerText()).trim(), 'xiaomi-speaker.command-intent::chat');
check('提交给控制台的就是模型推出来的码', posted.find((item) => item.api === '/app-callers')?.body?.appCallerCode, 'xiaomi-speaker.command-intent::chat');
check('调用用途卡标出归属团队', (await page.locator('.lg-qs-hero.is-caller small').innerText()).includes('归属团队 核心平台组'), true);
// 切到 cURL 页：测试栏与片段在这一页，接入信息卡让位。
await page.locator('.lg-qs-result-tabs > button', { hasText: 'cURL' }).click();
await page.waitForTimeout(300);
check('cURL 页有片段与测试栏、没有接入信息卡', [
  await page.locator('.lg-qs-code').count(),
  await page.locator('.lg-qs-testbar').count(),
  await page.locator('.lg-qs-hero').count(),
], [1, 1, 0]);
// 切走之后密钥必须还在：把它塞回任何一个页签，这条立刻红。
check('切到 cURL 页后密钥仍在', [
  await page.locator('.lg-qs-key-hero').count(),
  (await page.locator('.lg-qs-key-value').innerText()).startsWith('gwk_'),
], [1, true]);
// 候选只能来自这条 appCaller 真正走的那个池：另一个同类型池的成员不许混进来，
// 否则真实租户上会平铺出 200+ 个模型，且违反「可选模型必须来自获准的池」。
check('模型候选只来自被路由到的池、且只列健康成员', await page.$$eval('#lg-qs-model-options option', (nodes) => nodes.map((n) => n.value)), ['demo/chat-1', 'demo/chat-2']);
/*
  产物屏「一屏装下」的口径，2026-08-28 随试跑区改版收窄了一档，写清为什么：
  cURL 页多出了「上输入 / 下输出」这一对（各 88px），1440x900 下再要求整页零滚动，
  就只能把这一对压扁或把片段压成两行——两者都会毁掉用户要的对照效果。
  所以拆成两条判据：**接入信息页仍必须零滚动**（它是打开产物屏的第一眼），
  cURL 页改判**首屏必须装得下这一对与两个按钮**，片段可以落到折线以下。
  这不是放宽成「随便多高都行」：一旦这一对被挤出首屏，下面这条就会红。
*/
check('接入信息页 1440x900 零滚动', await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.lg-qs-result-tabs > button')];
  tabs.find((node) => node.textContent.includes('接入信息'))?.click();
  return true;
}), true);
await page.waitForTimeout(300);
check('接入信息页不出现纵向滚动', await page.evaluate(() => {
  const body = document.querySelector('.lg-page-body');
  if (!body) return 'missing';
  return body.scrollHeight <= body.clientHeight + 1 ? 'fits' : `overflow:${body.scrollHeight - body.clientHeight}`;
}), 'fits');
await page.locator('.lg-qs-result-tabs > button', { hasText: 'cURL' }).click();
await page.waitForTimeout(300);
/*
  片段是自然高度，所以卡片不能再被 flex 压缩：`.lg-qs-artifacts` 是 flex 列，
  卡片默认会被压成比内容矮的盒子，而它 overflow 是 visible——片段就直接画到
  下面那块「再测一次 / 排障」上。这条判的是「盒子装得下自己的内容」，
  比对着截图看更硬：一旦有人把 flex: none 拿掉，它立刻红。
*/
check('cURL 卡片装得下片段，不会盖住下面的排障块', await page.evaluate(() => {
  const card = document.querySelector('.lg-qs-curl-card');
  if (!card) return 'missing';
  return card.scrollHeight <= card.clientHeight + 2 ? 'no-spill' : `spill:${card.scrollHeight - card.clientHeight}`;
}), 'no-spill');
check('cURL 页：输入、输出与两个按钮都在首屏内', await page.evaluate(() => {
  const output = document.querySelector('.lg-qs-output');
  const buttons = document.querySelector('.lg-qs-io-buttons');
  if (!output || !buttons) return 'missing';
  const bottom = Math.max(output.getBoundingClientRect().bottom, buttons.getBoundingClientRect().bottom);
  return bottom <= window.innerHeight ? 'above-fold' : `below-fold:${Math.round(bottom - window.innerHeight)}`;
}), 'above-fold');
const okBox = await page.locator('.lg-test-result.is-ok').boundingBox();
const artifactsBox = await page.locator('.lg-qs-artifacts').boundingBox();
check('试跑结果块渲染出来了', Boolean(okBox), true);
// 「首屏可见」在 1440x900 下对多种排序都成立，单靠它红不了（形状 4：不会红的证据）。
// 真正的判据是它离产物区顶端多远：排到密钥与片段之后就会被推下去 200px 以上。
check('试跑结果块紧贴产物区顶部', Boolean(okBox && artifactsBox && okBox.y - artifactsBox.y < 120), true);
check('成功态留下 requestId 回查深链', await page.locator(`.lg-test-result.is-ok a[href*="requestId=${REQUEST_ID}"]`).count(), 1);
// 候选提示与计费提示已合成一句（改版后它们同属「按下去会发生什么」），所以断言的是它包含健康数与总数。
check('候选提示写明健康数与总数', (await page.locator('.lg-qs-testbar-models').innerText()).includes('「对话默认池」4 个成员中 2 个健康，可搜索。'), true);
check('同一句里说清两个按钮的计费差别', (await page.locator('.lg-qs-testbar-models').innerText()).includes('安全试跑不打上游、不计费；真实调用会计入用量与费用。'), true);
// 填一个不在健康清单里的模型：执行必须被挡住，否则那一次试跑注定白跑。
await page.getByLabel('测试模型').fill('demo/chat-down');
await page.waitForTimeout(300);
check('选了非健康成员时两个执行按钮都禁用', [
  await page.getByRole('button', { name: '安全试跑' }).isDisabled(),
  await page.getByRole('button', { name: '真实调用' }).isDisabled(),
], [true, true]);
await page.getByLabel('测试模型').fill('demo/chat-2');
await page.waitForTimeout(300);
check('选了健康成员后可执行', await page.getByRole('button', { name: '安全试跑' }).isDisabled(), false);
check('cURL 跟着所选模型变', (await page.locator('.lg-qs-code').innerText()).includes('"model": "demo/chat-2"'), true);
await page.getByLabel('测试模型').fill('');
await page.waitForTimeout(300);
check('清空即回到 auto', (await page.locator('.lg-qs-code').innerText()).includes('"model": "auto"'), true);

// 提示词页：三种取用方式，系统提示词里必须带上这条码，且**不带密钥明文**。
await page.locator('.lg-qs-result-tabs > button', { hasText: '提示词' }).click();
await page.waitForTimeout(300);
check('提示词页三种取用方式', await page.$$eval('.lg-qs-snippet-card .lg-qs-type-row > button', (nodes) => nodes.map((n) => n.textContent.trim())), ['系统提示词', 'Agent Skill', '客户端配置']);
const promptText = await page.locator('.lg-qs-code').innerText();
check('系统提示词带上本次的调用用途码', promptText.includes('xiaomi-speaker.command-intent::chat'), true);
// 密钥明文绝不能进提示词——用户会把提示词贴到别处，贴出去就是泄漏。
check('系统提示词不含密钥明文', promptText.includes('gwk_7f2c9a1e4b8d3f6021ca77e5db34QpZm1x9LkNvR2sT'), false);
check('系统提示词用环境变量占位', promptText.includes('$LLMGW_API_KEY'), true);
await page.locator('.lg-qs-snippet-card .lg-qs-type-row > button', { hasText: '客户端配置' }).click();
await page.waitForTimeout(300);
check('客户端配置这一档才出现接入方式选择', await page.locator('.lg-qs-preset-list').count(), 1);
await page.locator('.lg-qs-result-tabs > button', { hasText: 'cURL' }).click();
await page.waitForTimeout(300);

check('横向不滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);

/*
  ── 上输入下输出：这一对的「对照」不是版式偏好，是三条可判的约束 ──────
  用户 2026-08-28 要的是「上面输入下面输出，有个对照效果」。三件事成立它才成立：
  ① 输入是能直接写的框（不是只能上传文件）；② 空态也占住高度，跑起来页面不往下跳；
  ③ 两块同宽——不同宽就不是一对。任一条退化，页面看着还「有那些元素」，
  但对照关系就没了，所以逐条断言真实几何，不断言 class 存在。
*/
check('输入是能直接写的框', await page.locator('textarea.lg-qs-io-input').count(), 1);
const emptyOutBox = await page.locator('.lg-qs-output').boundingBox();
check('还没跑时输出块也占住 88px（页面不会往下跳）', Boolean(emptyOutBox && emptyOutBox.height >= 88), true);
const inputBox = await page.locator('.lg-qs-io-input').boundingBox();
check('输入与输出同宽', Boolean(inputBox && emptyOutBox && Math.abs(inputBox.width - emptyOutBox.width) <= 1), true);
check('输出块排在输入框下方', Boolean(inputBox && emptyOutBox && emptyOutBox.y > inputBox.y), true);

// 用户写进框里的那句，必须同时进 cURL 片段与真实请求体——两边是同一次请求。
await page.locator('.lg-qs-io-input').fill('用三句话说明什么是模型网关');
await page.waitForTimeout(300);
check('输入内容进了 cURL 片段', (await page.locator('.lg-qs-code').innerText()).includes('用三句话说明什么是模型网关'), true);

// ── 真实调用：文字必须边收边渲染，且返回内容要显示出来 ────────────────
realBodies.length = 0;
await page.getByRole('button', { name: '真实调用' }).click();
await page.waitForTimeout(260);
// 第一帧到了、最后一帧还没到的那个瞬间：面板里已经有字，且还挂着「正在接收」。
const midway = await page.locator('.lg-qs-output pre').innerText();
check('流式：第一帧就已经渲染出来', midway.length > 0 && midway.length < '你好，这是流式输出'.length, true);
check('流式：未收完时头部在跳「已用 X.Xs」', /^已用 \d+\.\ds$/.test((await page.locator('.lg-qs-io-meta').last().innerText()).trim()), true);
check('流式：未收完时三点在动', await page.locator('.lg-qs-io-dots').count(), 1);
check('流式：未收完时输出块左侧竖线是 accent', await page.locator('.lg-qs-output.is-streaming').count(), 1);
await page.waitForTimeout(1200);
check('流式：收完后是完整文本', (await page.locator('.lg-qs-output pre').innerText()).trim(), '你好，这是流式输出');
check('流式：收完后三点撤掉', await page.locator('.lg-qs-io-dots').count(), 0);
check('流式：收完后输出块左侧竖线转成完成色', await page.locator('.lg-qs-output.is-done').count(), 1);
check('返回内容标出类型', (await page.locator('.lg-qs-io-chip').innerText()).trim(), '文字');
check('输出头写明耗时与实际执行的模型', /\d+\.\ds · 实际执行 /.test(await page.locator('.lg-qs-io-meta').last().innerText()), true);
check('输出头留下 requestId 回查深链', await page.locator(`.lg-qs-io-link[href*="requestId=${REQUEST_ID}"]`).count(), 1);
check('跑完之后主按钮变成再跑一次', await page.getByRole('button', { name: '再跑一次' }).count(), 1);
check('框里写的那句进了真实请求体', realBodies[0]?.messages?.[0]?.content, '用三句话说明什么是模型网关');
check('真实调用请求体带 stream:true', realBodies[0]?.stream, true);
check('真实调用不带 dry-run 头（桩已按此分流）', realBodies.length, 1);

// ── 上传：上传的文本要填进那个输入框（用户看得见、能改），再进请求体与 cURL ──
await page.getByLabel('上传测试输入').setInputFiles({ name: 'prompt.txt', mimeType: 'text/plain', buffer: Buffer.from('用三个字回答：你好吗') });
await page.waitForTimeout(400);
check('上传的文本填进了输入框', (await page.locator('.lg-qs-io-input').inputValue()).trim(), '用三个字回答：你好吗');
check('cURL 用上了上传的文本', (await page.locator('.lg-qs-code').innerText()).includes('用三个字回答：你好吗'), true);
realBodies.length = 0;
await page.getByRole('button', { name: '再跑一次' }).click();
await page.waitForTimeout(1400);
check('上传的文本进了真实请求体', realBodies[0]?.messages?.[0]?.content, '用三个字回答：你好吗');

await page.close();

/*
  ── 按调用类型区分输入：看图这一类必须把「图」摆到明面上 ────────────────
  文字对话那条路上不该出现图片格；切成图片理解之后，图必须是独立一格
  （不是藏在「或上传文本」后面的一个可选动作），且空态要如实说明「没给图就发 1x1 测试图」——
  静默塞一张测试图会让人以为识图能力已经验过了。
*/
gatewayMode = 'pass';
page = await openQuickstart();
check('文字对话不出现图片格', await page.locator('.lg-qs-io-image').count(), 0);
// 调用类型在第 2 步（颁码那一屏），必须在点「下一步」之前改
await askInput(page).fill('接入小米音响，让它看图识物');
await page.getByRole('button', { name: '准备接入' }).click();
await page.waitForSelector('.lg-qs-issue code', { timeout: 15000 });
await page.locator('.lg-qs-type-row > button', { hasText: '图片理解' }).first().click();
await page.waitForTimeout(500);
await page.getByRole('button', { name: '下一步' }).click();
await page.waitForTimeout(400);
await create(page).click();
await page.waitForTimeout(2400);
await page.locator('.lg-qs-result-tabs > button', { hasText: 'cURL' }).click();
await page.waitForTimeout(400);
check('图片理解把图提成独立一格', await page.locator('.lg-qs-io-image').count(), 1);
check('图片格空态说清用的是测试图', (await page.locator('.lg-qs-io-image').innerText()).includes('1x1 测试图'), true);
check('图片格排在问题框上方', await page.evaluate(() => {
  const img = document.querySelector('.lg-qs-io-image');
  const input = document.querySelector('.lg-qs-io-input');
  if (!img || !input) return 'missing';
  return img.getBoundingClientRect().top < input.getBoundingClientRect().top ? 'above' : 'below';
}), 'above');
check('图片格与问题框同宽', await page.evaluate(() => {
  const img = document.querySelector('.lg-qs-io-image').getBoundingClientRect();
  const input = document.querySelector('.lg-qs-io-input').getBoundingClientRect();
  return Math.abs(img.width - input.width) <= 1;
}), true);
await page.close();

// ── 4) 月预算留空 = 不限：连治理写入本身都不该发生 ─────────────────────
gatewayMode = 'pass';
page = await openQuickstart();
posted.length = 0;
await walkToOwner(page);
await create(page).click();
await page.waitForTimeout(2400);
check('留空月预算时不发治理写入', posted.map((item) => `${item.method} ${item.api}`), ['POST /app-callers', 'POST /service-keys']);
await page.close();

// ── 5) 失败：调用用途没绑模型池（最高频的一类）──────────────────────
gatewayMode = 'fail-pool';
page = await openQuickstart();
await walkToOwner(page);
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
await walkToOwner(page);
await create(page).click();
await page.waitForTimeout(2400);
check('作用域失败的码', (await page.locator('.lg-qs-failure-head code').innerText()).trim(), 'GATEWAY_KEY_SCOPE_DENIED');
check('三环着色：坏在作用域，模型池判未知', await chainTones(page), ['密钥鉴权=ok', '团队与作用域=bad', '调用用途 → 模型池=unknown']);
await page.close();

// ── 7) 失败：密钥无效。第一环就坏，后两环都是未知 ──────────────────
gatewayMode = 'fail-key';
page = await openQuickstart('light');
await walkToOwner(page);
await create(page).click();
await page.waitForTimeout(2400);
check('密钥失败的码', (await page.locator('.lg-qs-failure-head code').innerText()).trim(), 'GATEWAY_KEY_INVALID');
check('三环着色：第一环就坏', await chainTones(page), ['密钥鉴权=bad', '团队与作用域=unknown', '调用用途 → 模型池=unknown']);
await page.close();

// ── 8) 窄屏：页面不横向滚动，但密钥串自己能滚（不能被裁掉）─────────────
gatewayMode = 'pass';
page = await openQuickstart('dark', 390);
await walkToOwner(page);
check('390 创建屏不出现横向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
await create(page).click();
await page.waitForTimeout(2400);
check('390 产物屏不出现横向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
// 真实密钥是 47 个字符，窄屏一行放不下。它取不回来第二次，所以宁可换行也不能被裁：
// 判据是「整串都在可视范围内」——横向溢出即判红，不管有没有滚动条。
check('390 密钥完整可见、没有被裁', await page.evaluate(() => {
  const code = document.querySelector('.lg-qs-key-value');
  if (!code) return 'missing';
  return code.scrollWidth <= code.clientWidth + 1 ? 'fully-visible' : `clipped:${code.scrollWidth - code.clientWidth}`;
}), 'fully-visible');
await page.close();

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} 条断言失败：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nQuickstart 两屏改版与失败归因验收全部通过。');
