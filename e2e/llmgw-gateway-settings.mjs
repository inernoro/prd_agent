// 服务网关设置验收：系统级模型只让用户做一个决定，其余全部由系统端出来。
//
// 用法：
//   cd llmgw/web && pnpm build          # 先产出 dist
//   cd e2e && pnpm install && node llmgw-gateway-settings.mjs
//
// 这条守卫盯的是四件「改完看着都对、下一次改版最容易悄悄退化」的事：
//
//   0. **必填项只有一个决定。** 页面上不许再出现地址、appCaller、密钥这三类输入框——
//      它们是系统自己知道的值（minimal-user-input）。断言取的是真实输入控件的数量，
//      不是「有没有渲染出某个 class」。
//   1. **选池 / 选模型的真实提交体。** 选了池就必须带 modelGroupId、不带 modelName；
//      反过来同理。断言看的是浏览器真正发出的 PUT body。
//   2. **密钥明文永不下发。** 后端只回前缀，页面上不许出现完整密钥形状的字符串。
//   3. **失败必须给得出下一步。** 测试连接失败时，页面上那句话要指出去哪修，
//      不是一个裸状态码——这正是用户撞见 401 时最缺的东西。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.LLMGW_DIST || path.join(REPO_ROOT, 'llmgw/web/dist');
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const PORT = 5629;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const nowIso = new Date().toISOString();

/** 浏览器真正发出的写请求。 */
const posted = [];
/** 测试连接桩的行为：ok = 通了；fail = 系统密钥被撤销。 */
let testMode = 'ok';
/** 当前系统级设置，PUT 之后 GET 要能读回改后的值。 */
let settings = { modelSource: 'auto', modelGroupId: null, modelName: null };

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const p = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (p.startsWith('/llmgw/gw/')) {
    const api = p.replace('/llmgw/gw', '');
    if (api === '/auth/login') {
      return json(res, 200, { success: true, error: null, data: {
        token: 'stub', username: 'zhou', displayName: '周越', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        mustChangePassword: false, tenant: { id: 't1', name: 'Miduo 平台', isInternal: false, role: 'owner', teamIds: ['team-1'] },
      } });
    }
    if (api === '/system-settings' && req.method === 'GET') {
      return json(res, 200, { success: true, error: null, data: {
        ...settings,
        teamId: 'team-1',
        teamName: '核心平台组',
        servingBaseUrl: 'http://llmgw-serve-prd-agent:8091',
        servingReachable: true,
        appCallerCode: 'llmgw-console.intent-draft::chat',
        credentialState: 'ready',
        // 只回前缀：完整密钥永远不该出现在响应里，页面也就无从渲染。
        credentialPrefix: 'gwk_2X2lc7Ob',
        credentialIssuedAt: nowIso,
        pools: [
          { id: 'pool-1', name: '对话默认池', isDefault: true },
          { id: 'pool-2', name: '实验池', isDefault: false },
        ],
        models: [{ id: 'lm-1', name: 'demo/chat-1' }, { id: 'lm-2', name: 'demo/chat-2' }],
        consumers: [{ feature: 'Quickstart · 一句话推导调用用途码', appCallerCode: 'llmgw-console.intent-draft::chat' }],
      } });
    }
    if (api === '/system-settings' && req.method === 'PUT') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        posted.push({ method: 'PUT /system-settings', body });
        settings = {
          modelSource: body.modelSource,
          modelGroupId: body.modelGroupId ?? null,
          modelName: body.modelName ?? null,
        };
        json(res, 200, { success: true, error: null, data: body });
      });
      return undefined;
    }
    if (api === '/system-settings/test') {
      posted.push({ method: 'POST /system-settings/test', body: null });
      return json(res, 200, { success: true, error: null, data: testMode === 'ok'
        ? { ok: true, stage: 'done', elapsedMs: 412, servedModel: 'demo/chat-1', message: '通了：412 ms 内拿到回复，实际执行的是 demo/chat-1。' }
        : { ok: false, stage: 'invoke', elapsedMs: 88, message: '网关拒绝了系统自己的密钥（已失效或被撤销）。下次请求会自动重签一把；连续出现请在「服务网关设置」点一次「测试连接」看详情。' } });
    }
    if (api === '/auth/tenants') return json(res, 200, { success: true, error: null, data: [] });
    return json(res, 200, { success: true, error: null, data: {} });
  }
  // dist 是按 base=/llmgw/ 构建的，静态资源路径都带这个前缀，取文件前先剥掉。
  const stripped = p.replace(/^\/llmgw/, '') || '/';
  const rel = stripped === '/' ? '/index.html' : stripped;
  const file = path.join(DIST, rel);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  return res.end(fs.readFileSync(path.join(DIST, 'index.html')));
});

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '通过' : '失败'}  ${name}  ${JSON.stringify(actual)}${ok ? '' : ` != ${JSON.stringify(expected)}`}`);
};

await new Promise((resolve) => server.listen(PORT, resolve));
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`找不到构建产物：${DIST}\n请先执行 cd llmgw/web && pnpm build，或用 LLMGW_DIST 指定 dist 目录。`);
  process.exit(1);
}
const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const base = `http://localhost:${PORT}/llmgw`;
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`${base}/`);
await page.waitForSelector('#llmgw-username');
await page.fill('#llmgw-username', 'zhou');
await page.fill('#llmgw-password', 'demo');
await page.click('button[type=submit]');
await page.waitForTimeout(1200);

