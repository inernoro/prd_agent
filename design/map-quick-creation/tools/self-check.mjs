// 作者自检：在还原的 CDS 预览容器里逐画面打开原型，收集控制台与 CSP 报错、截图，并计算测量类验收项；
// 人工 / 截图类验收项的结论来自 tools/walkthrough.json（作者逐画面走查的记录）。写 checks/result.json。
//
//   node tools/self-check.mjs --checkout <仓库根> [--shots <截图目录>]
//
// 容器还原：响应头 CSP 与桥接脚本取自 <仓库根>/cds/src/services/design-prototype.ts；原型放进 sandbox="allow-scripts" 的 iframe；
// 手机画面用 390×844 设备模拟（外层页面带 viewport meta，否则会按 980 宽排版）。
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2); const opt = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const checkout = path.resolve(opt('checkout') ?? path.join(dir, '..', '..'));
const shots = opt('shots') ? path.resolve(opt('shots')) : null;
if (shots) mkdirSync(shots, { recursive: true });
const require = createRequire(path.join(checkout, 'prd-admin', 'package.json'));
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = createRequire(import.meta.url)('playwright')); }

const design = JSON.parse(readFileSync(path.join(dir, 'design.json'), 'utf8'));
const walkthrough = existsSync(path.join(dir, 'tools/walkthrough.json')) ? JSON.parse(readFileSync(path.join(dir, 'tools/walkthrough.json'), 'utf8')) : {};
const ts = readFileSync(path.join(checkout, 'cds/src/services/design-prototype.ts'), 'utf8');
const csp = ts.match(/designPrototypeCsp = \[([\s\S]*?)\]\.join/)[1].match(/"([^"]+)"/g).map(s => s.slice(1, -1)).join('; ');
const bridge = ts.match(/const prototypeBridge = `([\s\S]*?)`;\n/)[1];
const raw = readFileSync(path.join(dir, design.prototype), 'utf8');
const head = raw.match(/<head(?:\s[^>]*)?>/i);
const html = raw.slice(0, head.index + head[0].length) + bridge + raw.slice(head.index + head[0].length);

