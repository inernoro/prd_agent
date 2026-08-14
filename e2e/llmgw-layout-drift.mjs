// 排版漂移检测（llmgw 控制台）——「举一反三」的工具化落地。
//
// 用法：
//   cd llmgw/web && pnpm build          # 先产出 dist
//   cd e2e && pnpm install && node llmgw-layout-drift.mjs
//
// 可选环境变量：
//   LLMGW_DIST                构建产物目录（默认 <repo>/llmgw/web/dist）
//   PLAYWRIGHT_CHROMIUM_PATH  指定 chromium 可执行文件；不设则由 Playwright 自行解析
//
// 它以「请求记录」页为基准，逐维度量其余页面偏了多少。
// 不只看字号——把「为什么看起来不精致」拆成可测量的维度：
//   页头是否裸露在页面上（而不是塞进一个带框卡片）
//   主内容是否撑满视口（下方有没有大片空白）
//   表格/控件的字号、行高、控件高度
//   一屏里出现几种不同的卡片内边距（节奏是否统一）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// 路径一律从当前 checkout 推出来，不写死作者机器上的绝对路径。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.LLMGW_DIST || path.join(REPO_ROOT, 'llmgw/web/dist');
// 浏览器优先交给 Playwright 自己解析；只有显式指定 PLAYWRIGHT_CHROMIUM_PATH 时才覆盖。
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const PORT = 5620;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const nowIso = new Date().toISOString();

const row = (over) => ({ id: 'x', createdAt: nowIso, updatedAt: nowIso, enabled: true, authority: 'llm_gateway', ...over });
const PLATFORMS = [
  row({ id: 'p1', name: '教程假上游', apiUrl: 'https://provider.example.com/v1', protocol: 'openai', hasKey: true, maxConcurrency: 20, modelCount: 3 }),
  row({ id: 'p2', name: '生产主力供应方', apiUrl: 'https://api.openai.com/v1', protocol: 'openai', hasKey: true, maxConcurrency: 64, modelCount: 12 }),
];
const MODELS = [
  row({ id: 'm1', name: 'demo-chat', modelName: 'demo/chat-1', protocol: 'openai', platformId: 'p1', platformName: '教程假上游', group: 'chat', timeout: 60, maxRetries: 2, maxConcurrency: 10, maxTokens: 8192, priority: 10, isMain: true, hasKey: true, capabilities: [] }),
];
/* 必须同时有成功行与异常行。
   成功状态从 2026-08-14 起渲染成普通小字而不是 chip（只有异常才配拥有视觉噪音），
   桩里若只剩成功行，基准页就一个 chip 都不出——`chip规格种类` 的上限被人为收窄到 0，
   其余 8 条路由会集体"漂移"，而真实页面上从来都有失败行。
   同一个道理已经在上面的 timeseries 注释里写过一次：桩不代表真实版面，基准就是假的。 */
/* 行数要够撑出纵向滚动：下面的「滚动位置不丢」断言必须真的滚得动，
   两行的表体 scrollHeight == clientHeight，怎么滚都是 0，那条断言会变成永远绿的空跑。 */
const LOGS = Array.from({ length: 40 }, (_, i) => (i === 1
  ? {
      id: 'l2', requestId: 'req-demo-0002', provider: 'demo', model: 'demo/chat-1', status: 'failed',
      statusCode: 502, startedAt: nowIso, durationMs: 880, inputTokens: 100, outputTokens: null,
      totalTokens: 100, appCallerCode: 'demo.chat::chat', streamed: false, sessionId: null, userId: null,
    }
  : {
      id: `l${i + 1}`, requestId: `req-demo-${String(i + 1).padStart(4, '0')}`, provider: 'demo',
      model: 'demo/chat-1', status: 'succeeded', startedAt: nowIso, durationMs: 1234,
      inputTokens: 100, outputTokens: 200, totalTokens: 300,
      appCallerCode: 'demo.chat::chat', streamed: false, sessionId: null, userId: null,
    }));
