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
/** 测试连接桩的拖延时长：模拟真实那一次要等好几秒的调用，用来验等待期屏幕在动。 */
let testDelayMs = 0;
/** 保存桩的拖延时长：保存期间控件仍可编辑，用来验「这一小段里改的选择」不会被读回来的值盖掉。 */
let saveDelayMs = 0;
/*
  逻辑模型全集。第三条带 beyondPage 标记：不筛时它不在清单里（模拟排在 200 名之后），
  只有输关键字才够得着——「够不着」正是这条守卫要盯的那个静默缺陷。
*/
const ALL_MODELS = [
  { id: 'lm-1', publicId: 'demo/chat-1', name: '对话主力' },
  { id: 'lm-2', publicId: 'demo/chat-2', name: '实验模型' },
  { id: 'lm-far', publicId: 'demo/chat-far-behind', name: '排在两百名之后的模型', beyondPage: true },
];
/** 桩里的「符合条件总数」：页面必须如实说出还剩多少条没列出来。 */
const MODEL_TOTAL = 240;
/** 当前系统级设置，PUT 之后 GET 要能读回改后的值。 */
let settings = { modelSource: 'auto', modelGroupId: null, modelName: null };

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
  const p = requestUrl.pathname;
  if (p.startsWith('/llmgw/gw/')) {
    const api = p.replace('/llmgw/gw', '');
    if (api === '/auth/login') {
      return json(res, 200, { success: true, error: null, data: {
        token: 'stub', username: 'zhou', displayName: '周越', expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        mustChangePassword: false, tenant: { id: 't1', name: 'Miduo 平台', isInternal: false, role: 'owner', teamIds: ['team-1'] },
      } });
    }
    if (api === '/system-settings' && req.method === 'GET') {
      const modelQuery = (requestUrl.searchParams.get('q') || '').trim();
      const matchedModels = modelQuery
        ? ALL_MODELS.filter((m) => `${m.publicId} ${m.name}`.toLowerCase().includes(modelQuery.toLowerCase()))
        : ALL_MODELS.filter((m) => !m.beyondPage);
      return json(res, 200, { success: true, error: null, data: {
        ...settings,
        // 归属团队恒为系统自己的团队，不是登录者所属的业务团队——系统消耗单独计费。
        teamId: 't1_system',
        teamName: '系统内部',
        teamIsSystemOwned: true,
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
        // 显示名故意与 publicId 不同：页面若把显示名当模型名提交，下面那条断言立刻红。
        models: matchedModels.map(({ id, publicId, name }) => ({ id, publicId, name })),
        modelQuery,
        // 不筛时如实报总数（远大于回的条数）：页面据此说「还剩多少条」。筛过就报命中数。
        modelTotal: modelQuery ? matchedModels.length : MODEL_TOTAL,
        modelPageSize: 200,
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
        const reply = () => json(res, 200, { success: true, error: null, data: body });
        if (saveDelayMs > 0) setTimeout(reply, saveDelayMs);
        else reply();
      });
      return undefined;
    }
    if (api === '/system-settings/test') {
      posted.push({ method: 'POST /system-settings/test', body: null });
      const reply = () => json(res, 200, { success: true, error: null, data: testMode === 'ok'
        ? { ok: true, stage: 'done', elapsedMs: 412, servedModel: 'demo/chat-1', message: '通了：412 ms 内拿到回复，实际执行的是 demo/chat-1。' }
        : { ok: false, stage: 'invoke', elapsedMs: 88, message: '网关拒绝了系统自己的密钥（已失效或被撤销）。下次请求会自动重签一把；连续出现请在「服务网关设置」点一次「测试连接」看详情。' } });
      if (testDelayMs > 0) setTimeout(reply, testDelayMs);
      else reply();
      return undefined;
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
// 归属团队要说清是系统自己的团队 + 单独计费，否则用户无从判断这笔消耗记在谁头上。
const teamFact = await page.locator('.lg-gws-facts > div').last().innerText();
check('归属团队是系统内部', teamFact.includes('系统内部'), true);
check('归属团队说明了单独计费', teamFact.includes('单独计费'), true);
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
// 按显示名去选，提交体里应该出现的是 publicId——解析器只认它，显示名匹配不上会静默落到别的模型。
await page.locator('.lg-gws-field select').selectOption({ label: '实验模型' });
// 改完还没保存时，「测试连接」测的是库里那份旧配置，必须禁用，不能让人拿旧配置的成功当新配置的证明。
check('未保存时测试连接禁用', await page.getByRole('button', { name: '测试连接' }).isDisabled(), true);
await page.getByRole('button', { name: '保存设置' }).click();
await page.waitForTimeout(900);
check('选模型提交的是 publicId 不是显示名', posted.at(-1), { method: 'PUT /system-settings', body: { modelSource: 'model', modelName: 'demo/chat-2' } });
check('保存后测试连接恢复可点', await page.getByRole('button', { name: '测试连接' }).isDisabled(), false);

// 当场自测：成功时要说清耗时与真正执行的模型，不是一句「操作成功」。
await page.getByRole('button', { name: '测试连接' }).click();
await page.waitForTimeout(900);
check('测试通过时报出实际执行的模型', (await bodyScope.getByRole('status').last().innerText()).includes('demo/chat-1'), true);

/*
  ── 那条绿色结论只对「跑它时那份配置」有效 ──────────────────────
  改了来源/池/模型还留着它，页面就是「配置 B + 来自配置 A 的证明」——
  而这一页存在的理由正是让人当场确认**这份**配置能用。判据取「改完之后它还在不在」。
*/
const proofBefore = await bodyScope.getByRole('status').last().innerText();
check('改选择之前屏幕上确实挂着一条测试结论', proofBefore.includes('demo/chat-1'), true);
// 换的是「来源」这一档（此刻页面停在「钉一个模型」，池下拉里没有池选项）。
// 来源、池、模型三处改动同属一类，验一处即可——三处走的是同一个作废函数（源码守卫钉住）。
await page.getByRole('radio', { name: /交给网关挑/ }).click();
await page.waitForTimeout(300);
check('改了选择就撤下上一份配置的测试结论',
  (await bodyScope.getByRole('status').allInnerTexts()).some((text) => text.includes('demo/chat-1')), false);
// 选回原来那档：改动未保存时「测试连接」是禁用的（那条闸本来就该在），下面几步还要用它。
await page.getByRole('radio', { name: /固定用这一个模型/ }).click();
await page.waitForTimeout(300);
check('选回原选择后未保存态解除、测试连接恢复可点',
  await page.getByRole('button', { name: '测试连接' }).isDisabled(), false);

/*
  ── 作废在途那次测试之后，忙态必须收掉 ──────────────────────────
  代次判据把旧结论挡在门外是对的，但收忙态原来就挂在那条被挡掉的分支上：
  作废之后请求回来执行不到 setTesting(false)，计时器跟着 testing 跑，
  按钮永久停在「正在测试 N s」且禁用——只有刷新页面才能恢复。
  判据取「作废之后按钮还能不能点」，那正是用户会撞上的那一面。
*/
testDelayMs = 1500;
await page.getByRole('button', { name: '测试连接' }).click();
await page.waitForTimeout(300);
check('作废前那次测试确实在跑', /正在测试/.test(await bodyScope.locator('.lg-gws-actions button').first().innerText()), true);
await page.getByRole('radio', { name: /交给网关挑/ }).click();
await page.waitForTimeout(300);
check('作废在途测试后按钮立刻脱离「正在测试」',
  /正在测试/.test(await bodyScope.locator('.lg-gws-actions button').first().innerText()), false);
await page.waitForTimeout(1800);
await page.getByRole('radio', { name: /固定用这一个模型/ }).click();
await page.waitForTimeout(300);
check('被作废那次回来之后测试连接仍可点（没有卡在忙态）',
  await page.getByRole('button', { name: '测试连接' }).isDisabled(), false);
testDelayMs = 0;

// 4. 等待期屏幕必须在动（AGENTS.md 规则 #6）：真实那一次要等好几秒（后端单轮 40 秒上限，
//    还可能自动重签重试一轮）。按钮上要能读到已等秒数、且秒数真的在往前走——
//    停在一个不动的「正在测试」就是体验缺陷。
testDelayMs = 3200;
await page.getByRole('button', { name: '测试连接' }).click();
await page.waitForTimeout(400);
const waitingFirst = await bodyScope.locator('.lg-gws-actions button').first().innerText();
const waitingHint = await page.locator('.lg-gws-actions-hint').innerText();
await page.waitForTimeout(1600);
const waitingSecond = await bodyScope.locator('.lg-gws-actions button').first().innerText();
check('等待时按钮报出已等秒数', /正在测试\s+\d+s/.test(waitingFirst), true);
check('秒数在往前走（不是静止的正在测试）', waitingFirst !== waitingSecond, true);
check('等待时说清了此刻在做什么', waitingHint.includes('密钥') || waitingHint.includes('模型'), true);
await page.waitForTimeout(2000);
check('等完回到可点状态', await page.getByRole('button', { name: '测试连接' }).isDisabled(), false);
testDelayMs = 0;

// 3. 失败必须给得出下一步：不许只丢一个状态码。
testMode = 'fail';
await page.getByRole('button', { name: '测试连接' }).click();
await page.waitForTimeout(900);
const failText = await bodyScope.getByRole('alert').last().innerText();
check('测试失败说清了是密钥问题', failText.includes('密钥'), true);
check('测试失败给出了下一步', failText.includes('自动重签') || failText.includes('服务网关设置'), true);
check('测试失败不是裸状态码', /^\s*\d{3}\s*$/.test(failText), false);

/*
  ── 排在清单之后的模型必须够得着 ────────────────────────────────
  清单单次只回前 200 条。不给筛选的话，排在之后的模型在这一页等于不存在：
  页面不报错、下拉里就是没有它，用户只会以为系统不支持那个模型。
  判据取「输了关键字之后，它出不出现在可选项里」，那正是用户会撞上的那一面。
*/
const modelField = page.locator('.lg-gws-field');
check('清单被截断时如实说还剩多少', (await modelField.innerText()).includes(`共 ${MODEL_TOTAL} 个符合条件`), true);
check('没筛之前够不到排在后面的那个',
  await page.locator('.lg-gws-field option', { hasText: '排在两百名之后的模型' }).count(), 0);
await page.locator('.lg-gws-field input[type=search]').fill('far-behind');
await page.waitForTimeout(900);
check('输关键字之后它出现在可选项里',
  await page.locator('.lg-gws-field option', { hasText: '排在两百名之后的模型' }).count(), 1);
// 筛清单不是改配置：当前选中的那个不许被这次重读顶掉，也不许从下拉里消失。
check('筛清单不动用户当前的选择', await page.locator('.lg-gws-field select').inputValue(), 'demo/chat-2');
await page.locator('.lg-gws-field input[type=search]').fill('');
await page.waitForTimeout(900);

/*
  ── 保存期间改的选择，不许被读回来的旧值静默盖掉 ────────────────
  保存收尾会读回服务端那份并回填选择框。用户在这一小段里改的选择若被它顶掉，
  屏幕上显示的就是他没选的那个，`dirty` 还跟着归零——页面同时告诉他「已保存」。
  判据取「保存回来之后，选择框里是不是他最后选的那个」。
*/
saveDelayMs = 1200;
await page.locator('.lg-gws-field select').selectOption('demo/chat-1');
await page.getByRole('button', { name: '保存设置' }).click();
await page.waitForTimeout(250);
await page.locator('.lg-gws-field select').selectOption('demo/chat-2');
await page.waitForTimeout(1800);
check('保存期间改的选择没有被读回来的值盖掉',
  await page.locator('.lg-gws-field select').inputValue(), 'demo/chat-2');
check('并且如实说这份还没保存',
  (await bodyScope.getByRole('status').allInnerTexts()).some((t) => t.includes('还没保存')), true);
check('保存按钮回到可点（这份确实还没存）',
  await page.getByRole('button', { name: '保存设置' }).isDisabled(), false);
saveDelayMs = 0;

// 窄屏不塌：三个来源按钮纵向排开，不出横向滚动条。
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
check('390 宽不出现横向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);

await browser.close();
server.close();
console.log(failures === 0 ? '\n服务网关设置验收全部通过。' : `\n有 ${failures} 条失败。`);
process.exit(failures === 0 ? 0 : 1);
