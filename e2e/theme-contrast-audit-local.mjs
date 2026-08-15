/**
 * 全站双主题对比度审计 · 本地 dist 版（无需出网 / 无需后端）
 *
 * 与 theme-contrast-audit.mjs（远端版）判据完全一致，共用 contrast-audit-core.mjs。
 * 区别：本版把 prd-admin 的构建产物挂在 127.0.0.1 上，并把 /api/* 打成空数据桩，
 * 因此**不需要浏览器出网、也不需要跑后端**——适合在没有出网权限的沙箱里跑。
 *
 * 覆盖范围（老实说清楚）：
 *   覆盖：外壳、导航、页头、按钮、分段控件、图标、空状态、加载态、弹层触发前的静态配色
 *   不覆盖：列表被真实数据填满之后的行（卡片、表格行、头像、封面图上的文字）
 *          —— 那部分只能用远端版对着真站点跑。
 *
 * 用法：
 *   cd prd-admin && pnpm build
 *   cd ../e2e && node theme-contrast-audit-local.mjs
 * 可选：AUDIT_OUT（默认 <repo>/.audit-contrast-local）、AUDIT_PORT（默认 5673）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { AUDIT_FN, aggregate, renderMarkdown, resampleGradientFindings } from './contrast-audit-core.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = path.join(REPO_ROOT, 'prd-admin');
const DIST = process.env.AUDIT_DIST || path.join(ADMIN, 'dist');
const OUT = process.env.AUDIT_OUT || path.join(REPO_ROOT, '.audit-contrast-local');
const PORT = Number(process.env.AUDIT_PORT || 5673);

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`找不到构建产物 ${DIST}/index.html —— 请先 cd prd-admin && pnpm build`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

/*
 * 路由清单：navRegistry 与 App.tsx 两处都要读（同远端版，判据见那边注释）。
 * 只读 navRegistry 会漏掉 App.tsx 里的嵌套写法（`<Route path="skills">`，无前导斜杠），
 * /skills、/weekly-poster、/data-transfers、/notifications 四条都是这样。
 */
const ROUTES = (() => {
  const collect = (file, re) => {
    const src = fs.readFileSync(path.join(ADMIN, file), 'utf8');
    return [...src.matchAll(re)].map((m) => m[1]);
  };
  // `/` 显式留着，理由同远端版：它原本只靠三条重定向路由顺带扫到，排除重定向后会变成零覆盖
  const all = [
    ...collect('src/app/navRegistry.tsx', /path:\s*'([^']+)'/g),
    ...collect('src/app/App.tsx', /<Route\s+path="([^"]+)"/g),
    '/',
  ]
    .map((p) => (p.startsWith('/') ? p : `/${p}`))
    .filter((p) => !p.includes(':') && !p.includes('*'));
  const list = [...new Set(all)].sort();
  // AUDIT_ONLY=/a,/b 只跑指定路由（冒烟用）
  const only = (process.env.AUDIT_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
  return only.length ? list.filter((p) => only.includes(p)) : list;
})();

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

/**
 * 路由守卫要的权限码，从 navRegistry 现读 —— 桩里给不全就会被「无权限访问」挡住，
 * 整轮扫描只能扫到一屏错误页（第一次跑就是这么废掉的）。
 */
const ALL_PERMISSIONS = (() => {
  const src = fs.readFileSync(path.join(ADMIN, 'src/app/navRegistry.tsx'), 'utf8');
  const codes = new Set(['access']);
  for (const m of src.matchAll(/'([a-z][a-z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+)'/g)) codes.add(m[1]);
  return [...codes];
})();

