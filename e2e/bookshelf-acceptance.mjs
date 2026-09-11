// 公共藏书阁闭环验收：入口 -> 展开卷 -> 书目可见 -> 开考 -> 答题 -> 交卷 -> 分数与解析可见。
// 断言的是「产物真的出现在页面上」，不是「点击没报错」（.claude/rules/closed-loop-acceptance.md）。
// 双主题各跑一遍（.claude/rules/admin-dual-theme.md 第三节：只在单主题下测过的 UI 不许声称完成）。
//
// 用法：cd prd-admin && pnpm build && node ../e2e/bookshelf-acceptance.mjs
// 可选环境变量：BOOKSHELF_DIST / BOOKSHELF_OUT / BOOKSHELF_PORT / BOOKSHELF_CHROMIUM
//
// 路径一律从本文件位置推导，不写死任何机器的绝对路径（照抄 llmgw-page-acceptance.mjs 的教训：
// 写死作者机器路径后换个 checkout 就静态服务器指空目录、首次导航直接白屏）。
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.BOOKSHELF_DIST || path.join(REPO_ROOT, 'prd-admin', 'dist');
const OUT = process.env.BOOKSHELF_OUT || path.join(os.tmpdir(), 'bookshelf-acceptance');
const PORT = Number(process.env.BOOKSHELF_PORT || 5799);
const CHROMIUM = process.env.BOOKSHELF_CHROMIUM || undefined;

if (!fs.existsSync(DIST)) {
  console.error(`未找到构建产物：${DIST}\n请先在 prd-admin 执行 pnpm build，或用 BOOKSHELF_DIST 指定目录。`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml',
               '.woff2':'font/woff2','.woff':'font/woff','.png':'image/png','.json':'application/json' };
// 藏书阁的两个接口在这里照线上真实响应作答。
// 以前这里跟着 SPA fallback 返回 HTML，解析必失败、store 永远停在初始值——
// 于是「服务端真的返回了进度」这条线上唯一会走的路径，本地一次都没跑过。
const BOOKSHELF_DATA = {
  '/api/bookshelf/progress': { readBookIds: [], examResults: {}, updatedAt: null },
  '/api/bookshelf/team': { members: [], memberCount: 0, passedByVolume: {} },
};
// legacy = 后端曾经那种缺 error 键的返回。它不满足 apiClient 的 ApiResponse 判据，
// 2026-09-11 把整个藏书阁炸成「页面渲染出错」。留着当守卫：降级可以，崩掉不行。
let apiShape = 'ok';
function bookshelfBody(u) {
  const data = BOOKSHELF_DATA[u];
  return apiShape === 'legacy' ? { success: true, data } : { success: true, data, error: null };
}
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (BOOKSHELF_DATA[u]) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(bookshelfBody(u)));
  }
  let f = path.join(DIST, u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); // SPA fallback
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
const report = [];
let allOk = true;

