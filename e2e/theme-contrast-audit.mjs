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
  /*
   * `/` 必须显式留着。
   * 它此前被 `p !== '/'` 过滤掉，靠 /login、/stats、/prd-agent 三条重定向路由
   * 「顺带」扫到——而那三条一旦按落地地址正确排除，首页就变成零覆盖：
   * 全站最重要的一屏一次都没量过，报告还显示满覆盖。
   * 排除重定向与补回 `/` 必须同一次改完，只做前一半是把重复计数换成漏扫。
   */
  const all = [...fromRegistry, ...fromRouter, '/']
    .map((p) => (p.startsWith('/') ? p : `/${p}`))   // App.tsx 的嵌套写法没有前导斜杠
    .filter((p) => !p.includes(':') && !p.includes('*'));
  const list = [...new Set(all)].sort();
  const only = (process.env.AUDIT_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
  return only.length ? list.filter((p) => only.includes(p)) : list;
}

/*
 * 视口是**第三个维度**，不是常数。
 * 此前两个入口都写死 1440×900，于是 App.tsx 里靠 useBreakpoint 分流的移动端分支
 * （MobileHomePage / MobileTabBar / MobileNotificationsPage / MobileSafeBoundary…）
 * 一屏都没渲染过 —— 而本 PR 恰好改了其中四个组件，审计却在报「双主题覆盖完整」
 * （Codex 在 PR #1374 第十八轮抓到）。
 * 默认两档都跑；迭代时用 AUDIT_VIEWPORTS=desktop 收窄。
 */
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};
const requestedViewports = (process.env.AUDIT_VIEWPORTS || 'desktop,mobile')
  .split(',').map((x) => x.trim()).filter(Boolean);
const unknownViewports = requestedViewports.filter((x) => !VIEWPORTS[x]);
const ACTIVE_VIEWPORTS = requestedViewports.filter((x) => VIEWPORTS[x]);
/*
 * 拼错一个名字就静默变成「零视口」：两层循环各跑 0 次、expected 也算成 0，
 * 于是一次**什么都没扫**的运行会以「无命中、无覆盖缺口」exit 0。
 * 配置打错字不该产出绿灯（Codex 在 PR #1374 第十九轮抓到）。
 */
if (unknownViewports.length || !ACTIVE_VIEWPORTS.length) {
  console.error(`AUDIT_VIEWPORTS 无效：${unknownViewports.join(', ') || '(空)'}；可选 ${Object.keys(VIEWPORTS).join(' / ')}`);
  process.exit(1);
}

const ROUTES = loadRoutes();
fs.mkdirSync(OUT, { recursive: true });
console.log(`路由 ${ROUTES.length} 条 × 双主题 × 视口 ${ACTIVE_VIEWPORTS.join("/")}，产物目录 ${OUT}`);

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

/*
 * 抽成函数是因为**跑到一半会掉登录**。
 * 一轮 80 条路由 × 每条 5.2s 要十几分钟，实测 light 轮第 55 条、dark 轮第 63 条
 * 之后全部被弹回 /login，27 对（占 162 的 17%）根本没量过。
 * 扫描循环里检测到落地 /login 就地重登一次再重试该路由，把这个洞堵上。
 */
async function login(p) {
  await p.goto(`${BASE}/login`, { waitUntil: 'commit', timeout: 60000 });
  await p.waitForTimeout(3500);
  await p.locator('input[type="text"]').first().fill(USER);
  await p.locator('input[type="password"]').first().fill(PASS);
  await p.getByRole('button', { name: /进入控制台/ }).click();
  await p.waitForTimeout(8000);
  return !p.url().includes('/login');
}

await login(page);
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
const coverage = { done: [], skipped: [], errored: [], redirected: [] };
/*
 * 每个主题开一个全新 context，别在同一个 page 上反复 addInitScript。
 * init 脚本跨导航常驻且**互不覆盖**：跑到 dark 时 light 那份还在，两份都写
 * map-mobile-theme-v2，而 Playwright 明确说多份 init 脚本的执行顺序未定义 ——
 * 于是 dark 轮可能整轮落成 light、被判「主题未生效」全部跳过
 * （Codex 在 PR #1374 第三轮抓到）。
 * 登录态用 storageState 带过去，不必每个主题重登一次。
 */
