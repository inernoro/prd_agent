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

const ROUTES = (() => {
  const src = fs.readFileSync(path.join(ADMIN, 'src/app/navRegistry.tsx'), 'utf8');
  const all = [...src.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);
  return [...new Set(all.filter((p) => !p.includes(':') && !p.includes('*')))].sort();
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', () => {});   // 桩数据下组件报错属预期，不打断扫描

const report = [];
for (const theme of ['light', 'dark']) {
  // 预置登录态 + 主题；两者都走 localStorage，无需真实后端
  await ctx.clearCookies();
  await page.addInitScript(({ theme: t, perms }) => {
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
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1800);
      const actual = await page.evaluate(() => document.documentElement.dataset.theme || 'dark');
      if (actual !== theme) { console.log(`  [跳过] ${route} 主题未生效(${actual})`); continue; }
      let findings = await page.evaluate(AUDIT_FN);
      if (findings.length) {
        const shot = `${theme}${route.replace(/\//g, '_')}.png`;
        const buf = await page.screenshot({ path: path.join(OUT, shot) });
        // 渐变/背景图上的元素：祖先链推断出的底色是假的，改用截图真实像素重算
        findings = await resampleGradientFindings(page, buf, findings);
        findings = findings.filter((f) => f.ratio < f.need);   // 重算后达标的直接剔除
        if (findings.length) report.push({ theme, route, shot, findings });
      }
      console.log(`[${theme}] ${route.padEnd(30)} ${findings.length} 处`);
    } catch (e) {
      console.log(`[${theme}] ${route.padEnd(30)} ERROR ${String(e).split('\n')[0].slice(0, 70)}`);
    }
  }
}

const groups = aggregate(report);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUT, 'report.md'), renderMarkdown({
  title: '全站双主题对比度审计（本地 dist + API 桩）',
  base: BASE, routeCount: ROUTES.length, report, groups,
  note: '本轮用空数据桩，覆盖外壳/导航/按钮/图标/空状态；列表被真实数据填满后的行需用远端版复扫。',
}));
console.log(`\n完成：${report.length} 个「路由×主题」命中，配色组 ${groups.length}`);
console.log(`报告：${path.join(OUT, 'report.md')}`);
await browser.close();
server.close();
