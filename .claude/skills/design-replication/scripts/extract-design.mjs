#!/usr/bin/env node
/**
 * 从设计稿画布里**取证据**：画板清单 + 逐画板切图 + 逐画板逐字文案。
 *
 * 为什么要单独一步：复刻失手的头号成因不是手艺，是**手里根本没有设计稿的原始事实**。
 * 凭截图肉眼读文案会读漏读错（「上传网页」写成「上传站点」），凭记忆列画板会漏屏。
 * 这一步把三样东西固化成文件，后面每一步都拿文件对，不拿印象对。
 *
 * 用法：
 *   node extract-design.mjs --url <画布地址> --out <目录> \
 *     [--vendor <本地 React UMD 目录>] [--width 1600] [--dsf 2] \
 *     [--marker '^屏\\s*[0-9]'] [--max-part 1800]
 *
 * 产出（--out 目录下）：
 *   index.json         画板清单（id / 标签 / 位置 / 高度 / 切图文件名）
 *   <NN>-<slug>.png    逐画板切图；超高画板自动切成 partN，一张都不许糊成缩略图
 *   text-<id>.txt      该画板内所有可见文本，逐行、逐字，供文案 diff 用
 *
 * 画板识别顺序（前一种命中就不再往下试）：
 *   1. `[data-screen-label]` / `[data-artboard]` 属性（设计稿画布通常自带）
 *   2. 叶子节点文本匹配 --marker（默认 `屏 N`，中英通吃）
 *   3. 画布根下的直接 <section>
 * 三种都不中就报错退出——**宁可失败也不要输出一份「只有一个画板」的假清单**，
 * 那会让后面所有步骤都以为设计稿只有一屏（见 no-rootless-tree：不编）。
 */
import fs from 'node:fs';
import path from 'node:path';

// 用 playwright-core + 容器预装浏览器；解析顺序与失败提示收在 browser.mjs
import { launch } from './browser.mjs';

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : process.argv[i + 1];
}
const url = arg('--url');
const out = arg('--out');
const vendor = arg('--vendor');
const width = Number(arg('--width', '1600'));
const dsf = Number(arg('--dsf', '2'));
const marker = arg('--marker', '^(屏|Screen)\\s*[0-9]');
const maxPart = Number(arg('--max-part', '1800'));
if (!url || !out) {
  console.error('必填：--url --out');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });


const slug = (s) => s.replace(/[\s·（）()\/、,，:：]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

const browser = await launch();
const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: dsf });