/* ---------- 静态检查 ---------- */
const pageDir = path.join(dir, 'src/added/pages/quick-creation-agent');
const pageFiles = readdirSync(pageDir).filter(f => /\.(tsx?|css)$/.test(f));
const added = [...pageFiles.map(f => path.join(pageDir, f)), path.join(dir, 'src/added/services/real/quickCreation.ts')];
const read = f => readFileSync(f, 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const hexHits = pageFiles.filter(f => f !== 'TemplateFrames.tsx').flatMap(f => (strip(read(path.join(pageDir, f))).match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g) ?? []).map(m => `${f}: ${m}`));
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;
const emojiHits = added.filter(f => emoji.test(read(f))).map(f => path.basename(f));
const nav = read(path.join(dir, 'src/overrides/app/navRegistry.tsx'));
const navOk = /path: '\/quick-creation-agent'[\s\S]{0,600}?wip: true/.test(nav) && read(path.join(dir, 'src/overrides/toolboxStore.ts')).includes("id: 'builtin-quick-creation'");
const svc = strip(read(path.join(dir, 'src/added/services/real/quickCreation.ts')));
const fetchCount = (svc.match(/\bfetch\(/g) ?? []).length;
const svcOk = svc.includes("from '@/services/real/apiClient'") && fetchCount === 1 && /uploadQuickCreationAttachment[\s\S]*FormData[\s\S]*fetch\(/.test(svc);

/* ---------- 容器 ---------- */
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/proto')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp }); res.end(html); return; }
  const q = new URL(req.url, 'http://x').searchParams;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe id="f" sandbox="allow-scripts" src="/proto?theme=${q.get('theme')}${q.get('route') ?? ''}" style="border:0;width:100vw;height:100vh;display:block"></iframe></body></html>`);
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch();
const results = { screens: [], measures: {} };

const luminance = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

for (const screen of design.screens) {
  for (const theme of screen.themes) {
    const phone = screen.viewport === 'phone';
    const ctx = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) errors.push(`${m.type()}: ${m.text()}`.slice(0, 240)); });
    page.on('pageerror', e => errors.push(`pageerror: ${String(e).slice(0, 240)}`));
    await page.goto(`http://127.0.0.1:${port}/?theme=${theme}&route=${encodeURIComponent(screen.route)}`);
    const frame = page.frame({ url: /\/proto/ }) ?? page.frames()[1];
    const first = screen.entryActions?.length ? '[data-qc-ready]' : screen.entryReadySelector;
    try { await frame.waitForSelector(first, { timeout: 15000 }); } catch { errors.push(`未就绪：${first}`); }
    for (const action of screen.entryActions ?? []) {
      try { await frame.click(action, { timeout: 5000 }); await page.waitForTimeout(300); } catch { errors.push(`入口动作失败：${action}`); }
    }
    try { await frame.waitForSelector(screen.entryReadySelector, { timeout: 8000 }); } catch { errors.push(`未就绪：${screen.entryReadySelector}`); }
    await page.waitForTimeout(500);
    const m = await frame.evaluate(() => {
      const q = s => document.querySelector(s);
      const root = q('[data-qc-ready]');
      const style = getComputedStyle(document.documentElement);
      const tray = q('[data-qc=attachment-tray]');
      const toggle = q('[data-qc=tray-toggle]');
      const list = q('[data-qc=attachment-list]');
      const small = root ? [...root.querySelectorAll('button, a[href], input, textarea, [role=radio], [role=switch]')]
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; })
        .filter(el => el.getBoundingClientRect().height < 43.5 && !el.closest('[data-qc-touch-exempt]'))
        .map(el => `${el.tagName.toLowerCase()}「${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 14)}」${Math.round(el.getBoundingClientRect().height)}px`) : [];
      return {
        /* 页面在壳里：页面之外有壳的导航（来自菜单目录的「知识库 / 网页托管 / 百宝箱」） */
        inShell: !!root && [...document.querySelectorAll('a, button')].some(el => !root.contains(el) && /知识库|网页托管|百宝箱/.test(el.textContent || el.getAttribute('aria-label') || '')),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        small,
        text: document.body.innerText,
        vars: ['--text-primary', '--text-secondary', '--bg-base'].map(v => style.getPropertyValue(v).trim()),
        submitDisabled: q('[data-qc=submit]')?.disabled ?? null,
        blockReason: !!q('[data-qc=block-reason]'),
        trayHeight: tray ? Math.round(tray.getBoundingClientRect().height) : null,
        toggleHeight: toggle ? Math.round(toggle.getBoundingClientRect().height) : null,
        chips: tray && !list ? tray.querySelectorAll('[title]').length : null,
        plusN: tray ? /\+\d+/.test(tray.innerText) : null,
        listMax: list ? getComputedStyle(list).maxHeight : null,
        listFooter: tray?.innerText.match(/文字 [\d,]+ \/ 20,000 · 附件 \d+ \/ 10/)?.[0] ?? null,
      };
    });
    /* 颜色：页面里取到的令牌值，rgba 叠在底色上再算 */
    const toRgb = (value, base) => {
      const hex = value.match(/^#([0-9a-f]{6})$/i);
      if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16));
      const rgba = value.match(/rgba?\(([^)]+)\)/);
      if (!rgba) return null;
      const [r, g, b, a = 1] = rgba[1].split(',').map(Number);
      return base ? [r, g, b].map((c, i) => Math.round(c * a + base[i] * (1 - a))) : [r, g, b];
    };
    const bg = toRgb(m.vars[2]);
    const contrast = bg ? m.vars.slice(0, 2).map(v => { const c = toRgb(v, bg); return c ? Number(ratio(c, bg).toFixed(2)) : null; }) : [null, null];
    if (shots) await page.screenshot({ path: path.join(shots, `${screen.id}-${theme}.png`) });
    results.screens.push({ id: screen.id, theme, viewport: screen.viewport, errors, overflow: m.overflow, small: m.small, contrast, inShell: m.inShell,
      emojiInText: emoji.test(m.text), submitDisabled: m.submitDisabled, blockReason: m.blockReason, trayHeight: m.trayHeight, toggleHeight: m.toggleHeight, chips: m.chips, plusN: m.plusN, listMax: m.listMax, listFooter: m.listFooter });
    await ctx.close();
  }
}
await browser.close(); server.close();

