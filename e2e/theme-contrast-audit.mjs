/**
 * 全站双主题对比度审计（Track A）
 *
 * 起因（2026-08-13）：浅色主题的配色缺陷靠「按清单逐屏人工验收」根本盖不住——
 * 全仓 271 个文件写死了为暗底设计的颜色，人翻页的覆盖率只有个位数百分比，
 * 于是「修一屏、下一页又崩一屏」。本脚本把验收方式换成程序化扫描：
 * 登录 → 遍历全部可直达路由 × 双主题 → 对每个**实际渲染出来**的文本/图标节点
 * 计算真实对比度 → 输出低于阈值的清单（路由 + 元素 + 实测值 + 截图坐标）。
 *
 * 用法：
 *   cd e2e && pnpm install && pnpm install-browsers      # 首次
 *   MAP_USER=xxx MAP_PASSWORD=xxx AUDIT_BASE=https://<预览域名> pnpm audit:contrast
 *
 * 可选：AUDIT_OUT（产物目录，默认 .audit）、AUDIT_ROUTES（自定义路由 JSON）
 *
 * 判据：
 *  - 文本 4.5:1；≥18.66px 或 ≥14px+bold 按 WCAG 大字号放宽到 3:1
 *  - 图标（svg）3:1（非文本元素下限）
 *  - 背景沿祖先链合成；碰到渐变/背景图标 needsEye，不武断判失败
 *
 * 注意：本脚本需要浏览器能访问预览域名。在无出网权限的沙箱里跑不了
 * （chromium 会 ERR_CONNECTION_RESET），请在能打开该站点的机器上跑。
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNodeFetchRoute } from '../.claude/skills/cds/cli/acceptance/proxyroute.mjs';
import { AUDIT_FN, aggregate, renderMarkdown, resampleGradientFindings } from './contrast-audit-core.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = path.join(REPO_ROOT, 'prd-admin');
const BASE = process.env.AUDIT_BASE;
const USER = process.env.MAP_USER;
const PASS = process.env.MAP_PASSWORD;
const OUT = process.env.AUDIT_OUT || path.join(REPO_ROOT, '.audit-contrast');

if (!BASE || !USER || !PASS) {
  console.error('缺少环境变量：AUDIT_BASE / MAP_USER / MAP_PASSWORD');
  process.exit(1);
}

/**
 * 路由清单：**navRegistry 与 App.tsx 两处都要读**。
 *
 * 只读 navRegistry 会漏掉直接写在 App.tsx 里的路由 —— 它们是嵌套写法
 * （`<Route path="skills">`，无前导斜杠），/skills、/weekly-poster、
 * /data-transfers、/notifications 四条都是这样，而这四个页面恰恰都被本 PR 改过。
 * 于是审计一边跳过我改的屏、一边报「覆盖完整、0 命中」
 * （Codex 在 PR #1374 第六轮抓到）。
 * 参数化（含 :）与通配（含 *）仍然跳过：它们要具体 id 才打得开。
 */
function loadRoutes() {
  if (process.env.AUDIT_ROUTES) return JSON.parse(fs.readFileSync(process.env.AUDIT_ROUTES, 'utf8'));
  const collect = (file, re) => {
    const src = fs.readFileSync(path.join(ADMIN, file), 'utf8');
    return [...src.matchAll(re)].map((m) => m[1]);
  };
  const fromRegistry = collect('src/app/navRegistry.tsx', /path:\s*'([^']+)'/g);
  const fromRouter = collect('src/app/App.tsx', /<Route\s+path="([^"]+)"/g);
  const all = [...fromRegistry, ...fromRouter]
    .map((p) => (p.startsWith('/') ? p : `/${p}`))   // App.tsx 的嵌套写法没有前导斜杠
    .filter((p) => p !== '/' && !p.includes(':') && !p.includes('*'));
  const list = [...new Set(all)].sort();
  const only = (process.env.AUDIT_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
  return only.length ? list.filter((p) => only.includes(p)) : list;
}

