// 接入密钥「按用途生成 appCallerCode」验收（llmgw 控制台）。
//
// 用法：
//   cd llmgw/web && pnpm build          # 先产出 dist
//   cd e2e && pnpm install && node llmgw-service-key-appcaller.mjs
//
// 可选环境变量：
//   LLMGW_DIST                构建产物目录（默认 <repo>/llmgw/web/dist）
//   PLAYWRIGHT_CHROMIUM_PATH  指定 chromium 可执行文件；不设则由 Playwright 自行解析
//
// 为什么要有这一条：新建密钥表单以前让用户自己往输入框里填 appCallerCode，默认值
// 直接取当前租户观测到的第一条 code（线上截图是 `ai-toolbox.agent.::generation`，
// 中间还带一个空段）。改成「填用途 → 系统拼标识 → 顺手登记」之后，真正要守住的是
// **发出去的两个请求体**，而不是页面上写了什么字：
//   1. 界面显示的 code == 提交给 /gw/service-keys 的 appCallerCodes[0]
//      （显示一套、提交另一套，是这类"自动填"最典型的翻车方式）
//   2. 生成的 code 能过 console-api 的 IsValidSelfServiceAppCaller
//      （段内只允许 [a-z][a-z0-9-]*，clientCode 里的点和下划线必须被压掉）
//   3. 中文用途也拼得出合法 code，而不是把校验错误甩回给用户
//   4. 密钥签发前先 POST /gw/app-callers 登记，且团队取自当前身份
//   5. 「选择已有」路径不再登记（复用已有 code），轮换沿用旧钥的 code
// 断言的是真实浏览器发出的网络请求，桩只负责让页面能跑起来。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.LLMGW_DIST || path.join(REPO_ROOT, 'llmgw/web/dist');
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const PORT = 5623;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const nowIso = new Date().toISOString();

/** console-api 的 IsValidSelfServiceAppCaller 同款判据，独立写一遍用来验运行时产物。 */
const SELF_SERVICE_APP_CALLER = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+::(chat|vision)$/;

const APP_CALLERS = [{
  id: 'ac1', tenantId: 't1', teamId: 'team-1', appCallerCode: 'ai-toolbox.agent::generation',
  requestType: 'generation', sourceSystem: 'external', clientCode: 'ai-toolbox', environment: 'production',
  purpose: 'external-platform', ingressProtocol: 'openai-compatible', observedIngressProtocols: [],
  title: '历史观测到的调用用途', status: 'discovered', modelPolicy: 'auto', parameterPolicy: 'default-drop',
  totalSeen: 12, createdAt: nowIso, updatedAt: nowIso,
}];

const LIST = { items: [], total: 0, page: 1, pageSize: 20 };
const STUBS = {
  '/auth/tenants': [],
  '/service-keys': [],
  '/app-callers': { ...LIST, items: APP_CALLERS, total: APP_CALLERS.length, statuses: [], sourceSystems: [], ingressProtocols: [], requestTypes: [] },
  '/organization': {
    tenant: { id: 't1', name: '演示租户', slug: 'demo', status: 'active', isInternal: false },
    teams: [{ id: 'team-1', name: '接入组', status: 'active', createdAt: nowIso, updatedAt: nowIso }],
    members: [],
  },
  '/healthz': { status: 'ok' },
};
const stubFor = (api) => STUBS[api.split('?')[0]] ?? { ...LIST, items: [] };

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** 浏览器真的发出来的写请求，逐条留档给断言用。 */
const posted = [];

const server = http.createServer((req, res) => {
  const p = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (p.startsWith('/llmgw/gw/')) {
    const api = p.replace('/llmgw/gw', '');
    if (api === '/auth/login') {
      return json(res, 200, { success: true, error: null, data: {
        token: 'stub', username: 'demo', displayName: 'Demo',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), mustChangePassword: false,
        tenant: { id: 't1', name: '演示租户', isInternal: false, role: 'owner', teamIds: ['team-1'] },
      } });
    }
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        posted.push({ api, body: raw ? JSON.parse(raw) : null });
        if (api === '/app-callers') {
          return json(res, 200, { success: true, error: null, data: { ...APP_CALLERS[0], id: 'ac-new' } });
        }
        if (api === '/service-keys') {
          return json(res, 200, { success: true, error: null, data: { id: 'k-new', key: 'gwk_stub_secret', keyPrefix: 'gwk_stub', name: 'stub' } });
        }
        return json(res, 200, { success: true, error: null, data: {} });
      });
      return undefined;
    }
    return json(res, 200, { success: true, error: null, data: stubFor(api) });
  }
  const rel = p.replace(/^\/llmgw/, '');
  const file = rel === '' || rel === '/' || !path.extname(rel) ? '/index.html' : rel;
  const full = path.join(DIST, file);
  if (!fs.existsSync(full)) return json(res, 404, { error: 'not found' });
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const base = `http://localhost:${PORT}/llmgw`;
await page.goto(`${base}/service-keys`);
await page.waitForSelector('#llmgw-username');
await page.fill('#llmgw-username', 'demo');
await page.fill('#llmgw-password', 'demo');
await page.click('button[type=submit]');
await page.waitForURL('**/llmgw/service-keys');
await page.waitForTimeout(600);

