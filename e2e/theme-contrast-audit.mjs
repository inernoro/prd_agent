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

/** 路由清单从 navRegistry 现读，避免维护第二份会漂移的拷贝。 */
function loadRoutes() {
  if (process.env.AUDIT_ROUTES) return JSON.parse(fs.readFileSync(process.env.AUDIT_ROUTES, 'utf8'));
  const src = fs.readFileSync(path.join(ADMIN, 'src/app/navRegistry.tsx'), 'utf8');
  const all = [...src.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]);
  return [...new Set(all.filter((p) => !p.includes(':') && !p.includes('*')))].sort();
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
for (const theme of ['light', 'dark']) {
  await page.addInitScript((t) => {
    localStorage.setItem('map-mobile-theme-v2', JSON.stringify({ state: { mode: t }, version: 0 }));
  }, theme);
  for (const route of ROUTES) {
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'commit', timeout: 45000 });
      await page.waitForTimeout(5200);   // 真实数据渲染比空桩慢，给足时间否则扫到骨架屏
      const actual = await page.evaluate(() => document.documentElement.dataset.theme || 'dark');
      if (actual !== theme) { console.log(`  [跳过] ${route} 主题未生效(${actual})`); continue; }
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
      console.log(`[${theme}] ${route.padEnd(30)} ${findings.length} 处`);
    } catch (e) {
      console.log(`[${theme}] ${route.padEnd(30)} ERROR ${String(e).split('\n')[0].slice(0, 70)}`);
    }
  }
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

const groups = aggregate(report);
fs.writeFileSync(path.join(OUT, 'report.md'), renderMarkdown({
  title: '全站双主题对比度审计', base: BASE, routeCount: ROUTES.length, report, groups,
}));

console.log(`\n完成：${report.length} 个「路由×主题」命中，配色组 ${groups.length}`);
console.log(`报告：${path.join(OUT, 'report.md')} / report.json，截图同目录`);
await browser.close();
