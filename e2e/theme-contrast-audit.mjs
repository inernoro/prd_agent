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

const AUDIT_FN = () => {
  const chan = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const parse = (s) => {
    const m = (s || '').match(/[\d.]+/g);
    return m ? { rgb: [+m[0], +m[1], +m[2]], a: m.length > 3 ? +m[3] : 1 } : null;
  };
  const over = (fg, bg) => fg.rgb.map((c, i) => Math.round(c * fg.a + bg[i] * (1 - fg.a)));

  const effectiveBg = (el) => {
    let node = el, needsEye = false;
    while (node && node.nodeType === 1) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') needsEye = true;
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0) {
        if (bg.a >= 1) return { bg: bg.rgb, needsEye };
        let p = node.parentElement, guard = 0, under = [255, 255, 255];
        while (p && guard++ < 40) {
          const pc = parse(getComputedStyle(p).backgroundColor);
          if (pc && pc.a >= 1) { under = pc.rgb; break; }
          p = p.parentElement;
        }
        return { bg: over(bg, under), needsEye };
      }
      node = node.parentElement;
    }
    return { bg: [255, 255, 255], needsEye };
  };

  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };

  const label = (el) => {
    const parts = [];
    let n = el, guard = 0;
    while (n && n.tagName !== 'BODY' && guard++ < 4) {
      if (n.id) { parts.unshift(`#${n.id}`); break; }
      const cls = (n.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      parts.unshift(n.tagName.toLowerCase() + (cls ? `.${cls}` : ''));
      n = n.parentElement;
    }
    return parts.join('>');
  };

  const out = [], seen = new Set();

  for (const el of document.querySelectorAll('body *')) {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText || !visible(el)) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const { bg, needsEye } = effectiveBg(el);
    const c = contrast(over(fg, bg), bg);
    const size = parseFloat(cs.fontSize);
    const need = (size >= 18.66 || (size >= 14 && +cs.fontWeight >= 700)) ? 3 : 4.5;
    if (c >= need) continue;
    const key = `${cs.color}|${bg}|${label(el)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = el.getBoundingClientRect();
    out.push({ kind: 'text', text: el.textContent.trim().slice(0, 24), sel: label(el),
      fg: cs.color, bg: `rgb(${bg})`, ratio: +c.toFixed(2), need, needsEye,
      box: { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) } });
  }

  for (const el of document.querySelectorAll('svg')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const raw = (cs.stroke && cs.stroke !== 'none') ? cs.stroke
      : (cs.fill && cs.fill !== 'none') ? cs.fill : cs.color;
    const fg = parse(raw);
    if (!fg || fg.a === 0) continue;
    const { bg, needsEye } = effectiveBg(el.parentElement || el);
    const c = contrast(over(fg, bg), bg);
    if (c >= 3) continue;
    const key = `svg|${raw}|${bg}|${label(el)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = el.getBoundingClientRect();
    out.push({ kind: 'icon', text: '', sel: label(el), fg: raw, bg: `rgb(${bg})`,
      ratio: +c.toFixed(2), need: 3, needsEye,
      box: { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) } });
  }

  return out.sort((a, b) => a.ratio - b.ratio).slice(0, 60);
};

const ROUTES = loadRoutes();
fs.mkdirSync(OUT, { recursive: true });
console.log(`路由 ${ROUTES.length} 条 × 双主题，产物目录 ${OUT}`);

const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
  ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}),
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.getByPlaceholder('admin').first().fill(USER);
await page.locator('input[type="password"]').first().fill(PASS);
await page.keyboard.press('Enter');
await page.waitForTimeout(3500);
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
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2600);
      const actual = await page.evaluate(() => document.documentElement.dataset.theme || 'dark');
      if (actual !== theme) { console.log(`  [跳过] ${route} 主题未生效(${actual})`); continue; }
      const findings = await page.evaluate(AUDIT_FN);
      if (findings.length) {
        const shot = `${theme}${route.replace(/\//g, '_')}.png`;
        await page.screenshot({ path: path.join(OUT, shot) });
        report.push({ theme, route, shot, findings });
      }
      console.log(`[${theme}] ${route.padEnd(30)} ${findings.length} 处`);
    } catch (e) {
      console.log(`[${theme}] ${route.padEnd(30)} ERROR ${String(e).split('\n')[0].slice(0, 70)}`);
    }
  }
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

// 按「同一组配色」聚合 —— 一个公共组件坏了会在几十个路由上重复报，聚合后才看得出病根
const byColor = new Map();
for (const r of report) {
  for (const f of r.findings) {
    const k = `${f.kind}|${f.fg}|${f.bg}`;
    if (!byColor.has(k)) byColor.set(k, { ...f, routes: new Set(), samples: [] });
    const g = byColor.get(k);
    g.routes.add(`${r.theme}:${r.route}`);
    if (g.samples.length < 3) g.samples.push(f.sel);
  }
}
const groups = [...byColor.values()]
  .map((g) => ({ ...g, routeCount: g.routes.size, routes: [...g.routes].slice(0, 6) }))
  .sort((a, b) => b.routeCount - a.routeCount || a.ratio - b.ratio);

const md = [
  '# 全站双主题对比度审计',
  '',
  `站点 ${BASE}｜路由 ${ROUTES.length} 条｜命中 ${report.reduce((s, r) => s + r.findings.length, 0)} 处｜配色组 ${groups.length}`,
  '',
  '## 按配色聚合（影响路由数从多到少 —— 排在前面的基本都是公共组件）',
  '',
  '| 影响路由数 | 类型 | 前景 | 背景 | 实测 | 需要 | 样例元素 |',
  '|---|---|---|---|---|---|---|',
  ...groups.slice(0, 40).map((g) =>
    `| ${g.routeCount} | ${g.kind} | \`${g.fg}\` | \`${g.bg}\` | ${g.ratio}:1 | ${g.need}:1 | \`${g.samples[0]}\` |`),
].join('\n');
fs.writeFileSync(path.join(OUT, 'report.md'), md);

console.log(`\n完成：${report.length} 个「路由×主题」命中，配色组 ${groups.length}`);
console.log(`报告：${path.join(OUT, 'report.md')} / report.json，截图同目录`);
await browser.close();