const ROUTES = loadRoutes();
fs.mkdirSync(OUT, { recursive: true });
console.log(`路由 ${ROUTES.length} 条 × 双主题，产物目录 ${OUT}`);

/*
 * 出网走「node fetch 桥接」，不要给 chromium 配 proxy。
 * 本沙箱的 chromium 自身网络栈穿不过 agent 出口代理（page.goto 直接 ERR_CONNECTION_RESET），
 * 但 node 的 fetch 在 NODE_USE_ENV_PROXY=1 下可以。installNodeFetchRoute 让 chromium 不配代理、
 * 改用 context.route 拦截全部请求交给 node fetch 取回 + cookie 双向桥接。
 * 解法沉淀在 .claude/skills/cds/cli/acceptance/proxyroute.mjs，别再重造。
 * 运行：NODE_USE_ENV_PROXY=1 MAP_USER=.. MAP_PASSWORD=.. AUDIT_BASE=.. node theme-contrast-audit.mjs
 */
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
await installNodeFetchRoute(ctx);
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'commit', timeout: 60000 });
await page.waitForTimeout(3500);
await page.locator('input[type="text"]').first().fill(USER);
await page.locator('input[type="password"]').first().fill(PASS);
await page.getByRole('button', { name: /进入控制台/ }).click();
await page.waitForTimeout(8000);
if (page.url().includes('/login')) {
  await page.screenshot({ path: path.join(OUT, 'login-failed.png') });
  console.error('登录失败，见 login-failed.png');
  await browser.close();
  process.exit(2);
}
console.log('登录 OK');

const report = [];
/*
 * 覆盖账本。此前跳过与报错只打一行日志就继续，最后照样打印「完成」、
 * 按 ROUTES.length 写报告、exit 0 —— 于是「主题没生效被跳过 4 条」
 * 和「全部扫完 0 命中」在输出里长得一样，我自己就据此报过「双主题 0 命中」。
 * 现在记账：任何一对没扫成，收尾时必须报出来并以非零码退出。
 */
const coverage = { done: [], skipped: [], errored: [] };
/*
 * 每个主题开一个全新 context，别在同一个 page 上反复 addInitScript。
 * init 脚本跨导航常驻且**互不覆盖**：跑到 dark 时 light 那份还在，两份都写
 * map-mobile-theme-v2，而 Playwright 明确说多份 init 脚本的执行顺序未定义 ——
 * 于是 dark 轮可能整轮落成 light、被判「主题未生效」全部跳过
 * （Codex 在 PR #1374 第三轮抓到）。
 * 登录态用 storageState 带过去，不必每个主题重登一次。
 */