/* 模型池的卡片、成员行、操作区才是这个检测器要盯的规格来源；
   空列表只会渲染空状态，改坏了内边距/间距也照样"与基准一致"。 */
const poolMember = (over) => ({
  modelId: 'm1', platformId: 'p1', priority: 10, protocol: 'openai',
  healthStatus: 0, healthStatusLabel: '健康', lastFailedAt: null, lastSuccessAt: nowIso,
  consecutiveFailures: 0, consecutiveSuccesses: 12, enablePromptCache: false, maxTokens: 8192,
  isMain: true, isIntent: false, isVision: false, isImageGen: false, capabilities: [],
  inputPricePerMillion: 3, outputPricePerMillion: 15, pricePerCall: null, priceCurrency: 'USD',
  ...over,
});
const POOLS = [
  row({
    id: 'pool-1', name: '对话主池', code: 'chat-main', priority: 50, modelType: 'chat',
    isDefaultForType: true, strategyType: 0, description: '默认对话池',
    sourceCollection: 'model_pools', claimedAt: nowIso,
    models: [poolMember({}), poolMember({ modelId: 'm2', priority: 20, isMain: false, healthStatus: 1, healthStatusLabel: '降级' })],
    boundAppCallerCount: 1,
    boundAppCallers: [{ id: 'ac1', appCallerCode: 'demo.chat::chat', title: '演示对话', status: 'active' }],
    recentRequests: 128, recentSucceeded: 120, recentFailed: 8, recentSuccessRatePercent: 93.8,
    lastRequestAt: nowIso, trafficWindowHours: 24,
    health: 'degraded', healthyMembers: 1, degradedMembers: 1, unavailableMembers: 0,
    managedByRegistry: false, appendOnly: false, poolRole: null,
  }),
  row({
    id: 'pool-2', name: '视觉池', code: 'vision-main', priority: 40, modelType: 'vision',
    isDefaultForType: false, strategyType: 1, description: null,
    sourceCollection: 'model_pools', claimedAt: null,
    models: [poolMember({ modelId: 'm3', isMain: false, isVision: true })],
    boundAppCallerCount: 0, boundAppCallers: [],
    recentRequests: 0, recentSucceeded: 0, recentFailed: 0, recentSuccessRatePercent: null,
    lastRequestAt: null, trafficWindowHours: 24,
    health: 'healthy', healthyMembers: 1, degradedMembers: 0, unavailableMembers: 0,
    managedByRegistry: true, appendOnly: true, poolRole: 'fallback',
  }),
];
const APP_CALLERS = [
  row({
    id: 'ac1', teamId: 'team-1', appCallerCode: 'demo.chat::chat', requestType: 'chat',
    sourceSystem: 'map', clientCode: 'demo', environment: 'production', purpose: 'runtime',
    ingressProtocol: 'openai', observedIngressProtocols: ['openai'], title: '演示对话',
    status: 'active', modelPoolId: 'pool-1', modelPolicy: null, parameterPolicy: null,
    owner: 'demo', monthlyBudgetUsd: 50, rateLimitPerMinute: 60, notes: null,
    totalSeen: 128, firstSeenAt: nowIso, lastSeenAt: nowIso, rotationState: 'none',
  }),
  row({
    id: 'ac2', teamId: null, appCallerCode: 'demo.vision::vision', requestType: 'vision',
    sourceSystem: 'external', clientCode: 'partner', environment: 'staging', purpose: 'canary',
    ingressProtocol: 'anthropic', observedIngressProtocols: [], title: null,
    status: 'pending', modelPoolId: null, owner: null, totalSeen: 3,
    firstSeenAt: nowIso, lastSeenAt: nowIso, rotationState: 'none',
  }),
];
const EXCHANGES = [
  row({
    id: 'ex1', name: '教程转换器', modelAlias: 'demo-chat', modelAliases: ['demo-chat'],
    models: [{ modelId: 'demo-chat', displayName: '演示对话', modelType: 'chat', description: null, enabled: true }],
    targetUrl: 'https://provider.example.com/v1/chat/completions', targetAuthScheme: 'bearer',
    transformerType: 'openai', description: '把 OpenAI 协议转成上游私有协议', hasKey: true,
    sourceCollection: 'exchanges', claimedAt: nowIso, version: 2,
  }),
  row({
    id: 'ex2', name: '备用转换器', modelAlias: 'demo-vision', modelAliases: ['demo-vision', 'demo-vision-hd'],
    models: [{ modelId: 'demo-vision', displayName: null, modelType: 'vision', description: null, enabled: false }],
    targetUrl: 'https://backup.example.com/v1/messages', targetAuthScheme: 'x-api-key',
    transformerType: 'anthropic', description: null, hasKey: false,
    sourceCollection: 'exchanges', claimedAt: null, version: 1,
  }),
];
const offering = (over) => ({
  id: 'of1', logicalModelId: 'lm1', targetKind: 'model', targetId: 'm1', targetName: 'demo-chat',
  providerName: '教程假上游', upstreamModelId: 'demo/chat-1', protocol: 'openai', endpointPath: null,
  priority: 10, weight: 100, enabled: true, healthStatus: 0, consecutiveFailures: 0,
  consecutiveSuccesses: 9, maxConcurrency: 10, rateLimitPerMinute: null, notes: null, ...over,
});
const LOGICAL_MODELS = [
  row({
    id: 'lm1', publicId: 'gw-chat-standard', name: '标准对话', modelType: 'chat',
    capabilities: ['tools', 'streaming'], allowedAppCallerCodes: ['demo.chat::chat'],
    routingStrategy: 'priority', displayOrder: 1, description: '对外暴露的标准对话模型',
    offerings: [offering({}), offering({ id: 'of2', targetKind: 'exchange', targetId: 'ex1', targetName: '教程转换器', priority: 20, healthStatus: 1 })],
  }),
  row({
    id: 'lm2', publicId: 'gw-vision-standard', name: '标准视觉', modelType: 'vision',
    capabilities: ['vision'], allowedAppCallerCodes: [], routingStrategy: 'weighted',
    displayOrder: 2, description: null, offerings: [offering({ id: 'of3', logicalModelId: 'lm2', targetId: 'm3', targetName: 'demo-vision' })],
  }),
];
const LIST = { items: [], total: 2, page: 1, pageSize: 20 };
const STUBS = {
  '/auth/tenants': [],
  '/platforms': { ...LIST, items: PLATFORMS, platforms: PLATFORMS },
  '/models': { ...LIST, items: MODELS, models: MODELS },
  '/logs': { ...LIST, total: LOGS.length, items: LOGS },
  '/logs/meta': { models: [], providers: [], statuses: [], appCallerCodes: [], sessions: [], teams: [], serviceKeys: [], clientCodes: [], environments: [] },
  '/logs/summary': { total: LOGS.length, succeeded: LOGS.length - 1, failed: 1, totalTokens: 400, estimatedCostUsd: 0.01 },
  // 趋势图是基准页自身的一部分，空 points 会让它整块不渲染 —— 基准就不再代表真实版面。
  '/logs/timeseries': { items: Array.from({ length: 14 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, count: 3 + ((i * 7) % 11) })) },
  '/service-keys': [row({ id: 'k1', name: 'runtime-key', keyPrefix: 'gwk_demo', teamId: null, createdByUsername: 'demo', sourceSystem: 'map', clientCode: 'demo', environment: 'production', purpose: 'runtime', appCallerCodes: ['demo.chat::chat'], ingressProtocols: ['openai'], scopes: ['chat'], allowedCidrs: [] })],
  '/audits': { ...LIST, items: [row({ id: 'a1', action: 'pool.update', targetType: 'pool', targetId: 'pool-1', actorUsername: 'demo', success: true, summary: '更新模型池优先级', detail: null })] },
  '/app-callers': { ...LIST, items: APP_CALLERS, statuses: ['active', 'pending'], sourceSystems: ['map', 'external'], ingressProtocols: ['openai', 'anthropic'], requestTypes: ['chat', 'vision'] },
  '/pools': { ...LIST, items: POOLS, pools: POOLS },
  '/pool-types': {
    items: [
      { code: 'chat', name: '对话', purpose: '常规对话', sortOrder: 1, defaultPoolId: 'pool-1', modelCount: 2, ready: true, version: 1 },
      { code: 'vision', name: '视觉', purpose: '图像理解', sortOrder: 2, defaultPoolId: '', modelCount: 1, ready: false, version: 1 },
    ],
    total: 2, ready: 1, waiting: 1,
  },
  '/parameter-capabilities/meta': { items: [], templates: [] },
  '/logical-models': { items: LOGICAL_MODELS, total: LOGICAL_MODELS.length },
  '/exchanges': { ...LIST, items: EXCHANGES, exchanges: EXCHANGES },
  '/capabilities/image-layering': {
    capabilityId: 'image-layering', state: 'installed', installed: true, verified: false, hasKey: true,
    exchangeId: 'ex2', logicalModelId: 'lm-image-layering', offeringId: 'of-image-layering',
    modelId: 'fal-qwen-image-layered', publicId: 'image-layering', lastVerifiedAt: null,
  },
  // 形状必须对齐 ExchangeMetaData —— 旧桩写的是 protocols/targetKinds/models，
  // 因为 exchanges 恒空、渲染分支从没走到，这个错形状一直没暴露。
  '/exchanges/meta': {
    transformerTypes: [
      { value: 'openai', label: 'OpenAI 兼容', description: '直接透传 OpenAI 协议' },
      { value: 'anthropic', label: 'Anthropic Messages', description: '转换为 Anthropic Messages 协议' },
    ],
    authSchemes: [
      { value: 'bearer', label: 'Bearer Token', description: 'Authorization: Bearer <key>' },
      { value: 'x-api-key', label: 'X-Api-Key', description: '自定义头透传' },
    ],
    modelTypes: [
      { value: 'chat', label: '对话', description: null },
      { value: 'vision', label: '视觉', description: null },
    ],
  },
  '/healthz': { status: 'ok' },
};
const stubFor = (api) => STUBS[api.split('?')[0]] ?? { ...LIST, items: [] };

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const p = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (p.startsWith('/llmgw/gw/')) {
    if (p === '/llmgw/gw/auth/login') {
      return json(res, 200, { success: true, error: null, data: {
        token: 'stub', username: 'demo', displayName: 'Demo',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), mustChangePassword: false,
        tenant: { id: 't1', name: '演示租户', isInternal: true, role: 'owner', teamIds: ['team-1'] },
      } });
    }
    return json(res, 200, { success: true, error: null, data: stubFor(p.replace('/llmgw/gw', '')) });
  }
  const rel = p.replace(/^\/llmgw/, '');
  const file = rel === '' || rel === '/' || !path.extname(rel) ? '/index.html' : rel;
  const full = path.join(DIST, file);
  if (!fs.existsSync(full)) return json(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  res.end(fs.readFileSync(full));
});