// 打开新建表单：真人路径是点页头的「新建密钥」，不是直接改 URL。
await page.getByRole('button', { name: '新建密钥' }).click();
await page.waitForSelector('.lg-service-key-form');

const generatedCode = () => page.locator('.lg-service-key-generated-caller').innerText();
const nameInput = page.locator('.lg-service-key-fast-fields input').first();
const featureInput = page.locator('input[aria-label="调用用途"]');

// 1) 中文名称拼不出 clientCode 时退回 external-client；中文用途退回 access。
//    这一档以前的结果是让用户对着一个自己看不懂、也改不对的 code 发呆。
await nameInput.fill('测试环境');
await featureInput.fill('桌面客户端');
await page.waitForTimeout(120);
const chineseCode = await generatedCode();
check('中文名称与中文用途也拼得出 code', chineseCode, 'external-client.access::chat');
check('中文档位的 code 过 console-api 判据', SELF_SERVICE_APP_CALLER.test(chineseCode), true);

// 2) 拉丁用途按字面进 feature 段；下划线、空格、连续分隔符都压成单个短横线。
await featureInput.fill('Desktop  Client_v2');
await page.waitForTimeout(120);
const latinCode = await generatedCode();
check('用途压成合法 kebab 段', latinCode, 'external-client.desktop-client-v2::chat');
check('拉丁档位的 code 过 console-api 判据', SELF_SERVICE_APP_CALLER.test(latinCode), true);

// 3) 密钥名称推出的 clientCode 参与拼装；点和下划线是段内非法字符，必须被压掉。
await nameInput.fill('cherry_studio.desktop');
await featureInput.fill('desktop');
await page.waitForTimeout(120);
const clientCode = await page.locator('.lg-service-key-defaults strong').first().innerText();
const composedCode = await generatedCode();
check('clientCode 保留自己的点与下划线', clientCode, 'cherry_studio.desktop');
check('appCallerCode 段内不含点与下划线', composedCode, 'cherry-studio-desktop.desktop::chat');
check('组合档位的 code 过 console-api 判据', SELF_SERVICE_APP_CALLER.test(composedCode), true);

// 4) 切调用类型 → 后缀跟着变（后缀决定它被当成 chat 还是 vision 路由）。
await page.locator('select[aria-label="调用类型"]').selectOption('vision');
await page.waitForTimeout(120);
check('调用类型切到图片理解', await generatedCode(), 'cherry-studio-desktop.desktop::vision');
await page.locator('select[aria-label="调用类型"]').selectOption('chat');
await page.waitForTimeout(120);

// 5) 提交：先登记 appCaller 再签发密钥，两个请求体都必须带同一条 code。
const shownBeforeSubmit = await generatedCode();
await page.getByRole('button', { name: '生成 API Key' }).click();
await page.waitForTimeout(1200);

check('两个写请求的顺序', posted.map((item) => item.api), ['/app-callers', '/service-keys']);
const callerBody = posted.find((item) => item.api === '/app-callers')?.body ?? {};
const keyBody = posted.find((item) => item.api === '/service-keys')?.body ?? {};
check('登记的 code 与界面显示一致', callerBody.appCallerCode, shownBeforeSubmit);
check('登记的 requestType 与后缀一致', callerBody.requestType, 'chat');
check('登记归属当前身份的团队', callerBody.teamId, 'team-1');
check('密钥授权的 code 与界面显示一致', keyBody.appCallerCodes, [shownBeforeSubmit]);
check('密钥没有被顺手绑成团队级', keyBody.teamId, undefined);
check('界面显示的 code 从未变成历史观测值', shownBeforeSubmit.includes('ai-toolbox'), false);

// 6) 「选择已有」路径：复用已登记的 code，不再重复登记。
posted.length = 0;
await page.getByRole('button', { name: '新建密钥' }).click();
await page.waitForSelector('.lg-service-key-form');
await page.getByRole('button', { name: '选择已有调用用途' }).click();
await nameInput.fill('reuse-existing');
await page.locator('input[list="llmgw-app-callers"]').fill('ai-toolbox.agent::generation');
await page.waitForTimeout(120);
await page.getByRole('button', { name: '生成 API Key' }).click();
await page.waitForTimeout(1200);
check('复用已有 code 时不再登记 appCaller', posted.map((item) => item.api), ['/service-keys']);
check('复用的 code 原样提交', posted[0]?.body?.appCallerCodes, ['ai-toolbox.agent::generation']);

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} 条断言失败：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\n接入密钥 appCallerCode 生成验收全部通过。');
