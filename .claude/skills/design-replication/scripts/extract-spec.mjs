#!/usr/bin/env node
/**
 * 从**已渲染的页面**里量出设计系统规格：颜色 / 圆角 / 字号 / 字重 / 字族 / 字距 / 间距 / 阴影
 * 的真实取值与出现频次，外加该范围内逐条可见文案。
 *
 * 为什么必须量而不是看：肉眼读截图只能读出「圆角小一点、标题粗一点」，写代码时就变成
 * 自己拍的数值；而设计稿里 radius 其实只有 5/6/9/10/11/12 这几档、字号只有
 * 10/10.5/11.5/13/14.5/22 这几档。档位表是能机械量出来的事实，量出来再写组件，
 * 就不会每屏靠感觉调（这正是「用规格代替像素」那条成因的根治手段）。
 *
 * 同一个脚本对设计稿和实现页都跑，产出可直接 diff（见 audit.mjs）。
 *
 * 用法：
 *   node extract-spec.mjs --url <地址> --out <目录> \
 *     [--scope '<CSS 选择器>'] [--y-from 0 --y-to 1800] \
 *     [--vendor <React UMD 目录>] [--storage <storageState.json>] \
 *     [--width 1600] [--theme dark] [--wait 12000] \
 *     [--fixtures <目录> | --record-fixtures <目录>]
 *
 * --fixtures 用设计样例数据渲染实现页，让 text.txt 与设计稿的文案可以直接比
 * （否则两边跑的是不同数据，覆盖率里混着大量「其实是数据不同」的假缺失）。
 *
 * 取范围的两种方式（设计稿用后者，实现页用前者或不给）：
 *   --scope     只统计该选择器子树内的元素
 *   --y-from/to 只统计文档坐标落在该纵向区间的元素（配合 extract-design 的 index.json
 *               里每个画板的 top / height，就能单独量某一个画板）
 *
 * 产出（--out 目录下）：
 *   spec.json  机器可读：每个维度的 {value, count, sample} 列表 + 文案数组
 *   spec.md    人读：每个维度一张频次表，降序
 *   text.txt   该范围内逐条可见文案（叶子节点，去重前的原始顺序）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { installFixtures } from './fixtures.mjs';

const { chromium } = createRequire(path.join(process.cwd(), 'noop.js'))('playwright');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : process.argv[i + 1];
}
const url = arg('--url');
const out = arg('--out');
const scope = arg('--scope', null);
const yFrom = Number(arg('--y-from', '0'));
const yTo = Number(arg('--y-to', '0')) || Number.MAX_SAFE_INTEGER;
const vendor = arg('--vendor', null);
const storage = arg('--storage', null);
const width = Number(arg('--width', '1600'));
const theme = arg('--theme', 'dark');
const wait = Number(arg('--wait', '12000'));
const fixturesDir = arg('--fixtures', null) || arg('--record-fixtures', null);
const fixturesMode = process.argv.includes('--record-fixtures') ? 'record' : 'replay';
if (!url || !out) {
  console.error('必填：--url --out');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

// 浏览器路径按目录名探测，不写死版本号——写死会在升级 Playwright 后静默退化成
// 「找不到就用默认下载路径」，而容器里根本没有下载过。
const CHROME = process.env.CHROME_BIN
  || (fs.existsSync('/opt/pw-browsers')
    ? fs.readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-'))
      .map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find((p) => fs.existsSync(p))
    : undefined);

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await browser.newContext({
  viewport: { width, height: 1000 },
  deviceScaleFactor: 1,
  colorScheme: theme === 'light' ? 'light' : 'dark',
  storageState: storage && fs.existsSync(storage) ? storage : undefined,
});
const page = await ctx.newPage();

// 先装 fixture 再装 vendor：Playwright 后注册的 route 先匹配，
// 顺序反了接口请求会被 vendor 那几条规则之外的默认路径放走。
let fixtures = null;
if (fixturesDir) {
  fixtures = await installFixtures(page, { dir: fixturesDir, mode: fixturesMode });
}

if (vendor) {
  const files = fs.readdirSync(vendor);
  await page.route('**://unpkg.com/**', async (route) => {
    const u = route.request().url();
    const hit = files.find((f) => u.includes(f.replace(/\.min\.js$/, '')) || u.endsWith(f));
    return hit
      ? route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(vendor, hit)) })
      : route.abort();
  });
}
await page.route('**://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
await page.route('**://fonts.gstatic.com/**', (r) => r.abort());

await page.goto(url, { waitUntil: 'load', timeout: 90000 });
await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
await page.waitForTimeout(wait);

if (fixtures) {
  const r = fixtures.report();
  if (fixturesMode === 'record') console.log(`录到 ${r.recorded.length} 条接口响应 → ${fixturesDir}`);
  else {
    console.log(`样例数据命中 ${r.served.length} 条`);
    // 混合态（一半 fixture 一半真数据）下量出来的文案清单没有可比性，
    // 直接判失败而不是打条 warning —— warning 会被顺手忽略，然后拿混合态的数字去谈覆盖率。
    if (r.missed.length) {
      console.error(`${r.missed.length} 条接口没有样例数据、走了真网络：`
        + `${r.missed.slice(0, 8).join(' / ')}${r.missed.length > 8 ? ' …' : ''}`);
      console.error('这一屏是「一半样例一半真数据」的混合态，量出来的文案清单不能拿去比覆盖率。');
      console.error('要么把缺的那几条录进来（--record-fixtures），要么整屏都别用 fixture。');
      await browser.close();
      process.exit(4);
    }
  }
}

const chars = await page.evaluate(() => document.body.innerText.replace(/\s+/g, '').length);
if (chars < 200) {
  console.error(`正文只有 ${chars} 字，多半没渲染出来。量出来的规格会是一份空表——空表比没有更危险。`);
  await browser.close();
  process.exit(3);
}

const result = await page.evaluate(({ scopeSel, from, to }) => {
  const root = scopeSel ? document.querySelector(scopeSel) : document.body;
  if (!root) return { error: `选择器 ${scopeSel} 没命中任何元素` };
  const all = [root, ...root.querySelectorAll('*')];

  const bump = (map, value, el) => {
    if (!value) return;
    let rec = map.get(value);
    if (!rec) {
      // sample 记一个可定位的样子，方便回头去页面里找到这个值是谁用的
      const cls = (el.getAttribute?.('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      rec = { value, count: 0, sample: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}` };
      map.set(value, rec);
    }
    rec.count += 1;
  };

  const dims = {
    color: new Map(),
    background: new Map(),
    borderColor: new Map(),
    borderWidth: new Map(),
    radius: new Map(),
    fontSize: new Map(),
    fontWeight: new Map(),
    fontFamily: new Map(),
    letterSpacing: new Map(),
    lineHeight: new Map(),
    gap: new Map(),
    padding: new Map(),
    boxShadow: new Map(),
  };
  const texts = [];

  const NOISE = new Set(['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'transparent', '0px 0px 0px 0px']);
  const px = (v) => {
    const m = String(v).trim().match(/^(-?[\d.]+(?:e[+-]?\d+)?)px$/i);
    return m ? Number(m[1]) : null;
  };

  for (const el of all) {
    const r = el.getBoundingClientRect();
    const y = r.top + window.scrollY;
    if (y < from || y >= to) continue;
    // 完全不可见的元素不计入档位表：它们的默认值会把真实档位淹掉
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);

    bump(dims.color, cs.color, el);
    if (!NOISE.has(cs.backgroundColor)) bump(dims.background, cs.backgroundColor, el);
    if (cs.borderTopWidth !== '0px') {
      bump(dims.borderColor, cs.borderTopColor, el);
      bump(dims.borderWidth, cs.borderTopWidth, el);
    }
    // 全圆角有三种等价写法（50% / 9999px / 巨大 px），归一成 pill，
    // 否则设计稿写 50%、实现写 9999px 会被判成两档不同的圆角（形状 1：语义相同写法不同）
    if (!NOISE.has(cs.borderRadius)) {
      const parts = cs.borderRadius.split(/\s+/);
      const round = parts.some((p) => (p.endsWith('%') && parseFloat(p) >= 50) || (px(p) !== null && px(p) >= 999));
      bump(dims.radius, round ? 'pill' : cs.borderRadius, el);
    }
    bump(dims.fontSize, cs.fontSize, el);
    bump(dims.fontWeight, cs.fontWeight, el);
    // 字族只取第一个（后面全是 fallback 栈，统计意义不大）
    bump(dims.fontFamily, (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(), el);
    if (!NOISE.has(cs.letterSpacing)) bump(dims.letterSpacing, cs.letterSpacing, el);
    if (!NOISE.has(cs.lineHeight)) bump(dims.lineHeight, cs.lineHeight, el);
    if (cs.display.includes('flex') || cs.display.includes('grid')) {
      if (!NOISE.has(cs.gap)) bump(dims.gap, cs.gap, el);
    }
    const pad = `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`;
    if (pad !== '0px 0px 0px 0px') bump(dims.padding, pad, el);
    if (!NOISE.has(cs.boxShadow)) bump(dims.boxShadow, cs.boxShadow, el);

    // 取**自有文本节点**，不是「叶子节点的 textContent」：
    // 「叶子」口径会漏掉所有与 <svg> 图标同级的标签文字（`<span><svg/>HTML</span>` 不是叶子），
    // 而两边把图标放在不同层级时，同一句文案会被判成一边有一边没有 —— 假缺失，直接污染覆盖率。
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (own) texts.push(own);
  }

  const dump = (m) => [...m.values()].sort((a, b) => b.count - a.count);
  return {
    counts: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, dump(v)])),
    texts,
    elements: all.length,
  };
}, { scopeSel: scope, from: yFrom, to: yTo });

await browser.close();

if (result.error) {
  console.error(result.error);
  process.exit(4);
}

fs.writeFileSync(path.join(out, 'spec.json'), JSON.stringify({ url, scope, yFrom, yTo, theme, width, ...result }, null, 1));
fs.writeFileSync(path.join(out, 'text.txt'), `${result.texts.join('\n')}\n`);

const DIM_LABEL = {
  color: '文字色', background: '底色', borderColor: '描边色', borderWidth: '描边粗细',
  radius: '圆角', fontSize: '字号', fontWeight: '字重', fontFamily: '字族',
  letterSpacing: '字距', lineHeight: '行高', gap: '栅格间距', padding: '内边距', boxShadow: '阴影',
};
const md = ['# 设计系统规格（量出来的，不是读出来的）', '', `来源：${url}`, `范围：${scope || `y ${yFrom}~${yTo === Number.MAX_SAFE_INTEGER ? '末尾' : yTo}`} · 主题 ${theme} · 宽度 ${width}`, ''];
for (const [dim, rows] of Object.entries(result.counts)) {
  if (!rows.length) continue;
  md.push(`## ${DIM_LABEL[dim] || dim}（${rows.length} 档）`, '', '| 值 | 出现次数 | 样例元素 |', '|---|---|---|');
  for (const r of rows.slice(0, 24)) md.push(`| \`${r.value}\` | ${r.count} | ${r.sample} |`);
  if (rows.length > 24) md.push(`| …还有 ${rows.length - 24} 档，见 spec.json | | |`);
  md.push('');
}
fs.writeFileSync(path.join(out, 'spec.md'), `${md.join('\n')}\n`);

console.log(`元素 ${result.elements} 个 · 文案 ${result.texts.length} 条`);
for (const [dim, rows] of Object.entries(result.counts)) {
  if (rows.length) console.log(`  ${(DIM_LABEL[dim] || dim).padEnd(6)} ${String(rows.length).padStart(3)} 档  常见：${rows.slice(0, 4).map((r) => r.value).join(' / ')}`);
}
console.log(`\n规格：${path.join(out, 'spec.md')}`);
console.log('下一步：node tokens-map.mjs 把这些档位对到 tokens.css，缺的先补 token 再写组件。');
