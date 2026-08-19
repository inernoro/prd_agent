#!/usr/bin/env node
/**
 * 把设计稿与实现页的同名画板拼成一张并排图。
 *
 * 为什么必须拼：分两次看两张图，脑子会自动补齐差异，「差那么一点点」就是这么漏掉的。
 * 并排放在同一张位图里，间距、字重、列宽、圆角的偏差是直接跳出来的。
 *
 * 用法：node pair.mjs --design <目录> --impl <目录> --out <目录>
 * 两个目录里的 *.manifest.json 决定配对关系（state + theme + width 三者相同才配）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// 同 render.mjs：依赖装在工作目录，从 cwd 解析。
const { chromium } = createRequire(path.join(process.cwd(), 'noop.js'))('playwright');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i < 0 ? dflt : process.argv[i + 1];
}
const designDir = arg('--design');
const implDir = arg('--impl');
const outDir = arg('--out');
if (!designDir || !implDir || !outDir) {
  console.error('必填：--design --impl --out');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const load = (dir) => fs.readdirSync(dir)
  .filter((f) => f.endsWith('.manifest.json'))
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

const design = load(designDir);
const impl = load(implDir);
const key = (r) => `${r.state}|${r.theme}|${r.width}`;
const implBy = new Map(impl.map((r) => [key(r), r]));

const CHROME = process.env.CHROME_BIN
  || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage({ deviceScaleFactor: 1 });

const unmatched = [];
for (const d of design) {
  const i = implBy.get(key(d));
  if (!i) { unmatched.push(key(d)); continue; }
  const html = `<!doctype html><meta charset="utf-8">
<style>
 body{margin:0;background:#111;font:13px/1.4 system-ui,sans-serif;color:#eee}
 .row{display:flex;gap:8px;align-items:flex-start}
 figure{margin:0;flex:1;min-width:0}
 figcaption{padding:6px 8px;background:#1d1d1d;position:sticky;top:0}
 img{width:100%;display:block;border:1px solid #333}
</style>
<div class="row">
 <figure><figcaption>设计稿 ${d.state} / ${d.theme}</figcaption><img src="file://${path.resolve(d.file)}"></figure>
 <figure><figcaption>实现页 ${i.state} / ${i.theme}</figcaption><img src="file://${path.resolve(i.file)}"></figure>
</div>`;
  const tmp = path.join(outDir, `.pair.${d.state}.${d.theme}.html`);
  fs.writeFileSync(tmp, html);
  await page.goto(`file://${path.resolve(tmp)}`, { waitUntil: 'load' });
  await page.setViewportSize({ width: 2400, height: 1200 });
  await page.waitForTimeout(400);
  const out = path.join(outDir, `pair.${d.state}.${d.theme}.${d.width}.png`);
  await page.screenshot({ path: out, fullPage: true });
  fs.unlinkSync(tmp);
  console.log(out);
}
await browser.close();

if (unmatched.length) {
  console.log('\n--- 设计稿有、实现页没截到的画板（这些就是还没复刻的屏）---');
  for (const u of unmatched) console.log(u);
  process.exitCode = 1;
}