const measure = () => {
  const num = (v) => Math.round(parseFloat(v) || 0);
  const h1 = document.querySelector('h1');
  const main = document.querySelector('.lg-console-content');
  const vh = window.innerHeight;

  // 页头是否被塞进一个带边框/底色的卡片里（请求记录页的标题是裸露在页面上的）
  let headingBoxed = false;
  if (h1) {
    let el = h1.parentElement;
    for (let i = 0; i < 4 && el && el !== main; i += 1) {
      const cs = getComputedStyle(el);
      if (num(cs.borderTopWidth) > 0 || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent')) {
        headingBoxed = true;
        break;
      }
      el = el.parentElement;
    }
  }

  // 主内容底部到视口底部的空隙：请求记录页几乎贴底（表格撑满），配置页往往留一大片
  let bottomGap = null;
  if (main) {
    const kids = [...main.querySelectorAll('*')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 40 && r.width > 200 && r.top < vh;
    });
    const lowest = kids.reduce((acc, el) => Math.max(acc, el.getBoundingClientRect().bottom), 0);
    bottomGap = Math.max(0, Math.round(vh - lowest));
  }

  // 组件规格种类数：同一角色出现多套规格 = 手工拼凑感的主要来源。
  const pads = new Set(), radii = new Set(), gaps = new Set(), chipSpecs = new Set(), primaryBtns = new Set();
  for (const el of main.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 20) continue;
    const cs = getComputedStyle(el);
    const boxed = num(cs.borderTopWidth) > 0
      || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent');
    if (boxed && rect.width > 150) {
      if (num(cs.paddingTop) > 0) pads.add(num(cs.paddingTop));
      if (num(cs.borderTopLeftRadius) > 0) radii.add(num(cs.borderTopLeftRadius));
    }
    if (cs.display.includes('flex') || cs.display.includes('grid')) {
      // <4px 的不是版面间距，是图元内部的缝（柱状图柱间 3px 之类），不计入容器间距口径。
      const g = num(cs.rowGap || cs.gap);
      if (g >= 4) gaps.add(g);
    }
  }
  for (const el of main.querySelectorAll('span, small')) {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (num(cs.borderTopLeftRadius) < 6 || rect.height < 14 || rect.height > 30 || rect.width > 160) continue;
    if (cs.backgroundColor === 'rgba(0, 0, 0, 0)') continue;
    chipSpecs.add(`h${Math.round(rect.height)}f${num(cs.fontSize)}`);
  }
  for (const el of main.querySelectorAll('button')) {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    // 主操作 = 强调底色的按钮
    if (!cs.backgroundColor.includes('rgb') || rect.width < 60) continue;
    const bg = cs.backgroundColor;
    if (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    if (!accent || !el.textContent?.trim()) continue;
    if (cs.color === 'rgb(255, 255, 255)' || bg.startsWith('rgb(1') || bg.startsWith('rgb(9') || bg.startsWith('rgb(16')) {
      primaryBtns.add(`h${Math.round(rect.height)}f${num(cs.fontSize)}`);
    }
  }

  const th = document.querySelector('th, .lg-log-table-head > div');
  const td = document.querySelector('tbody td, .lg-log-table-row > div');
  const tr = document.querySelector('tbody tr, .lg-log-table-row');
  const controls = [...document.querySelectorAll('select, input:not([type=checkbox]):not([type=radio])')]
    .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height > 0);
  return {
    标题字号: h1 ? num(getComputedStyle(h1).fontSize) : null,
    标题被卡片包住: headingBoxed,
    内容底部空隙: bottomGap,
    表头字号: th ? num(getComputedStyle(th).fontSize) : null,
    单元格字号: td ? num(getComputedStyle(td).fontSize) : null,
    单行行盒: (() => {
      if (!td) return null;
      const cs = getComputedStyle(td);
      if (td.tagName === 'TD') {
        return num(cs.paddingTop) + num(cs.paddingBottom) + Math.round(parseFloat(cs.lineHeight)) + num(cs.borderTopWidth);
      }
      return tr ? Math.round(tr.getBoundingClientRect().height) : null;
    })(),
    控件高度: [...new Set(controls.map((el) => Math.round(el.getBoundingClientRect().height)).filter(Boolean))].sort((a, b) => a - b),
    卡片内边距种类: [...pads].sort((a, b) => a - b),
    卡片圆角种类: [...radii].sort((a, b) => a - b),
    容器间距种类: [...gaps].sort((a, b) => a - b),
    chip规格种类: [...chipSpecs],
    主操作按钮规格: [...primaryBtns],
  };
};