const loggedInState = await ctx.storageState();
for (const theme of ['light', 'dark']) {
  const themeCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, storageState: loggedInState,
  });
  await installNodeFetchRoute(themeCtx);
  await themeCtx.addInitScript((t) => {
    localStorage.setItem('map-mobile-theme-v2', JSON.stringify({ state: { mode: t }, version: 0 }));
  }, theme);
  const page = await themeCtx.newPage();
  // 渲染期异常同样记账，理由见本地版注释：崩掉的页面不许算「已覆盖且干净」
  let pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(String(e).split('\n')[0].slice(0, 120)); });
  for (const route of ROUTES) {
    try {
      pageErrors = [];
      await page.goto(`${BASE}${route}`, { waitUntil: 'commit', timeout: 45000 });
      await page.waitForTimeout(5200);   // 真实数据渲染比空桩慢，给足时间否则扫到骨架屏
      /*
       * 先判渲染异常，再谈扫描：页面崩了渲染成错误边界，此时扫出来的命中
       * 全是错误边界自己的配色 —— 既污染数字，又会误导人去「修」一个错误页。
       * 必须在跑 AUDIT_FN 之前就把这一对判掉。
       */
      if (pageErrors.length) {
        coverage.errored.push(`${theme}${route}: 渲染异常 ${pageErrors[0]}`);
        console.log(`[${theme}] ${route.padEnd(30)} 渲染异常 ${pageErrors[0].slice(0, 50)}`);
        continue;
      }
      const actual = await page.evaluate(() => document.documentElement.dataset.theme || 'dark');
      if (actual !== theme) {
        coverage.skipped.push(`${theme}${route}（主题未生效，实际 ${actual}）`);
        console.log(`  [跳过] ${route} 主题未生效(${actual})`);
        continue;
      }
      let findings = await page.evaluate(AUDIT_FN);
      if (findings.length) {
        const shot = `${theme}${route.replace(/\//g, '_')}.png`;
        const buf = await page.screenshot({ path: path.join(OUT, shot) });
        /*
         * 渐变底必须用截图真实像素重算 —— 本地版一直有这一步，远端版漏了。
         * 元素坐在 radial-gradient 上时 backgroundColor 是透明的，祖先链推断会一路
         * 走到页面底，于是「深色渐变页上的浅色字」被误报成「浅字压暖纸」。
         * task-tree 自带整套深色皮肤（--tt-* + 深色渐变底），整页都栽在这上面；
         * 照着误报去改，等于把本来正确的浅字改成深字压深底 —— 造新 bug。
         */
        findings = await resampleGradientFindings(page, buf, findings);
        findings = findings.filter((f) => f.ratio < f.need);
        if (findings.length) report.push({ theme, route, shot, findings });
      }
      coverage.done.push(`${theme}${route}`);
      console.log(`[${theme}] ${route.padEnd(30)} ${findings.length} 处`);
    } catch (e) {
      coverage.errored.push(`${theme}${route}: ${String(e).split('\n')[0].slice(0, 90)}`);
      console.log(`[${theme}] ${route.padEnd(30)} ERROR ${String(e).split('\n')[0].slice(0, 70)}`);
    }
  }
  await themeCtx.close();
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

const groups = aggregate(report);
fs.writeFileSync(path.join(OUT, 'report.md'), renderMarkdown({
  title: '全站双主题对比度审计', base: BASE, routeCount: ROUTES.length, report, groups,
}));

const expected = ROUTES.length * 2;
console.log(`\n覆盖：${coverage.done.length}/${expected} 对「路由×主题」实际扫过`);
console.log(`命中：${report.length} 个「路由×主题」，配色组 ${groups.length}`);
console.log(`报告：${path.join(OUT, 'report.md')} / report.json，截图同目录`);
fs.writeFileSync(path.join(OUT, 'coverage.json'), JSON.stringify({ expected, ...coverage }, null, 2));

await browser.close();

/*
 * 覆盖不全就是不合格，不许当成「干净」。
 * 跳过与报错此前只打一行日志，最后照样 exit 0 —— 一次超时、一次主题没落上、
 * 一条路由挂了，输出看起来和「全扫完 0 命中」一模一样。
 * 报告里的数只有在这里绿了才有意义。
 */
/*
 * 有实测不达标就必须非零退出。
 * 原来只在「覆盖不全」时才失败 —— 全部路由都跑通、但报告里躺着一堆真实缺陷时，
 * 这条命令照样 exit 0，CI 或调用方会把它当绿灯（Codex 在 PR #1374 第十轮抓到）。
 * 覆盖与命中是两件事，各自都能让这次审计不合格。
 */
const realFindings = report.reduce((n, r) => n + r.findings.filter((f) => !f.unresolved).length, 0);
if (realFindings) {
  console.error(`\n[不合格] 实测不达标 ${realFindings} 处，详见 report.md / report.json`);
}
if (coverage.skipped.length || coverage.errored.length) {
  console.error(`\n[不合格] ${coverage.skipped.length + coverage.errored.length} 对没扫成，本轮结果不能当作「已覆盖」：`);
  for (const x of coverage.skipped) console.error(`  跳过  ${x}`);
  for (const x of coverage.errored) console.error(`  报错  ${x}`);
  console.error('\n明细见 coverage.json。修掉原因后重跑，或在交付里明写这几屏未覆盖。');
  process.exit(1);
}
if (realFindings) process.exit(1);
