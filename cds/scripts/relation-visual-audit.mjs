#!/usr/bin/env node
/*
 * 关系视图视觉审计（离线、真浏览器）：自起 vite dev、/api/* 走合成数据，按真人路径
 * 「分支列表 → 点分支卡打开详情 → 总览里的关系卡 → 点『展开』」逐档视口、双主题地量。
 *
 * 为什么要它：关系视图连着几轮「我截图看过、用户一打开又不对」。几何层（布局算得对不对）
 * 由 tests/web/relation-geometry.test.ts 管；这里管只有真浏览器才量得出来的那一层：
 * 字实际多宽、有没有被截、有没有横向滚动条、颜色对比度够不够、悬停联动有没有接上线。
 *
 * 判据（任一命中退出码非 0）：
 *   C1 关系卡不横向溢出抽屉；流向条两条泳道都没有被裁掉的部分（scrollWidth ≤ clientWidth）
 *   C2 被截断（省略号）的文字都带悬停提示，且至少还露出 48px
 *   C3 文字没有被挤成窄条：问题卡说明至少 200px 宽；任何 16 字以上的文字块不许被挤到 180px 以下、3 行以上
 *      （后一条不依赖任何标记，旧版组件上照样量得到——「一词一行」就是这么被抓出来的）
 *   C4 关系卡的流向条把每个服务与基础设施都列出来了（不折叠成「N 个服务」）
 *   S1 展开后的浮层整个落在视口里
 *   S2 关系图没有横向滚动条，图上的卡片互不重叠
 *   S3 每个服务与基础设施都画出来了
 *   S4 框标题不压卡片、不出框、没有线从字上穿过
 *   S5 宽屏（≥1280）下同构样本的服务名一个都不截断
 *   S6 悬停一条问题：它涉及的服务点亮，其余淡出
 *   S7 窄屏（<640）有建议时只先放要处理的，建议收成一行
 *   S8 按 Esc 关得掉浮层，且只关浮层（分支详情抽屉还在）
 *   F1 从关系卡点「全屏」进入的全屏页：整页不横向溢出、图不出横向滚动条、服务都画出来、卡片不重叠、对比度与截断同上
 *   T1 所有文字与背后底色的对比度 ≥ 4.5（≥18.66px 粗体或 ≥24px 时 ≥ 3）
 *   P1 页面没有报错；没有未登记的 /api 路径（避免页面拿空数据走空态而判据照绿）
 *
 * 用法：node scripts/relation-visual-audit.mjs [--out <dir>] [--fixture shape-alpha,dense] [--snapshot <topology.json>] [--no-shots]
 * 截图写进 --out（默认 /tmp/relation-visual-audit），不进仓库。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { startViteDevServer } from './lib/vite-dev-server.mjs';
import { resolveFixture, isEventStream, FIXTURE_PROJECT_ID } from './fixtures/mobile-layout-fixtures.mjs';
import { relationFixtures, loadSnapshot } from './fixtures/relation-fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || 'playwright');

const argValue = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const OUT = argValue('--out', '/tmp/relation-visual-audit');
const SHOTS = !process.argv.includes('--no-shots');
fs.mkdirSync(OUT, { recursive: true });

const ALL = relationFixtures();
const snapshot = argValue('--snapshot', '');
if (snapshot) ALL.snapshot = loadSnapshot(snapshot);
const wanted = argValue('--fixture', '').split(',').filter(Boolean);
const FIXTURES = Object.fromEntries(Object.entries(ALL).filter(([k]) => wanted.length === 0 || wanted.includes(k)));

const VIEWPORTS = [
  { label: '390', width: 390, height: 844 },
  { label: '768', width: 768, height: 1024 },
  { label: '1280', width: 1280, height: 800 },
  { label: '1440', width: 1440, height: 900 },
  { label: '1920', width: 1920, height: 1080 },
];
const THEMES = ['dark', 'light'];

const failures = [];
let checks = 0;
const check = (ok, where, message) => {
  checks += 1;
  if (!ok) failures.push(`${where}  ${message}`);
};

/* 在页面里跑的量具：都是只读测量，不改 DOM */
const MEASURE = () => {
  const parse = (str) => {
    if (!str || str === 'transparent') return [0, 0, 0, 0];
    let m = str.match(/rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = str.match(/color\(srgb ([^)]+)\)/);
    if (m) { const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
    return null;
  };
  const over = (top, bottom) => { const a = top[3]; return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 0.999) break; }
    }
    let acc = [255, 255, 255, 1];
    const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
    if (bodyBg && bodyBg[3] > 0.99) acc = bodyBg;
    for (let i = layers.length - 1; i >= 0; i -= 1) acc = over(layers[i], acc);
    return acc;
  };
  const opacityChain = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity || 1); return o; };
  return { parse, over, ratio, bgOf, opacityChain };
};