await new Promise((r) => server.listen(PORT, r));
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`找不到构建产物：${DIST}\n请先执行 cd llmgw/web && pnpm build，或用 LLMGW_DIST 指定 dist 目录。`);
  process.exit(1);
}
const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const base = `http://localhost:${PORT}/llmgw`;
await page.goto(`${base}/logs`);
await page.waitForSelector('#llmgw-username');
await page.fill('#llmgw-username', 'demo');
await page.fill('#llmgw-password', 'demo');
await page.click('button[type=submit]');
await page.waitForURL('**/llmgw/logs');

const ROUTES = ['/logs', '/platforms', '/models', '/service-keys', '/audits', '/app-callers', '/pools', '/logical-models', '/exchanges'];
const data = {};
for (const route of ROUTES) {
  await page.goto(`${base}${route}`);
  await page.waitForTimeout(800);
  data[route] = await page.evaluate(measure);
}
await page.goto(`${base}/exchanges#image-layering`);
await page.waitForSelector('[data-testid="exchange-list"]');
const exchangeLayout = await page.evaluate(() => {
  const capability = document.querySelector('#image-layering');
  const cards = [...document.querySelectorAll('[data-testid="exchange-list"] > div')]
    .map((element) => element.getBoundingClientRect());
  return {
    capabilityWidth: capability ? Math.round(capability.getBoundingClientRect().width) : null,
    cardCount: cards.length,
    columns: new Set(cards.map((rect) => Math.round(rect.left))).size,
    equalWidths: new Set(cards.map((rect) => Math.round(rect.width))).size <= 1,
  };
});
// 侧栏页脚（「提交缺陷」的唯一可见入口）必须不滚动就在视口内。
// 这是运行时判据，源码扫描替代不了：CSS 写法看着对，导航项一多照样把页脚顶出去。
// 2026-08-14 就是这么翻的车——页脚底边落在 y=933、视口 900，入口等于消失。
const sidebarFooter = await page.evaluate(() => {
  const aside = document.querySelector('.lg-console-sidebar');
  const foot = document.querySelector('.lg-sidebar-footer');
  if (!aside || !foot) return { 存在: false };
  const a = aside.getBoundingClientRect();
  const f = foot.getBoundingClientRect();
  return {
    存在: true,
    需要滚动: aside.scrollHeight > Math.ceil(a.height) + 1,
    在视口内: f.top >= 0 && f.bottom <= window.innerHeight + 1,
    页脚底部y: Math.round(f.bottom),
    视口高: window.innerHeight,
  };
});

