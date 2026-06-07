import { loadConfig, launch, login, shot, writeManifest } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const OUT = '/tmp/acc_shots7';
const { browser, page } = await launch(cfg);
try {
  await login(page, BASE, cfg);
  await page.goto(BASE.replace(/\/+$/, '') + '/cds-agent', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('textarea', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.locator('textarea').first().click();   // focus
  await page.waitForTimeout(500);
  await shot(page, OUT, '01-focused', 'textarea 聚焦:高亮应在外层容器,内层无蓝框');
  // 取证:textarea 自身 focus 样式是否被压掉(box-shadow/outline none)
  const probe = await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return { found: false };
    const cs = getComputedStyle(ta);
    return { found: true, hasNoFocusRingClass: ta.classList.contains('no-focus-ring'), outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow };
  });
  console.log('FOCUS_PROBE', JSON.stringify(probe));
  writeManifest(OUT);
} catch (e) { console.error('ERR', e.message); }
finally { await browser.close(); }