async function auditScope(page, where, scopeSel) {
  // T1 对比度 + C2 截断：扫作用域里每个直接带文字的可见元素
  const rows = await page.evaluate(([sel, measureSrc]) => {
    const M = new Function(`return (${measureSrc})()`)();
    const scope = document.querySelector(sel);
    if (!scope) return { missing: true };
    const out = { contrast: [], clipped: [], squeezed: [] };
    const all = [scope, ...scope.querySelectorAll('*')];
    for (const el of all) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
      if (!own) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (M.opacityChain(el) < 0.95) continue; // 悬停淡出态不算
      const isSvg = el instanceof SVGElement;
      const fg = M.parse(isSvg ? cs.fill : cs.color);
      if (!fg) continue;
      let bg = M.bgOf(isSvg ? el.closest('div') : el);
      if (isSvg) {
        const frameRect = el.closest('g[data-frame]')?.querySelector('rect');
        if (frameRect) {
          const f = M.parse(getComputedStyle(frameRect).fill);
          const fo = Number(frameRect.getAttribute('fill-opacity') ?? 1);
          if (f) bg = M.over([f[0], f[1], f[2], f[3] * fo], bg);
        }
      }
      const color = fg[3] < 1 ? M.over(fg, bg) : fg;
      const size = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const ratio = M.ratio(color, bg);
      if (ratio < need) out.contrast.push(`${own.slice(0, 40)} 对比度 ${ratio.toFixed(2)} < ${need}（${size}px）`);
      // C3（通用版，不依赖任何标记）：一段 16 字以上的文字被挤成不到 180px 宽、3 行以上的窄条
      if (!isSvg && own.length >= 16) {
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
        const lines = Math.round(r.height / lh);
        if (r.width < 180 && lines >= 3) out.squeezed.push(`「${own.slice(0, 30)}」被挤成 ${Math.round(r.width)}px 宽、${lines} 行`);
      }
      if (!isSvg && el.scrollWidth > el.clientWidth + 1 && /ellipsis/.test(cs.textOverflow)) {
        const titled = el.closest('[title]');
        if (!titled) out.clipped.push(`「${own.slice(0, 40)}」被截断但没有悬停提示`);
        else if (el.clientWidth < 48) out.clipped.push(`「${own.slice(0, 40)}」只露出 ${el.clientWidth}px`);
      }
    }
    return out;
  }, [scopeSel, MEASURE.toString()]);
  if (rows.missing) { check(false, where, `找不到 ${scopeSel}`); return; }
  check(rows.contrast.length === 0, where, `T1 对比度不足：${rows.contrast.slice(0, 6).join('；')}`);
  check(rows.clipped.length === 0, where, `C2 ${rows.clipped.slice(0, 6).join('；')}`);
  check(rows.squeezed.length === 0, where, `C3 文字被挤成窄条：${rows.squeezed.slice(0, 6).join('；')}`);
}