// 表体的滚动位置必须能扛住一次重渲染。
// 这条判据针对的是真实踩过的形状：LogTable 若定义在 LogsView 函数体里，
// 组件类型每次渲染都变，React 整棵卸载重挂，.lg-log-table-body 的 DOM 节点被换掉、
// scrollTop 归零。分页时代这只是「偶尔跳回顶部」，改成瀑布加载后会变成
// 「越滚越弹回 + 反复触底重取」。源码扫描测不出来，只能真滚一次。
await page.goto(`${base}/logs`);
await page.waitForSelector('.lg-log-table-body');
await page.waitForTimeout(900);
const scrollKeep = await page.evaluate(async () => {
  const body = document.querySelector('.lg-log-table-body');
  if (!body) return { 可滚动: false, 原因: '找不到表体' };
  if (body.scrollHeight <= body.clientHeight + 1) return { 可滚动: false, 原因: '桩数据撑不出滚动条' };
  body.scrollTop = 120;
  const before = body.scrollTop;
  document.querySelector('.lg-log-trend-toggle')?.click();
  await new Promise((r) => setTimeout(r, 350));
  const after = document.querySelector('.lg-log-table-body');
  return { 可滚动: true, 滚动前: before, 重渲染后: after ? after.scrollTop : -1 };
});