for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  // 藏书阁不依赖后端数据，注入一个已登录态即可渲染；顺带清掉进度，保证每次从零开始。
  await page.addInitScript((t) => {
    localStorage.setItem('prd-admin-auth', JSON.stringify({
      state: {
        isAuthenticated: true,
        user: { id: 'e2e', username: 'e2e', displayName: '验收' },
        token: 'e2e-token', refreshToken: null, sessionKey: null,
        permissions: ['access'], permissionsLoaded: true, isRoot: true, menuCatalog: [],
      }, version: 0,
    }));
    localStorage.removeItem('bookshelf-progress');
    document.documentElement.setAttribute('data-theme', t);
  }, theme);

  await page.goto(`http://127.0.0.1:${PORT}/bookshelf`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1:has-text("算你有福了")', { timeout: 20000 });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(600);

  const step = {};
  // 粗野版这句回到 h1，且「看到我，」与「算你有福了」被 <br> 分成两行，
  // 整串匹配必失败 —— 按 h1 + 后半句断言。
  step['落地页大标题'] = await page.locator('h1').filter({ hasText: '算你有福了' }).first().isVisible();
  step['痛点药方表'] = await page.locator('text=代码规范、构建发布，没人告诉我该怎么做').first().isVisible();
  step['默认卷书目可见'] = await page.locator('text=《你的灯亮着吗？》').first().isVisible();
  await page.screenshot({ path: `${OUT}/01-landing-${theme}.png` });

  // 痛点卡必须落到各自对应的卷 —— 全都跳同一处等于药方表没接线。
  await page.locator('button', { hasText: '评审派给了看不出问题的人' }).first().click();
  await page.waitForTimeout(700);
  step['痛点跳到卷七'] = await page.locator('text=上台面').first().isVisible();
  step['卷七书目出现'] = await page.locator('text=《金字塔原理》').first().isVisible();
  await page.locator('button', { hasText: '代码越改越乱，不想再打开' }).first().click();
  await page.waitForTimeout(700);
  step['另一痛点跳到卷五'] = await page.locator('text=《修改代码的艺术》').first().isVisible();
  // 卷六要治的是「AI 在乱写、没人看」——它必须给得出「怎么审」的书，
  // 不能整卷都是模型原理。这一条盯着那批实操书，被删掉就会红。
  await page.locator('button', { hasText: 'AI 生成的代码没人细看就合进去了' }).first().click();
  await page.waitForTimeout(700);
  step['痛点跳到卷六'] = await page.locator('text=驭 AI').first().isVisible();
  step['卷六有怎么审 AI 的书'] = await page.locator('text=你的代码就是犯罪现场').first().isVisible()
    && await page.locator('text=代码阅读方法与实践').first().isVisible();
  await page.screenshot({ path: `${OUT}/02b-volume-ai-${theme}.png` });

  await page.screenshot({ path: `${OUT}/02-volume-expanded-${theme}.png` });

  // 一本没读时入口必须说自己是摸底 —— 「赴考/通关」那套关卡话术配上零门槛才是漏洞。
  step['没读时入口叫摸底不叫赴考'] =
    (await page.locator('button').filter({ hasText: '先摸个底' }).count()) > 0
    && (await page.locator('button').filter({ hasText: /赴\s*考/ }).count()) === 0;

  const examBtn = page.locator('button').filter({ hasText: /先摸个底|赴\s*考|再考/ }).first();
  await examBtn.scrollIntoViewIfNeeded();
  await examBtn.click();
  await page.waitForTimeout(800);
  step['考卷弹出'] = await page.locator('text=摸底测').first().isVisible();
  await page.screenshot({ path: `${OUT}/03-exam-open-${theme}.png` });

  // 全选 A 再交卷：故意不全对，好让解析出场（解析才是这套题存在的理由）。
  const opts = page.locator('button:has-text("A")');
  for (let i = 0; i < (await opts.count()); i++) {
    const o = opts.nth(i);
    if (await o.isVisible()) await o.click({ timeout: 3000 }).catch(() => {});
  }
  await page.waitForTimeout(300);
  await page.locator('button', { hasText: '交卷' }).first().click();
  await page.waitForTimeout(900);

  const body = await page.evaluate(() => document.body.innerText);
  step['交卷后出分'] = /\d+\s*\/\s*\d+\s*题\s*——\s*(通过|未通过|底子在|有缺口)/.test(body);
  step['解析出现'] = body.includes('答对了。') || body.includes('为什么不是你选的那个');
  // 裸考的结果页必须说清「这次量的是什么」并给出下一步该读哪本，否则考试还是个出口而非入口。
  step['裸考结果说清上下文'] = body.includes('一本没读的情况下考的');
  step['裸考结果给出先读哪本'] = body.includes('建议从这两本开始');
  await page.screenshot({ path: `${OUT}/04-exam-result-${theme}.png`, fullPage: true });

  const fails = Object.entries(step).filter(([, v]) => !v).map(([k]) => k);
  if (fails.length) allOk = false;
  report.push({ theme, step });
  await ctx.close();
}

// 守卫：上游返回畸形（缺 error 键的旧格式）时，看板降级但书单不许被带走。
apiShape = 'legacy';
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('prd-admin-auth', JSON.stringify({
      state: {
        isAuthenticated: true,
        user: { id: 'e2e', username: 'e2e', displayName: '验收' },
        token: 'e2e-token', refreshToken: null, sessionKey: null,
        permissions: ['access'], permissionsLoaded: true, isRoot: true, menuCatalog: [],
      }, version: 0,
    }));
    localStorage.removeItem('bookshelf-progress');
  });
  await page.goto(`http://127.0.0.1:${PORT}/bookshelf`, { waitUntil: 'domcontentloaded' });
  let survived = true;
  try {
    await page.waitForSelector('h1:has-text("算你有福了")', { timeout: 20000 });
  } catch { survived = false; }
  const crashed = await page.locator('text=页面渲染出错').first().isVisible().catch(() => false);
  const shelfOk = await page.locator('text=《你的灯亮着吗？》').first().isVisible().catch(() => false);
  const pass = survived && !crashed && shelfOk;
  if (!pass) allOk = false;
  console.log('');
  console.log('[畸形上游响应]');
  console.log(`  ${pass ? '通过' : '未通过'}  看板拿到畸形数据时页面不崩、书单照常可读`);
  await page.screenshot({ path: `${OUT}/03-legacy-response.png` });
  await ctx.close();
}

await browser.close();
server.close();
for (const r of report) {
  console.log(`\n[${r.theme}]`);
  for (const [k, v] of Object.entries(r.step)) console.log(`  ${v ? '通过' : '失败'}  ${k}`);
}
console.log(`\n截图：${OUT}`);
process.exit(allOk ? 0 : 1);