async function runCase(browser, url, fixtureName, payload, viewport, theme) {
  const where = `[${fixtureName} · ${viewport.label} · ${theme}]`;
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
  await context.addInitScript(`try{localStorage.setItem('cds_theme','${theme}')}catch(e){}`);
  const unknown = new Set();
  const pageErrors = [];
  await context.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (isEventStream(pathname)) { await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' }); return; }
    if (/\/service-graph$/.test(pathname)) { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }); return; }
    const body = resolveFixture(pathname);
    if (body === null) unknown.add(pathname);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body ?? {}) });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|EventSource|net::ERR/.test(m.text())) pageErrors.push(m.text()); });
  try {
    // 真人路径：分支列表 → 点分支卡
    await page.goto(`${url}/branches/${encodeURIComponent(FIXTURE_PROJECT_ID)}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('[aria-label^="打开 "][aria-label$=" 详情"]').first().click({ timeout: 20000 });
    const card = page.locator('[data-testid="relation-card"]:not([data-loading])').first();
    await card.waitFor({ timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(700); // chip 入场动画（最多 ~0.7s）走完再量

    // C1 关系卡不溢出、泳道不被裁
    const cardBox = await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const lanes = [...el.querySelectorAll('[data-testid="relation-strip-main"], [data-testid="relation-strip-subsites"]')].map((x) => ({ id: x.getAttribute('data-testid'), sw: x.scrollWidth, cw: x.clientWidth }));
      const drawer = el.closest('.cds-branch-detail-drawer') ?? document.body;
      return { right: r.right, left: r.left, drawerRight: drawer.getBoundingClientRect().right, sw: el.scrollWidth, cw: el.clientWidth, lanes };
    });
    check(cardBox.sw <= cardBox.cw + 1 && cardBox.right <= cardBox.drawerRight + 1 && cardBox.left >= 0, where, `C1 关系卡横向溢出（内容 ${cardBox.sw} / 可见 ${cardBox.cw}）`);
    for (const lane of cardBox.lanes) check(lane.sw <= lane.cw + 1, where, `C1 ${lane.id} 有被裁掉的部分（内容 ${lane.sw} / 可见 ${lane.cw}）`);
    // C4 流向条列全每个服务与基础设施
    const stripIds = await card.evaluate((el) => [...el.querySelectorAll('[data-testid="relation-strip"] [data-node]')].map((x) => x.getAttribute('data-node')));
    const expectStrip = payload.graph.nodes.map((n) => (n.kind === 'service' ? (n.rawId ?? n.id.replace(/^service:/, '')) : n.id));
    const missingStrip = expectStrip.filter((id) => !stripIds.includes(id));
    if (payload.graph.nodes.some((n) => n.kind === 'service')) check(missingStrip.length === 0, where, `C4 流向条漏了：${missingStrip.join('、')}`);
    // C3 问题卡说明的宽度
    const narrowest = await card.evaluate((el) => Math.min(Infinity, ...[...el.querySelectorAll('[data-finding] p')].map((p) => p.getBoundingClientRect().width)));
    check(narrowest === Infinity || narrowest >= 200, where, `C3 关系卡里的问题说明只有 ${Math.round(narrowest)}px 宽`);
    await auditScope(page, `${where} 关系卡`, '[data-testid="relation-card"]');
    if (SHOTS && fixtureName === 'shape-alpha') await card.screenshot({ path: path.join(OUT, `${fixtureName}-${viewport.label}-${theme}-card.png`) });

    // 点「展开」
    await card.getByRole('button', { name: '展开' }).click();
    const sheet = page.locator('[data-testid="relation-sheet"]');
    await sheet.locator('[data-node]').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(400);

    const sheetInfo = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="relation-sheet"]');
      const panel = root.querySelector(':scope > div:last-child');
      const r = panel.getBoundingClientRect();
      const graph = root.querySelector('[data-testid="relation-graph"]');
      const nodes = [...graph.querySelectorAll('[data-node]')].map((el) => ({ id: el.getAttribute('data-node'), r: el.getBoundingClientRect() }));
      const overlaps = [];
      for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i].r, b = nodes[j].r;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${nodes[i].id} × ${nodes[j].id}`);
      }
      // S4 框标题：不压卡片、不出框、没有线穿过
      const labelIssues = [];
      const paths = [...graph.querySelectorAll('path[d]')].filter((p) => p.closest('[data-edge]'));
      const samples = paths.map((p) => {
        const len = p.getTotalLength(); const m = p.getScreenCTM(); const pts = [];
        for (let s = 0; s <= len; s += 3) { const q = p.getPointAtLength(s); pts.push({ x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f }); }
        return { key: p.closest('[data-edge]').getAttribute('data-edge'), pts };
      });
      for (const t of graph.querySelectorAll('text[data-frame-title], text[data-frame-sub]')) {
        const tb = t.getBoundingClientRect();
        const frameRect = t.closest('g[data-frame]').querySelector('rect').getBoundingClientRect();
        const name = t.textContent;
        if (tb.left < frameRect.left || tb.right > frameRect.right + 0.5) labelIssues.push(`「${name}」超出框`);
        for (const n of nodes) if (tb.left < n.r.right && n.r.left < tb.right && tb.top < n.r.bottom && n.r.top < tb.bottom) labelIssues.push(`「${name}」压住卡片 ${n.id}`);
        for (const s of samples) if (s.pts.some((p) => p.x > tb.left + 1 && p.x < tb.right - 1 && p.y > tb.top + 1 && p.y < tb.bottom - 1)) labelIssues.push(`线 ${s.key} 穿过「${name}」`);
      }
      // S5 服务名是否被截
      const truncatedNames = [...graph.querySelectorAll('[data-node] [data-node-name]')].filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent);
      return {
        panel: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, vw: innerWidth, vh: innerHeight,
        graphScroll: { sw: graph.scrollWidth, cw: graph.clientWidth },
        ids: nodes.map((n) => n.id), overlaps, labelIssues: [...new Set(labelIssues)], truncatedNames,
      };
    });
    check(sheetInfo.panel.left >= -0.5 && sheetInfo.panel.top >= -0.5 && sheetInfo.panel.right <= sheetInfo.vw + 0.5 && sheetInfo.panel.bottom <= sheetInfo.vh + 0.5, where, `S1 浮层超出视口 ${JSON.stringify(sheetInfo.panel)}`);
    check(sheetInfo.graphScroll.sw <= sheetInfo.graphScroll.cw + 1, where, `S2 关系图有横向滚动条（内容 ${sheetInfo.graphScroll.sw} / 可见 ${sheetInfo.graphScroll.cw}）`);
    check(sheetInfo.overlaps.length === 0, where, `S2 卡片重叠：${sheetInfo.overlaps.slice(0, 5).join('；')}`);
    const drawn = new Set(sheetInfo.ids.map((id) => id.replace(/@.*$/, '')));
    const expected = payload.graph.nodes.map((n) => (n.kind === 'service' ? (n.rawId ?? n.id.replace(/^service:/, '')) : n.id));
    const missing = expected.filter((id) => !drawn.has(id));
    check(missing.length === 0, where, `S3 没画出来：${missing.join('、')}`);
    check(sheetInfo.labelIssues.length === 0, where, `S4 ${sheetInfo.labelIssues.slice(0, 5).join('；')}`);
    if (fixtureName === 'shape-alpha' && viewport.width >= 1280) check(sheetInfo.truncatedNames.length === 0, where, `S5 宽屏下服务名被截断：${sheetInfo.truncatedNames.join('、')}`);
    await auditScope(page, `${where} 展开视图`, '[data-testid="relation-sheet"]');
    const narrowestInSheet = await sheet.evaluate((el) => Math.min(Infinity, ...[...el.querySelectorAll('[data-finding] p')].map((p) => p.getBoundingClientRect().width)));
    check(narrowestInSheet === Infinity || narrowestInSheet >= 200, where, `C3 展开视图里的问题说明只有 ${Math.round(narrowestInSheet)}px 宽`);
    if (SHOTS && fixtureName === 'shape-alpha') await page.screenshot({ path: path.join(OUT, `${fixtureName}-${viewport.label}-${theme}-sheet.png`) });

    // S7 窄屏折叠
    const hasInfo = payload.lint.findings.some((f) => f.severity === 'info');
    const hasActionable = payload.lint.findings.some((f) => f.severity !== 'info');
    if (viewport.width < 640 && hasInfo && hasActionable) check(await sheet.locator('[data-testid="relation-findings-more"]').isVisible(), where, 'S7 窄屏上建议没有收成一行');

    // S6 悬停联动
    const target = sheet.locator('[data-finding][data-severity="warn"], [data-finding][data-severity="error"]').first();
    if (await target.count()) {
      const services = ((await target.getAttribute('data-finding-services')) ?? '').split(' ').filter(Boolean);
      check(services.length > 0, where, 'S6 问题卡没有标出涉及哪些服务（data-finding-services），悬停联动无从判断');
      await target.hover();
      // 等状态稳定再量，不用固定等待：卡片有 150ms 的过渡，且 hover 会先把问题卡滚进视野，
      // 固定等 350ms 在 1920 宽下偶发量到过渡中的值（2026-10-03 同一提交两次运行一红一绿）。
      // 最多等 2 秒：真没接上线照样红，只是不再受时机影响。
      await page.waitForFunction((ids) => {
        const nodes = [...document.querySelectorAll('[data-testid="relation-sheet"] [data-testid="relation-graph"] [data-node]')];
        const op = (el) => Number(getComputedStyle(el).opacity);
        const isRelated = (el) => ids.includes(el.getAttribute('data-node').replace(/@.*$/, ''));
        return nodes.some(isRelated) && nodes.every((el) => (isRelated(el) ? op(el) > 0.99 : op(el) < 0.5));
      }, services, { timeout: 2000, polling: 50 }).catch(() => {});
      const lit = await page.evaluate((ids) => {
        const nodes = [...document.querySelectorAll('[data-testid="relation-sheet"] [data-testid="relation-graph"] [data-node]')];
        const op = (el) => Number(getComputedStyle(el).opacity);
        const related = nodes.filter((el) => ids.includes(el.getAttribute('data-node').replace(/@.*$/, '')));
        return { related: related.map(op), others: nodes.filter((el) => !related.includes(el)).map(op), stay: nodes.filter((el) => !related.includes(el) && op(el) >= 0.5).map((el) => `${el.getAttribute('data-node')}=${op(el).toFixed(2)}`) };
      }, services);
      check(lit.related.length > 0 && lit.related.every((o) => o > 0.99), where, `S6 悬停问题后相关服务没点亮（${JSON.stringify(lit.related)}）`);
      check(lit.others.length === 0 || lit.others.every((o) => o < 0.5), where, `S6 悬停问题后无关服务没有淡出：${lit.stay.slice(0, 6).join('、')}（悬停的是 ${services.join(' ')}）`);
      if (SHOTS && fixtureName === 'shape-alpha' && theme === 'dark' && viewport.width === 1440) await page.screenshot({ path: path.join(OUT, `${fixtureName}-${viewport.label}-${theme}-hover.png`) });
      await page.mouse.move(2, 2);
    }

    // S8 Esc 关闭
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check((await sheet.count()) === 0, where, 'S8 按 Esc 关不掉展开视图');
    // Esc 只该关浮层：下面的分支详情抽屉与关系卡还在（此前一次 Esc 连抽屉一起关掉、退回分支列表）
    check(await card.isVisible(), where, 'S8 按 Esc 把分支详情抽屉也一起关掉了，用户被退回分支列表');

    // F1 全屏页：从关系卡点「全屏」进入（真人路径），整页不横向溢出、图不出横向滚动条、服务都画出来、卡片不重叠
    if ((await sheet.count()) === 0) {
      await card.getByRole('button', { name: '全屏' }).click();
      const full = page.locator('[data-testid="relation-workspace"] [data-testid="relation-graph"]');
      await full.locator('[data-node]').first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(300);
      const fp = await page.evaluate(() => {
        const graph = document.querySelector('[data-testid="relation-workspace"] [data-testid="relation-graph"]');
        const nodes = [...graph.querySelectorAll('[data-node]')].map((el) => ({ id: el.getAttribute('data-node'), r: el.getBoundingClientRect() }));
        let overlaps = 0;
        for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i].r, b = nodes[j].r;
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps += 1;
        }
        return { docSw: document.documentElement.scrollWidth, vw: innerWidth, gSw: graph.scrollWidth, gCw: graph.clientWidth, ids: nodes.map((n) => n.id), overlaps };
      });
      check(fp.docSw <= fp.vw + 1, where, `F1 全屏页整页横向溢出（${fp.docSw} / ${fp.vw}）`);
      check(fp.gSw <= fp.gCw + 1, where, `F1 全屏页关系图有横向滚动条（内容 ${fp.gSw} / 可见 ${fp.gCw}）`);
      check(fp.overlaps === 0, where, `F1 全屏页卡片重叠 ${fp.overlaps} 处`);
      const fdrawn = new Set(fp.ids.map((id) => id.replace(/@.*$/, '')));
      const fmissing = payload.graph.nodes.map((n) => (n.kind === 'service' ? (n.rawId ?? n.id.replace(/^service:/, '')) : n.id)).filter((id) => !fdrawn.has(id));
      check(fmissing.length === 0, where, `F1 全屏页没画出来：${fmissing.join('、')}`);
      await auditScope(page, `${where} 全屏页`, '[data-testid="relation-workspace"]');
      if (SHOTS && fixtureName === 'shape-alpha') await page.screenshot({ path: path.join(OUT, `${fixtureName}-${viewport.label}-${theme}-full.png`) });
    }
  } catch (err) {
    check(false, where, `流程中断：${err.message.split('\n')[0]}`);
    if (SHOTS) await page.screenshot({ path: path.join(OUT, `${fixtureName}-${viewport.label}-${theme}-ERROR.png`) }).catch(() => {});
  }
  check(pageErrors.length === 0, where, `P1 页面报错：${pageErrors.slice(0, 3).join(' | ')}`);
  check(unknown.size === 0, where, `P1 未登记的 /api 路径：${[...unknown].join('、')}`);
  await context.close();
}

