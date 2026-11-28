/* 排版审计：统计画面上可见文字用了几种字号、几种字重、几种字体族、几种文字颜色。node tools/type-audit.mjs [画面编号...] */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const design = JSON.parse(readFileSync(path.join(root, 'design.json'), 'utf8'));
const only = process.argv.slice(2);
const browser = await chromium.launch();
const out = {};
for (const s of design.screens.filter(x => !only.length || only.includes(x.id))) {
  const phone = s.viewport === 'phone';
  const page = await browser.newPage({ viewport: phone ? { width: 375, height: 812 } : { width: 1440, height: 900 } });
  await page.goto('file://' + path.join(root, 'dist/index.html') + s.route);
  await page.waitForSelector(s.entryReadySelector, { timeout: 10000 });
  await page.waitForTimeout(500);
  out[s.id] = await page.evaluate(() => {
    const root = document.querySelector('[data-lc-ready]');
    const sizes = new Map(), weights = new Map(), fams = new Set(), colors = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode; if (!n.textContent.trim()) continue;
      const el = n.parentElement; const r = el.getBoundingClientRect(); if (!r.width || r.bottom < 0 || r.top > innerHeight) continue;
      const cs = getComputedStyle(el);
      sizes.set(cs.fontSize, (sizes.get(cs.fontSize) ?? 0) + 1); weights.set(cs.fontWeight, (weights.get(cs.fontWeight) ?? 0) + 1);
      fams.add(/mono|Menlo|Consolas/i.test(cs.fontFamily) ? 'mono' : 'sans'); colors.add(cs.color);
    }
    return { sizes: [...sizes.keys()].sort((a, b) => parseFloat(a) - parseFloat(b)), weights: [...weights.keys()].sort(), families: [...fams], colors: colors.size };
  });
  await page.close();
}
await browser.close();
console.log(JSON.stringify(out));