if (process.env.LLMGW_SCREENSHOT_PATH) {
  await page.screenshot({ path: process.env.LLMGW_SCREENSHOT_PATH, fullPage: true });
}
await browser.close();
server.close();

const baseline = data['/logs'];
console.log('基准（请求记录页）:', JSON.stringify(baseline), '\n');
const KEYS = ['标题字号', '标题被卡片包住', '内容底部空隙', '表头字号', '单元格字号', '单行行盒', '控件高度',
  '卡片内边距种类', '卡片圆角种类', '容器间距种类', 'chip规格种类', '主操作按钮规格'];
// 规格种类数的上限来自基准页本身，而不是拍脑袋定一个理想值——
// 检测器的职责是「不许比基准更乱」，把基准自己收得更紧是另一件事。
// 见 doc/rule.platform.llm-gateway.console-design-tonality.md
const SPEC_KEYS = ['卡片内边距种类', '卡片圆角种类', '容器间距种类', 'chip规格种类', '主操作按钮规格'];
let drift = 0;
for (const [route, m] of Object.entries(data)) {
  if (route === '/logs') continue;
  const diffs = [];
  for (const k of KEYS) {
    const a = baseline[k];
    const b = m[k];
    if (b === null || b === undefined) continue;
    if (k === '内容底部空隙') { if (b - a > 80) diffs.push(`${k} ${b}px（基准 ${a}px，下方留白过多）`); continue; }
    if (SPEC_KEYS.includes(k)) {
      const limit = Math.max(1, (Array.isArray(a) ? a.length : 0));
      if (Array.isArray(b) && b.length > limit) {
        diffs.push(`${k} ${b.length} 种 ${JSON.stringify(b)}（基准 ${limit} 种）`);
      }
      continue;
    }
    if (k === '控件高度') {
      const real = b.filter((h) => h >= 24);
      const short = real.filter((h) => h < 34);
      if (short.length) diffs.push(`${k} ${JSON.stringify(short)}px 偏矮（基准区间 34~38px）`);
      continue;
    }
    if (k === '标题被卡片包住') { if (b !== a) diffs.push(`${k}=${b}（基准 ${a}）`); continue; }
    if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) > 2) diffs.push(`${k} ${b}（基准 ${a}）`);
  }
  if (process.env.VERBOSE) console.log(`${route.padEnd(17)} 内边距${JSON.stringify(m.卡片内边距种类)} 圆角${JSON.stringify(m.卡片圆角种类)} 间距${JSON.stringify(m.容器间距种类)} chip${JSON.stringify(m.chip规格种类)}`);
  console.log(`${route.padEnd(17)} ${diffs.length ? '漂移: ' + diffs.join('；') : '与基准一致'}`);
  drift += diffs.length;
}
console.log('表体滚动保持:', JSON.stringify(scrollKeep));
if (!scrollKeep.可滚动) {
  console.error(`无法验证滚动保持：${scrollKeep.原因}——这条断言正在空跑，请修桩数据。`);
  drift += 1;
} else if (scrollKeep.重渲染后 !== scrollKeep.滚动前) {
  console.error(
    `一次重渲染就把表体滚动位置冲掉了（${scrollKeep.滚动前} → ${scrollKeep.重渲染后}）。`
    + '\n  多半是 LogTable 又被挪回 LogsView 函数体内：组件类型每次渲染都变，React 会整棵重挂。',
  );
  drift += 1;
}

