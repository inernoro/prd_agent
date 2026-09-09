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
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
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
  await page.waitForSelector('text=看到我，算你有福了', { timeout: 20000 });
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(600);

  const step = {};
  step['落地页大标题'] = await page.locator('h1', { hasText: '看到我，算你有福了' }).isVisible();
  step['痛点药方表'] = await page.locator('text=什么都不跟我说，代码规范，构建发布').first().isVisible();
  step['卷一默认展开有书'] = await page.locator('text=《你的灯亮着吗？》').first().isVisible();
  await page.screenshot({ path: `${OUT}/01-landing-${theme}.png` });

  // 痛点卡必须落到各自对应的卷 —— 全都跳同一处等于药方表没接线。
  await page.locator('button', { hasText: '很多我都审不出来' }).first().click();
  await page.waitForTimeout(900);
  step['痛点跳到卷七'] = await page.locator('h3', { hasText: '卷七 · 上台面' }).first().isVisible();
  step['卷七书目展开'] = await page.locator('text=《金字塔原理》').first().isVisible();
  await page.locator('button', { hasText: '项目改的我都不想看了' }).first().click();
  await page.waitForTimeout(900);
  step['另一痛点跳到卷五'] = await page.locator('text=《修改代码的艺术》').first().isVisible();
  await page.screenshot({ path: `${OUT}/02-volume-expanded-${theme}.png` });

  const examBtn = page.locator('button', { hasText: '考这一卷' }).first();
  await examBtn.scrollIntoViewIfNeeded();
  await examBtn.click();
  await page.waitForTimeout(800);
  step['考卷弹出'] = await page.locator('text=结业考').first().isVisible();
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
  step['交卷后出分'] = /\d+\s*\/\s*\d+\s*题\s*——\s*(通过|未通过)/.test(body);
  step['解析出现'] = body.includes('答对了。') || body.includes('为什么不是你选的那个');
  await page.screenshot({ path: `${OUT}/04-exam-result-${theme}.png`, fullPage: true });

  const fails = Object.entries(step).filter(([, v]) => !v).map(([k]) => k);
  if (fails.length) allOk = false;
  report.push({ theme, step });
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