async function main() {
  const executablePath = process.env.CDS_CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const dev = await startViteDevServer();
  let browser = null;
  const started = Date.now();
  try {
    browser = await chromium.launch({ args: ['--no-sandbox'], executablePath });
    for (const [name, payload] of Object.entries(FIXTURES)) {
      for (const viewport of VIEWPORTS) for (const theme of THEMES) await runCase(browser, dev.url, name, payload, viewport, theme);
      console.log(`${name}: ${VIEWPORTS.length * THEMES.length} 组跑完`);
    }
  } finally {
    if (browser) await browser.close();
    dev.stop();
  }
  const cases = Object.keys(FIXTURES).length * VIEWPORTS.length * THEMES.length;
  console.log(`\n关系视图视觉审计：${Object.keys(FIXTURES).length} 份样本 × ${VIEWPORTS.length} 档视口 × 2 个主题 = ${cases} 组，${checks} 项判据，用时 ${Math.round((Date.now() - started) / 1000)}s`);
  if (SHOTS) console.log(`截图：${OUT}`);
  if (failures.length) {
    console.log(`\n未通过 ${failures.length} 项：`);
    for (const f of failures) console.log(`  FAIL ${f}`);
    // CI 上同时写成 annotation：job 日志要另一个主机下载，annotation 走 API 就读得到。
    // 一步最多显示 10 条 error annotation，所以合并成一条、按 30 项截断
    if (process.env.GITHUB_ACTIONS) {
      const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
      const body = failures.slice(0, 30).join('\n') + (failures.length > 30 ? `\n……另有 ${failures.length - 30} 项` : '');
      console.log(`::error title=关系视图视觉审计未通过 ${failures.length} 项::${esc(body)}`);
    }
    process.exit(1);
  }
  console.log('全部通过');
}

main().catch((err) => {
  console.error(err);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=关系视图视觉审计崩溃::${String(err?.stack ?? err).slice(0, 2000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  process.exit(1);
});
