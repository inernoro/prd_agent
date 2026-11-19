import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const out = new URL('../work/entry-browser/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  const facts = [];
  for (const [width, height] of [[390, 844], [320, 568]]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true });
    await page.goto('http://127.0.0.1:8170/entry-mobile-search-proof.html');
    await page.getByRole('searchbox').fill('能力');
    const results = page.getByRole('region', { name: '搜索结果' });
    const geometry = await results.evaluate(el => {
      el.scrollTop = el.scrollHeight;
      const button = el.lastElementChild;
      const panel = el.closest('.consciousness-home').getBoundingClientRect();
      const bounds = button.getBoundingClientRect();
      const reachable = button.contains(document.elementFromPoint((bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2));
      return { width: innerWidth, height: innerHeight, panelBottom: panel.bottom,
        resultBottom: el.getBoundingClientRect().bottom, lastBottom: bounds.bottom, resultTop: el.getBoundingClientRect().top, resultAboveSearch: el.getBoundingClientRect().bottom < el.parentElement.getBoundingClientRect().top, scrollTop: el.scrollTop, reachable, x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
    });
    assert.ok(geometry.scrollTop > 0);
    assert.ok(geometry.resultAboveSearch, JSON.stringify(geometry));
    assert.ok(geometry.resultTop >= 0 && geometry.lastBottom <= geometry.panelBottom && geometry.reachable, JSON.stringify(geometry));
    await page.touchscreen.tap(geometry.x, geometry.y);
    assert.equal(await page.locator('body').getAttribute('data-opened'), '8');
    geometry.opened = '8';
    facts.push(geometry);
    await page.screenshot({ path: new URL(`search-${width}.png`, out).pathname });
    await page.close();
  }
  await writeFile(new URL('mobile-search-fixed.json', out), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify(facts));
} finally {
  await browser.close();
}
