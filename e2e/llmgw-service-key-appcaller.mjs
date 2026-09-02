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

// 登录身份可切：Owner 留空 teamId 是有意的租户级密钥，而 Developer 必须绑团队，
// 两档的正确行为不一样，所以要用同一套页面分别跑一遍。
let session = { role: 'owner', teamIds: ['team-1'] };

/*
  「翻不到的那一页」：页面开屏只拉第一页（上限 200 条），用途多过这个数的租户上，
  一条已停用的同码 appCaller 完全可能落在页外。这里就把它做成那种形态——
  不带 search 的列表里没有它，按它的 code 搜才搜得到。
*/
let pagedOutAppCaller = null;
/** 页面连搜都搜不到的那一条（超出一页的极端情形）：只有服务端的精确查询拦得住。 */
let serverSideDisabledCode = null;

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
  const p = requestUrl.pathname;
  if (p.startsWith('/llmgw/gw/')) {
    const api = p.replace('/llmgw/gw', '');
    if (req.method === 'GET' && api === '/app-callers') {
      const search = (requestUrl.searchParams.get('search') || '').trim().toLowerCase();
      const hit = pagedOutAppCaller && search && pagedOutAppCaller.appCallerCode.toLowerCase() === search
        ? [pagedOutAppCaller]
        : APP_CALLERS;
      return json(res, 200, { success: true, error: null, data: {
        ...LIST, items: hit, total: hit.length, statuses: [], sourceSystems: [], ingressProtocols: [], requestTypes: [],
      } });
    }
    if (api === '/auth/login') {
      return json(res, 200, { success: true, error: null, data: {
        token: 'stub', username: 'demo', displayName: 'Demo',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), mustChangePassword: false,
        tenant: { id: 't1', name: '演示租户', isInternal: false, role: session.role, teamIds: session.teamIds },
      } });
    }
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        posted.push({ api, body });
        if (api === '/app-callers') {
          // 服务端那次是**精确**身份查询（AppCallerCode + RequestType，无分页），
          // 页面搜不到的那条它照样查得到——所以拦截落在这里，不在页面。
          if (serverSideDisabledCode && serverSideDisabledCode === (body?.appCallerCode ?? '')) {
            return json(res, 409, { success: false, data: null, error: {
              code: 'APP_CALLER_DISABLED',
              message: `调用用途「${serverSideDisabledCode}」已存在，但处于「archived」状态，不接受流量。`,
            } });
          }
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

// 1) 中文用途拼不出拉丁字母时，那一段必须由用户自己给，不许系统替他挑一个常量。
//    以前这里退回固定的 `external-client.access::chat`：两套毫不相干的中文集成
//    （「桌面客户端」与「数据同步」）会塌成同一条 code，而登记端点对同团队同码是
//    幂等复用的——于是它们共用一条路由身份与一份预算，页面上还看不出来。
await nameInput.fill('测试环境');
await featureInput.fill('桌面客户端');
await page.waitForTimeout(120);
const slugInput = page.locator('input[aria-label="调用身份的英文标识"]');
check('中文用途会要一个英文标识', await slugInput.count(), 1);
check('还没给标识时拼不出 code', (await generatedCode()).includes('::'), false);
check('还没给标识时不能提交', await page.getByRole('button', { name: '生成 API Key' }).isDisabled(), true);

await slugInput.fill('desktop-client');
await page.waitForTimeout(120);
const chineseCode = await generatedCode();
check('给了标识才拼得出 code', chineseCode, 'external-client.desktop-client::chat');
check('中文档位的 code 过 console-api 判据', SELF_SERVICE_APP_CALLER.test(chineseCode), true);

// 同一份中文用途换一个标识必须换一条身份——这条才是上面那个洞的真正判据：
// 两套集成能不能被区分开，而不是「拼不拼得出一个合法 code」。
await featureInput.fill('数据同步');
await slugInput.fill('data-sync');
await page.waitForTimeout(120);
const otherChineseCode = await generatedCode();
check('另一套中文集成拿到的是另一条身份', otherChineseCode === chineseCode, false);
check('另一条身份同样合法', SELF_SERVICE_APP_CALLER.test(otherChineseCode), true);

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

// 6.5) 停用的同码 appCaller 落在第一页之外：判据必须问服务端，不能翻手上那一页。
//      翻页那种写法在小租户上永远是绿的——一条都没漏，因为总共就那么几条；
//      用途多过一页的租户上它必然判空，于是这道闸整条跳过、密钥照签，
//      而 serving 当场回 APP_CALLER_DISABLED：页面刚把一把注定用不了的 key 交出去。
posted.length = 0;
await page.getByRole('button', { name: '新建密钥' }).click();
await page.waitForSelector('.lg-service-key-form');
await nameInput.fill('paged-out-client');
await page.locator('input[aria-label="调用用途"]').fill('desktop');
await page.waitForTimeout(200);
const pagedOutCode = await generatedCode();
pagedOutAppCaller = { ...APP_CALLERS[0], id: 'ac-paged-out', appCallerCode: pagedOutCode, status: 'archived' };
await page.getByRole('button', { name: '生成 API Key' }).click();
await page.waitForTimeout(1200);
check('页外的停用同码被查出来：一个写请求都不许发', posted.map((item) => item.api), []);
check('并说清为什么不签', (await page.locator('.lg-page-body').innerText()).includes('不接受流量'), true);
pagedOutAppCaller = null;
await page.getByRole('button', { name: '取消' }).click();
await page.waitForTimeout(200);

// 6.6) 连搜索都翻不到时（匹配超过一页、目标排在页外）：拦截必须由服务端兜住。
//      页面那次 search 是模糊正则、按页截断，本来就不是精确身份查询；
//      而幂等创建那一步在服务端是精确的（AppCallerCode + RequestType，无分页），
//      所以它必须拒绝，而不是把那条停用身份原样返回——返回了，下一步就是拿它签 key。
posted.length = 0;
await page.getByRole('button', { name: '新建密钥' }).click();
await page.waitForSelector('.lg-service-key-form');
await nameInput.fill('invisible-client');
await page.locator('input[aria-label="调用用途"]').fill('desktop');
await page.waitForTimeout(200);
serverSideDisabledCode = await generatedCode();
await page.getByRole('button', { name: '生成 API Key' }).click();
await page.waitForTimeout(1200);
check('服务端拒绝后不再签发密钥', posted.map((item) => item.api), ['/app-callers']);
check('把服务端给的原因原样告诉用户', (await page.locator('.lg-page-body').innerText()).includes('不接受流量'), true);
serverSideDisabledCode = null;
await page.getByRole('button', { name: '取消' }).click();
await page.waitForTimeout(200);

// 7) 多团队 Developer：留空团队时，服务端不会替他推断（只有「刚好一个团队」才推），
//    Developer 又不允许租户级密钥，于是密钥这一步会被 TEAM_SCOPE_REQUIRED 挡回来——
//    而上一步的调用用途已经登记出去了，留下一条没有密钥的孤儿登记。
//    所以页面必须替他把两个请求落在同一个团队上。
posted.length = 0;
session = { role: 'developer', teamIds: ['team-9', 'team-1'] };
const devPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await devPage.goto(`${base}/service-keys`);
await devPage.waitForSelector('#llmgw-username');
await devPage.fill('#llmgw-username', 'dev');
await devPage.fill('#llmgw-password', 'dev');
await devPage.click('button[type=submit]');
await devPage.waitForURL('**/llmgw/service-keys');
await devPage.waitForTimeout(600);
await devPage.getByRole('button', { name: '新建密钥' }).click();
await devPage.waitForSelector('.lg-service-key-form');
await devPage.locator('.lg-service-key-fast-fields input').first().fill('dev-multi-team');
await devPage.locator('input[aria-label="调用用途"]').fill('desktop');
await devPage.waitForTimeout(120);
await devPage.getByRole('button', { name: '生成 API Key' }).click();
await devPage.waitForTimeout(1200);
const devCaller = posted.find((item) => item.api === '/app-callers')?.body ?? {};
const devKey = posted.find((item) => item.api === '/service-keys')?.body ?? {};
check('多团队 Developer 的用途登记落在身份自己的团队', devCaller.teamId, 'team-9');
check('多团队 Developer 的密钥与用途落在同一个团队', devKey.teamId, devCaller.teamId);

await browser.close();
server.close();

if (failures.length) {
  console.error(`\n${failures.length} 条断言失败：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\n接入密钥 appCallerCode 生成验收全部通过。');