// 画布 runtime 从 unpkg 取 React/Babel，容器里直连不通；本地缓存喂进去。
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
// 字体走网络会拖慢且可能挂起；缺字体不影响布局比对。
await page.route('**://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
await page.route('**://fonts.gstatic.com/**', (r) => r.abort());

await page.goto(url, { waitUntil: 'load' });
// 画布是运行时渲染的，load 之后还要给它画完
await page.waitForTimeout(12000);

const bodyChars = (await page.evaluate(() => document.body.innerText.replace(/\s+/g, '').length)) ?? 0;
if (bodyChars < 200) {
  console.error(`正文只有 ${bodyChars} 字，多半没渲染出来（vendor 没喂进去 / 还没画完）。截图存在不等于渲染成功。`);
  process.exit(3);
}

const found = await page.evaluate((markerSrc) => {
  const re = new RegExp(markerSrc);
  const abs = (el) => Math.round(el.getBoundingClientRect().top + window.scrollY);

  const cssQuote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const byAttr = [...document.querySelectorAll('[data-screen-label],[data-artboard]')].map((el) => {
    const attr = el.hasAttribute('data-screen-label') ? 'data-screen-label' : 'data-artboard';
    const label = el.getAttribute(attr) || '';
    return {
      label,
      y: abs(el),
      h: Math.round(el.getBoundingClientRect().height),
      via: 'attr',
      // 记下**精确选择器**：并排摆放的画板（同一行三个上传态）纵坐标完全相同，
      // 只按 y 区间切会把三屏混成一屏 —— 量出来的档位表是三屏的并集，
      // 看着有数、其实哪一屏都不对（形状 1：判据比它该管的范围窄）。
      scope: `[${attr}=${cssQuote(label)}]`,
    };
  });
  if (byAttr.length) return byAttr;

  const byMarker = [];
  document.querySelectorAll('*').forEach((el) => {
    if (el.children.length) return;
    const t = (el.textContent || '').trim();
    if (t && t.length < 90 && re.test(t)) byMarker.push({ label: t, y: abs(el), h: 0, via: 'marker' });
  });
  if (byMarker.length) return byMarker;

  const sections = [...document.querySelectorAll('body section')].map((el, i) => ({
    label: (el.querySelector('h1,h2,h3')?.textContent || `section-${i + 1}`).trim(),
    y: abs(el),
    h: Math.round(el.getBoundingClientRect().height),
    via: 'section',
  }));
  return sections;
}, marker);

if (!found.length) {
  console.error('识别不出任何画板。设计稿可能用了别的标注方式——用 --marker 传一个匹配画板标题的正则再试，不要凑合当成单画板。');
  process.exit(4);
}

found.sort((a, b) => a.y - b.y);
const pageHeight = await page.evaluate(() => document.body.scrollHeight);

// marker 形态只知道起点，画板高度 = 到下一个 marker 之前
const boards = found.map((b, i) => {
  const top = Math.max(0, b.y - 24);
  const bottom = b.h > 0 ? b.y + b.h : (found[i + 1] ? found[i + 1].y - 30 : pageHeight);
  return { ...b, id: `${String(i).padStart(2, '0')}-${slug(b.label)}`, top, height: Math.max(120, bottom - top) };
});

const index = [];
for (const b of boards) {
  // 超高画板切成多段：一张压缩到看不清字号的整图，等于没有证据
  const parts = Math.ceil(b.height / maxPart);
  const files = [];
  for (let p = 0; p < parts; p += 1) {
    const y = b.top + p * maxPart;
    const h = Math.min(maxPart, b.top + b.height - y);
    const file = parts === 1 ? `${b.id}.png` : `${b.id}-part${p + 1}.png`;
    await page.screenshot({ path: path.join(out, file), clip: { x: 0, y, width, height: h }, fullPage: true });
    files.push(file);
  }

  // 逐字文案：取每个元素的**自有文本节点**（不是叶子节点的 textContent）。
  // 父节点不会把整屏文本重复拼一遍，而与图标同级的标签文字（`<span><svg/>HTML</span>`）也不会漏。
  const texts = await page.evaluate(({ from, to, scopeSel }) => {
    const items = [];
    // 有精确选择器就在那棵子树里取；只有并排画板会暴露 y 区间的问题：
    // 同一行的三个上传态纵坐标完全相同，按 y 取会让三份文案文件内容一模一样
    // （都是三屏的并集）——而「三份都是 50 条」这种巧合恰恰不容易被当成 bug。
    const root = scopeSel ? document.querySelector(scopeSel) : null;
    const pool = root ? root.querySelectorAll('*') : document.querySelectorAll('*');
    (root ? [root, ...pool] : [...pool]).forEach((el) => {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
      if (!own) return;
      if (!root) {
        const y = el.getBoundingClientRect().top + window.scrollY;
        if (y < from || y >= to) return;
      }
      items.push(own);
    });
    return items;
  }, { from: b.top, to: b.top + b.height, scopeSel: b.scope || null });

  fs.writeFileSync(path.join(out, `text-${b.id}.txt`), `${b.label}\n${'-'.repeat(40)}\n${texts.join('\n')}\n`);
  index.push({ id: b.id, label: b.label, via: b.via, scope: b.scope || null, top: b.top, height: b.height, files, textFile: `text-${b.id}.txt`, textCount: texts.length });
}

fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ url, width, dsf, boards: index }, null, 1));
await browser.close();

console.log(`画板 ${index.length} 个（识别方式：${boards[0].via}）：`);
for (const b of index) console.log(`  ${b.id}  ${b.label}  切图 ${b.files.length} 张 · 文案 ${b.textCount} 条`);
console.log(`\n清单：${path.join(out, 'index.json')}`);
console.log('下一步：node extract-spec.mjs 扒设计系统规格，别急着写组件。');