// 真人路径：点侧栏「服务网关设置」进入，不用地址栏直达。
await page.getByRole('link', { name: '服务网关设置' }).click();
await page.waitForSelector('.lg-gws-sources', { timeout: 15000 });

// 0. 必填项只有一个决定：本页正文里不该有任何文本输入框（地址/appCaller/密钥都是展示）。
//    只数正文区，顶栏那个 requestId 搜索框是布局的、不属于这一页。
const bodyScope = page.locator('main, .lg-page-body').last();
check('设置正文没有文本输入框', await bodyScope.locator('input[type=text], input:not([type])').count(), 0);
check('三种模型来源都摆出来了', await page.locator('.lg-gws-sources > button').count(), 3);
check('默认选中「交给网关挑」', await page.locator('.lg-gws-sources > button[aria-checked="true"]').innerText(), (await page.locator('.lg-gws-sources > button').first().innerText()));

// 2. 密钥明文永不下发：页面上不该出现完整密钥形状（gwk_ 后面跟一长串）。
const bodyText = await page.locator('body').innerText();
check('页面出现密钥前缀', bodyText.includes('gwk_2X2lc7Ob'), true);
check('页面没有完整密钥形状', /gwk_[A-Za-z0-9_-]{30,}/.test(bodyText), false);
check('系统替你配好的四项都在', await page.locator('.lg-gws-facts > div').count(), 4);
check('谁在用它列出了消费方', (await page.locator('.lg-gws-consumers > li').innerText()).includes('llmgw-console.intent-draft::chat'), true);

// 1a. 选池：提交体必须带 modelGroupId，且不带 modelName。
await page.locator('.lg-gws-sources > button', { hasText: '钉一个模型池' }).click();
await page.waitForTimeout(400);
check('选池后出现池下拉', await page.locator('.lg-gws-field select').count(), 1);
await page.locator('.lg-gws-field select').selectOption('pool-2');
await page.getByRole('button', { name: '保存设置' }).click();
await page.waitForTimeout(900);
check('选池的提交体', posted.at(-1), { method: 'PUT /system-settings', body: { modelSource: 'pool', modelGroupId: 'pool-2' } });

// 1b. 选模型：提交体必须带 modelName，且不带 modelGroupId。
await page.locator('.lg-gws-sources > button', { hasText: '钉一个模型' }).last().click();
await page.waitForTimeout(400);
await page.locator('.lg-gws-field select').selectOption('demo/chat-2');
await page.getByRole('button', { name: '保存设置' }).click();
await page.waitForTimeout(900);
check('选模型的提交体', posted.at(-1), { method: 'PUT /system-settings', body: { modelSource: 'model', modelName: 'demo/chat-2' } });

// 当场自测：成功时要说清耗时与真正执行的模型，不是一句「操作成功」。
await page.getByRole('button', { name: '测试连接' }).click();
await page.waitForTimeout(900);
check('测试通过时报出实际执行的模型', (await bodyScope.getByRole('status').last().innerText()).includes('demo/chat-1'), true);

// 3. 失败必须给得出下一步：不许只丢一个状态码。
testMode = 'fail';
await page.getByRole('button', { name: '测试连接' }).click();
await page.waitForTimeout(900);
const failText = await bodyScope.getByRole('alert').last().innerText();
check('测试失败说清了是密钥问题', failText.includes('密钥'), true);
check('测试失败给出了下一步', failText.includes('自动重签') || failText.includes('服务网关设置'), true);
check('测试失败不是裸状态码', /^\s*\d{3}\s*$/.test(failText), false);

// 窄屏不塌：三个来源按钮纵向排开，不出横向滚动条。
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
check('390 宽不出现横向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);

await browser.close();
server.close();
console.log(failures === 0 ? '\n服务网关设置验收全部通过。' : `\n有 ${failures} 条失败。`);
process.exit(failures === 0 ? 0 : 1);