const loggedInState = await ctx.storageState();
for (const vpName of ACTIVE_VIEWPORTS) {
for (const theme of ['light', 'dark']) {
  const themeCtx = await browser.newContext({
    viewport: VIEWPORTS[vpName], ignoreHTTPSErrors: true, storageState: loggedInState,
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
        coverage.errored.push(`${vpName}/${theme}${route}: 渲染异常 ${pageErrors[0]}`);
        console.log(`[${vpName}/${theme}] ${route.padEnd(26)} 渲染异常 ${pageErrors[0].slice(0, 50)}`);
        continue;
      }
      /*
       * 落地在哪就是扫了哪 —— 请求了 A 却被重定向到 B，不许记成「A 已扫」。
       *
       * App.tsx 里 /prd-agent、/stats 是纯 `<Navigate to="/" replace />`，
       * /login 在已登录态下同样跳走。此前三条都被当成独立页面credit，实际扫的
       * 全是首页：同一轮里 /login 61 处、/stats 61 处、/prd-agent 61 处，
       * 三份逐条相同的首页命中被计了三次，凭空给总数灌进约 180 条
       * （Codex 在 PR #1374 第十二轮抓到）。
       * 记进 redirected 单列，不计入 done、findings 不进报告。
       */
      /*
       * 比的是 pathname 对 pathname —— route 可能带 query。
       * `AUDIT_ROUTES` 正是覆盖参数化/带 tab 页面的唯一入口（收尾处就是这么写的），
       * 而那类路径基本都带 query：`/open-platform?tab=open-api` 导航成功后
       * `location.pathname` 只有 `/open-platform`，直接拿它跟原串比就恒不相等，
       * 于是刚说「用 AUDIT_ROUTES 就能扫」的那批页面会被自己的重定向判据全部判成
       * 重定向跳过（Codex 在 PR #1374 第十五轮抓到）。导航仍用完整串。
       */
      const routePath = route.split(/[?#]/)[0];
      let landed = await page.evaluate(() => location.pathname);
      // 掉登录就地重登一次再重试本条（长跑必然掉，见 login() 上方注释）
      if (landed === '/login' && routePath !== '/login') {
        console.log(`  [重登] ${route} 被弹回登录页，重新登录后重试`);
        if (await login(page)) {
          pageErrors = [];
          await page.goto(`${BASE}${route}`, { waitUntil: 'commit', timeout: 45000 });
          await page.waitForTimeout(5200);
          /*
           * 重试这一次的渲染异常同样要判 —— 上面那道门在重试**之前**，
           * 重试渲染出的错误边界会绕过它，然后被照常扫描并计进 coverage.done，
           * 「崩掉的页面算干净」就从正常路径搬到了重试路径上
           * （Codex 在 PR #1374 第十六轮抓到；同一形状第三次出现）。
           */
          if (pageErrors.length) {
            coverage.errored.push(`${vpName}/${theme}${route}: 重登后渲染异常 ${pageErrors[0]}`);
            console.log(`[${vpName}/${theme}] ${route.padEnd(26)} 重登后渲染异常 ${pageErrors[0].slice(0, 40)}`);
            continue;
          }
          landed = await page.evaluate(() => location.pathname);
        }
      }
      if (landed !== routePath) {
        coverage.redirected.push(`${vpName}/${theme}${route} → ${landed}`);
        console.log(`  [重定向] ${route} → ${landed}，不计入覆盖`);
        continue;
      }
      const actual = await page.evaluate(() => document.documentElement.dataset.theme || 'dark');
      if (actual !== theme) {
        coverage.skipped.push(`${vpName}/${theme}${route}（主题未生效，实际 ${actual}）`);
        console.log(`  [跳过] ${route} 主题未生效(${actual})`);
        continue;
      }
      let findings = await page.evaluate(AUDIT_FN);
      if (findings.length) {
        const shot = `${vpName}_${theme}${route.replace(/\//g, '_')}.png`;
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
        if (findings.length) report.push({ viewport: vpName, theme, route, shot, findings });
      }
      coverage.done.push(`${vpName}/${theme}${route}`);
      console.log(`[${vpName}/${theme}] ${route.padEnd(26)} ${findings.length} 处`);
    } catch (e) {
      coverage.errored.push(`${vpName}/${theme}${route}: ${String(e).split('\n')[0].slice(0, 90)}`);
      console.log(`[${vpName}/${theme}] ${route.padEnd(26)} ERROR ${String(e).split('\n')[0].slice(0, 70)}`);
    }
  }
  await themeCtx.close();
}
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

const groups = aggregate(report);
fs.writeFileSync(path.join(OUT, 'report.md'), renderMarkdown({
  title: '全站双主题对比度审计', base: BASE, routeCount: ROUTES.length, report, groups,
}));

const expected = ROUTES.length * 2 * ACTIVE_VIEWPORTS.length;
console.log(`\n覆盖：${coverage.done.length}/${expected} 对「路由×主题」实际扫过`);
console.log(`命中：${report.length} 个「路由×主题」，配色组 ${groups.length}`);
/*
 * 参数化路由从来没被扫过，这件事必须写在脸上。
 * `loadRoutes` 过滤掉全部含 `:` 的路由（要具体 id 才打得开），而 expected 又是从
 * 过滤后的清单算的 —— 于是「132/160」看起来像满覆盖，实际 /review-agent/submissions/:id
 * 这类详情页一屏都没进过。数字不假，但标签会骗人（Codex 在 PR #1374 第十二轮抓到）。
 * 要覆盖它们得喂真实 id，走 AUDIT_ROUTES 传具体路径。
 */
const parameterized = [...new Set([
  ...[...fs.readFileSync(path.join(ADMIN, 'src/app/navRegistry.tsx'), 'utf8').matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]),
  ...[...fs.readFileSync(path.join(ADMIN, 'src/app/App.tsx'), 'utf8').matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]),
])].filter((p) => p.includes(':'));
console.log(`未覆盖：参数化路由 ${parameterized.length} 条（要真实 id 才打得开，用 AUDIT_ROUTES 传具体路径才能扫）`);
if (coverage.redirected.length) {
  console.log(`未覆盖：重定向路由 ${coverage.redirected.length} 对（请求 A 落到 B，不计入 A）`);
}
console.log(`报告：${path.join(OUT, 'report.md')} / report.json，截图同目录`);
fs.writeFileSync(path.join(OUT, 'coverage.json'), JSON.stringify({ expected, parameterized, ...coverage }, null, 2));

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
/*
 * 没量成的候选同样让本轮不合格 —— 只是理由不同，所以分开报。
 * unresolved = 渐变重采样时元素消失/取不出像素，它的真实比值**从来没测出来过**。
 * 此前 realFindings 显式把它排除，于是「其余全达标 + 一堆没量成」会 exit 0：
 * 一份需要人工复核的结果被当成绿灯（Codex 在 PR #1374 第十七轮抓到）。
 * 「实测不达标」与「没量成」是两种不合格，都不许静默通过。
 */
