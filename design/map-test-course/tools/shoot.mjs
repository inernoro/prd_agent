/* 原型自查截图：node tools/shoot.mjs <输出目录> [画面编号...]  只用于出稿自检 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const design = JSON.parse(readFileSync(path.join(root, 'design.json'), 'utf8'));
const out = process.argv[2]; const only = process.argv.slice(3);
const file = 'file://' + path.join(root, 'dist/index.html');
const browser = await chromium.launch();
const errors = [];
for (const s of design.screens.filter(x => !only.length || only.includes(x.id))) {
  for (const theme of s.themes) {
    const phone = s.viewport === 'phone';
    const page = await browser.newPage({ viewport: phone ? { width: 375, height: 812 } : { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: phone, isMobile: phone });
    page.on('console', m => { if (m.type() === 'error') errors.push(`${s.id}/${theme}: ${m.text()}`); });
    page.on('pageerror', e => errors.push(`${s.id}/${theme}: ${e.message}`));
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(t => {
      const pin = () => { const h = document.documentElement; if (h && h.getAttribute('data-theme') !== t) h.setAttribute('data-theme', t); };
      document.addEventListener('DOMContentLoaded', () => { pin(); new MutationObserver(pin).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); });
    }, theme);
    await page.goto(file + s.route);
    try { await page.waitForSelector(s.entryReadySelector, { timeout: 8000 }); } catch { errors.push(`${s.id}/${theme}: 未就绪 ${s.entryReadySelector}`); }
    for (const a of s.entryActions ?? []) { await page.click(a); await page.waitForTimeout(400); }
    await page.waitForTimeout(s.settleMs ?? 700);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 0) errors.push(`${s.id}/${theme}: 横向溢出 ${overflow}px`);
    await page.screenshot({ path: path.join(out, `${s.id}.${theme}.png`) });
    await page.close();
  }
}
await browser.close();
console.log(errors.length ? errors.join('\n') : 'no errors');