/** /api/* 空数据桩：返回项目的 ApiResponse 形状，尽量让页面渲染出空状态而不是崩掉。 */
function stubApi(url, res) {
  const data = url.includes('/authz/me')
    ? { userId: 'audit', username: 'audit', isRoot: true, menu: [], cdnBaseUrl: '', permFingerprint: 'audit',
        // 字段名必须是 effectivePermissions —— RouteGuards 只读这个
        effectivePermissions: ALL_PERMISSIONS, permissions: ALL_PERMISSIONS }
    : { items: [], list: [], entries: [], records: [], data: [], total: 0, count: 0, page: 1, pageSize: 20 };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true, data, error: null }));
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url.startsWith('/api/') || url.startsWith('/gw/')) return stubApi(url, res);
  const rel = url === '/' ? 'index.html' : url.replace(/^\//, '');
  const file = path.join(DIST, rel);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  }
  // SPA fallback
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fs.readFileSync(path.join(DIST, 'index.html')));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${PORT}`;
console.log(`本地静态服务 ${BASE}（dist=${DIST}）｜路由 ${ROUTES.length} 条 × 双主题`);

const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
});
// context/page 改为**每个主题各开一份**（见下方循环），这里不再建共享的那一份

const report = [];
// 覆盖账本，同远端版：跳过/报错不许静默吞掉（判据见 theme-contrast-audit.mjs 收尾处注释）
const coverage = { done: [], skipped: [], errored: [], redirected: [] };
/*
 * 每个主题开一个全新 context —— 同远端版：init 脚本跨导航常驻且互不覆盖，
 * 跑到 dark 时 light 那份还在，两份都写 map-mobile-theme-v2 而执行顺序未定义，
 * dark 轮可能整轮落成 light 被判「主题未生效」跳过。
 */
for (const theme of ['light', 'dark']) {
  const themeCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await themeCtx.newPage();
  /*
   * 渲染期异常必须记账，不能一律吞掉。
   * 组件在桩数据下崩溃会渲染成错误边界，导航仍算成功、AUDIT_FN 照扫不误、
   * 该「路由×主题」照样进 coverage.done —— 一个崩掉的页面就这样变成
   * 「已覆盖且干净」（Codex 在 PR #1374 第六轮抓到）。
   * 收进 pageErrors，由每条路由自己判定；确属桩数据不可避免的异常再逐条加白名单。
   */
  let pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(String(e).split('\n')[0].slice(0, 120)); });
  await themeCtx.addInitScript(({ theme: t, perms }) => {
    localStorage.setItem('map-mobile-theme-v2', JSON.stringify({ state: { mode: t }, version: 0 }));
    localStorage.setItem('prd-admin-auth', JSON.stringify({
      state: {
        isAuthenticated: true, token: 'audit', refreshToken: 'audit', sessionKey: 'audit',
        user: { userId: 'audit', username: 'audit', userType: 'Human' },
        permissions: perms, permissionsLoaded: true, isRoot: true,
        menuCatalog: [], menuCatalogLoaded: true, cdnBaseUrl: '', permFingerprint: 'audit',
      },
      version: 0,
    }));
  }, { theme, perms: ALL_PERMISSIONS });

  for (const route of ROUTES) {
    try {
      pageErrors = [];
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1800);
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
      // 落地在哪就是扫了哪，判据与远端版同（见那边注释：三条重定向路由曾把首页命中计了三次）
      const landed = await page.evaluate(() => location.pathname);
      if (landed !== route) {
        coverage.redirected.push(`${theme}${route} → ${landed}`);
        console.log(`  [重定向] ${route} → ${landed}，不计入覆盖`);
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
        // 渐变/背景图上的元素：祖先链推断出的底色是假的，改用截图真实像素重算
        findings = await resampleGradientFindings(page, buf, findings);
        findings = findings.filter((f) => f.ratio < f.need);   // 重算后达标的直接剔除
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

const groups = aggregate(report);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT, 'report.md'), renderMarkdown({
  title: '全站双主题对比度审计（本地 dist + API 桩）',
  base: BASE, routeCount: ROUTES.length, report, groups,
  note: '本轮用空数据桩，覆盖外壳/导航/按钮/图标/空状态；列表被真实数据填满后的行需用远端版复扫。',
}));
const expected = ROUTES.length * 2;
console.log(`\n覆盖：${coverage.done.length}/${expected} 对「路由×主题」实际扫过`);
console.log(`命中：${report.length} 个「路由×主题」，配色组 ${groups.length}`);
// 参数化路由从来没被扫过，必须写在脸上（判据同远端版，见那边注释）
const parameterized = [...new Set([
  ...[...fs.readFileSync(path.join(ADMIN, 'src/app/navRegistry.tsx'), 'utf8').matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]),
  ...[...fs.readFileSync(path.join(ADMIN, 'src/app/App.tsx'), 'utf8').matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]),
])].filter((p) => p.includes(':'));
console.log(`未覆盖：参数化路由 ${parameterized.length} 条（要真实 id 才打得开）`);
if (coverage.redirected.length) {
  console.log(`未覆盖：重定向路由 ${coverage.redirected.length} 对（请求 A 落到 B，不计入 A）`);
}
console.log(`报告：${path.join(OUT, 'report.md')}`);
fs.writeFileSync(path.join(OUT, 'coverage.json'), JSON.stringify({ expected, parameterized, ...coverage }, null, 2));
await browser.close();
server.close();

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
// 重定向进不合格判定，但只算「落地页没人扫」的那些（判据同远端版，见那边注释）
const unscannedRedirects = coverage.redirected.filter((x) => !ROUTES.includes(x.split(' → ')[1]));
if (coverage.skipped.length || coverage.errored.length || unscannedRedirects.length) {
  console.error(`\n[不合格] ${coverage.skipped.length + coverage.errored.length + unscannedRedirects.length} 对没扫成，本轮结果不能当作「已覆盖」：`);
  for (const x of coverage.skipped) console.error(`  跳过  ${x}`);
  for (const x of coverage.errored) console.error(`  报错  ${x}`);
  for (const x of unscannedRedirects) console.error(`  重定向到无人扫描的页面  ${x}`);
  process.exit(1);
}
if (realFindings) process.exit(1);