const S = (id, theme) => results.screens.filter(s => s.id === id && (!theme || s.theme === theme));
const every = (rows, fn) => rows.length > 0 && rows.every(fn);
const measure = {
  'A-01': { pass: every(results.screens.filter(s => !s.id.startsWith('concept')), s => s.inShell), note: '每个画面都在 AppShell 主区内，壳的导航在页面之外' },
  'A-02': { pass: hexHits.length === 0, note: hexHits.length ? hexHits.join('；') : '页面源码（不含 TemplateFrames.tsx）无颜色字面量' },
  'A-03': { pass: every(S('done-video'), s => s.contrast.every(c => c != null && c >= 4.5)), note: S('done-video').map(s => `${s.theme}：正文 ${s.contrast[0]}，次要 ${s.contrast[1]}`).join('；') },
  'A-04': { pass: emojiHits.length === 0 && results.screens.every(s => !s.emojiInText), note: emojiHits.length ? emojiHits.join('、') : '源码与渲染文本无 emoji' },
  'A-06': { pass: every(results.screens.filter(s => s.viewport === 'phone'), s => s.overflow <= 0 && s.small.length === 0),
    note: results.screens.filter(s => s.viewport === 'phone').map(s => `${s.id}/${s.theme}：溢出 ${s.overflow}px${s.small.length ? '，小于 44px：' + [...new Set(s.small)].join('、') : ''}`).join('；') },
  'A-07': { pass: navOk, note: navOk ? 'navRegistry 有 /quick-creation-agent 与 wip: true；toolboxStore 有 builtin-quick-creation' : '缺少注册' },
  'A-10': { pass: svcOk, note: `apiRequest 封装；fetch 仅 ${fetchCount} 处（附件上传 FormData）` },
  'A-12': { pass: every(S('compose'), s => s.submitDisabled === true && s.blockReason), note: '无附件时快捷生成不可用，下方写原因' },
  'A-14': { pass: every(S('attachments'), s => s.trayHeight <= 88 && s.toggleHeight <= 28 && s.chips <= 2 && s.plusN), note: S('attachments').map(s => `${s.theme}：托盘 ${s.trayHeight}px，摘要行 ${s.toggleHeight}px，胶囊 ${s.chips}，+N ${s.plusN}`).join('；') },
  'A-16': { pass: every(S('attachments-expanded'), s => s.listMax === '232px' && !!s.listFooter), note: S('attachments-expanded').map(s => `${s.theme}：最大高度 ${s.listMax}，${s.listFooter}`).join('；') },
};
const errorsTotal = results.screens.reduce((n, s) => n + s.errors.length, 0);
const items = design.acceptance.map(a => {
  const auto = measure[a.id];
  const human = walkthrough[a.id];
  const status = auto ? (auto.pass ? 'passed' : 'failed') : human ? human.status : 'unverified';
  return { id: a.id, name: `${a.id}${a.ruleId ? ' ' + a.ruleId : ''} ${a.rule}`.slice(0, 160), pass: status === 'passed', note: auto ? `测量：${auto.note}` : human?.note ?? '未走查' };
});
items.push({ id: 'C-01', name: 'C-01 预览容器零报错（所有画面 × 主题）', pass: !errorsTotal, note: errorsTotal ? results.screens.filter(s => s.errors.length).map(s => `${s.id}/${s.theme}：${s.errors[0]}`).join('；') : `${results.screens.length} 次打开，控制台与 CSP 报错 0 条` });
/* 字段与 CDS 发布接口一致：runAt、browser、url、total、passed、items[{ id, name, pass, note }] */
const out = { runAt: new Date().toISOString().slice(0, 10), browser: 'Chromium（Playwright），本机还原 CDS 预览容器（正式 CSP 响应头 + decorateDesignPrototype 桥接脚本、sandbox="allow-scripts"），桌面 1440×900 与手机 390×844、浅色与深色', url: design.prototype, total: items.length, passed: items.filter(i => i.pass).length, items };
writeFileSync(path.join(dir, 'checks/result.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ passed: out.passed, total: out.total, failed: items.filter(i => !i.pass).map(i => `${i.id}: ${i.note}`.slice(0, 300)) }, null, 1));