const unresolvedFindings = report.reduce((n, r) => n + r.findings.filter((f) => f.unresolved).length, 0);
if (realFindings) {
  console.error(`\n[不合格] 实测不达标 ${realFindings} 处，详见 report.md / report.json`);
}
if (unresolvedFindings) {
  console.error(`\n[不合格] ${unresolvedFindings} 处没量成（渐变重采样失败，真实比值未知），需人工复核`);
}
/*
 * 重定向也要进不合格判定，但只算「落地页没人扫」的那些。
 *
 * 上一轮把 redirected 单列出来却没接进这道门：`/login` `/stats` `/prd-agent`
 * 仍在 ROUTES 里、仍计进 expected，于是 coverage.done 永远小于 expected，
 * 而一次干净的审计照样 exit 0（Codex 在 PR #1374 第十三轮抓到）。
 *
 * 判据不是「有重定向就红」—— 那三条是**故意的别名**，落地的 `/` 本身就在清单里、
 * 会被独立扫一遍，覆盖并没有丢。一条永远红的门禁没人会看。
 * 真正的漏洞是「跳到一个谁也不扫的地方」：那一屏没人量过，必须红。
 */
const unscannedRedirects = coverage.redirected.filter((x) => {
  const landed = x.split(' → ')[1];
  /*
   * 掉登录页永远是失败，不能因为 `/login` 恰好也在 ROUTES 里就放行。
   *
   * 我上一版的判据是「落地页在清单里就算覆盖没丢」，看着讲得通，实测直接漏掉
   * 一个 27 对的大洞：审计跑到一半登录态失效，light 轮从第 55 条起、dark 轮从
   * 第 63 条起，其后每一条都被弹回 /login —— 而 `/login` 在 ROUTES 里，
   * 于是这 27 对「根本没量过」被我自己的判据判成了良性。
   * 别名跳转与掉登录是两回事：前者落地页确实有人扫，后者是这一屏没人扫。
   */
  if (landed === '/login') return true;
  // 同样比 pathname 对 pathname：ROUTES 里可能是带 query 的自定义路由
  return !ROUTES.some((r) => r.split(/[?#]/)[0] === landed);
});
if (coverage.skipped.length || coverage.errored.length || unscannedRedirects.length) {
  console.error(`\n[不合格] ${coverage.skipped.length + coverage.errored.length + unscannedRedirects.length} 对没扫成，本轮结果不能当作「已覆盖」：`);
  for (const x of coverage.skipped) console.error(`  跳过  ${x}`);
  for (const x of coverage.errored) console.error(`  报错  ${x}`);
  for (const x of unscannedRedirects) console.error(`  重定向到无人扫描的页面  ${x}`);
  console.error('\n明细见 coverage.json。修掉原因后重跑，或在交付里明写这几屏未覆盖。');
  process.exit(1);
}
if (realFindings || unresolvedFindings) process.exit(1);