console.log('侧栏页脚:', JSON.stringify(sidebarFooter));
if (!sidebarFooter.存在) {
  console.error('侧栏页脚 .lg-sidebar-footer 不存在——「提交缺陷」失去唯一可见入口。');
  drift += 1;
} else if (!sidebarFooter.在视口内 || sidebarFooter.需要滚动) {
  console.error(
    `侧栏页脚不滚动就够不着（页脚底边 y=${sidebarFooter.页脚底部y}，视口高 ${sidebarFooter.视口高}）。`
    + '\n  滚动要归 .lg-console-sidebar > nav，侧栏自身 overflow:hidden，页脚 flex:0 0 auto。',
  );
  drift += 1;
}

console.log('Exchange 布局:', JSON.stringify(exchangeLayout));
if (exchangeLayout.cardCount > 1 && (exchangeLayout.columns !== 1 || !exchangeLayout.equalWidths)) {
  console.error('Exchange 列表必须保持单列且卡片等宽。');
  drift += 1;
}
// 总数必须打在**所有**断言之后：先打总数再跑断言，日志上会出现「合计漂移项: 0」
// 紧跟着失败详情，读日志的人被那个 0 骗过去。
console.log(`\n合计漂移项: ${drift}`);

// 有漂移必须非零退出，否则任何按退出码判定的 CI / 本地校验都会把回归当通过。
if (drift > 0) process.exitCode = 1;
