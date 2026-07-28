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
const LOGS = [{
  id: 'l1', requestId: 'req-demo-0001', provider: 'demo', model: 'demo/chat-1', status: 'succeeded',
  startedAt: nowIso, durationMs: 1234, inputTokens: 100, outputTokens: 200, totalTokens: 300,
  appCallerCode: 'demo.chat::chat', streamed: false, sessionId: null, userId: null,
}];
const LIST = { items: [], total: 2, page: 1, pageSize: 20 };
const STUBS = {
  '/auth/tenants': [],
  '/platforms': { ...LIST, items: PLATFORMS, platforms: PLATFORMS },
  '/models': { ...LIST, items: MODELS, models: MODELS },
  '/logs': { ...LIST, total: 1, items: LOGS },
  '/logs/meta': { models: [], providers: [], statuses: [], appCallerCodes: [], sessions: [], teams: [], serviceKeys: [], clientCodes: [], environments: [] },
  '/logs/summary': { total: 1, succeeded: 1, failed: 0, totalTokens: 300, estimatedCostUsd: 0.01 },
  '/logs/timeseries': { points: [], buckets: [] },
  '/service-keys': [row({ id: 'k1', name: 'runtime-key', keyPrefix: 'gwk_demo', teamId: null, createdByUsername: 'demo', sourceSystem: 'map', clientCode: 'demo', environment: 'production', purpose: 'runtime', appCallerCodes: ['demo.chat::chat'], ingressProtocols: ['openai'], scopes: ['chat'], allowedCidrs: [] })],
  '/audits': { ...LIST, items: [row({ id: 'a1', action: 'pool.update', targetType: 'pool', targetId: 'pool-1', actorUsername: 'demo', success: true, summary: '更新模型池优先级', detail: null })] },
  '/app-callers': { ...LIST, items: [], statuses: [], sourceSystems: [], ingressProtocols: [], requestTypes: [] },
  '/pools': { ...LIST, items: [], pools: [] },
  '/pool-types': { items: [], total: 0, ready: 0, waiting: 0 },
  '/parameter-capabilities/meta': { items: [], templates: [] },
  '/logical-models': { items: [], total: 0 },
  '/exchanges': { ...LIST, items: [], exchanges: [] },
  '/exchanges/meta': { protocols: [], targetKinds: [], models: [] },
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
      const g = num(cs.rowGap || cs.gap);
      if (g > 0) gaps.add(g);
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
  const paddings = new Set();
  for (const el of document.querySelectorAll('.lg-console-content section, .lg-console-content .lg-card, .lg-console-content > div > div')) {
    const p = num(getComputedStyle(el).paddingTop);
    if (p > 0) paddings.add(p);
  }

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
    卡片内边距种类: [...paddings].sort((a, b) => a - b),
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
await browser.close();
server.close();

const baseline = data['/logs'];
console.log('基准（请求记录页）:', JSON.stringify(baseline), '\n');
const KEYS = ['标题字号', '标题被卡片包住', '内容底部空隙', '表头字号', '单元格字号', '单行行盒', '控件高度',
  '卡片内边距种类', '卡片圆角种类', '容器间距种类', 'chip规格种类', '主操作按钮规格'];
// 规格种类数的上限来自基准页本身，而不是拍脑袋定一个理想值——
// 检测器的职责是「不许比基准更乱」，把基准自己收得更紧是另一件事。
// 见 doc/rule.llm-gateway.console-design-tonality.md
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
  console.log(`${route.padEnd(17)} ${diffs.length ? '漂移: ' + diffs.join('；') : '与基准一致'}`);
  drift += diffs.length;
}
console.log(`\n合计漂移项: ${drift}`);
