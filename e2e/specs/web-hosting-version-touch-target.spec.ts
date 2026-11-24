import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const panelSource = readFileSync(
  resolve(import.meta.dirname, '../../prd-admin/src/components/web-hosting/SiteEditPanel.tsx'),
  'utf8',
);
const summaryClasses = panelSource.match(
  /<summary className="([^"]+)">技术信息<\/summary>/,
)?.[1];

test('版本技术信息在移动端保持真实触控尺寸和原生开合语义', async ({ page }) => {
  expect(summaryClasses).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/web-pages');
  const stylesheets = await page.locator('link[rel="stylesheet"]').evaluateAll((links) => (
    links.map((link) => (link as HTMLLinkElement).href)
  ));
  expect(stylesheets.length).toBeGreaterThan(0);

  await page.setContent(`<!doctype html>
    <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    ${stylesheets.map((href) => `<link rel="stylesheet" href="${href}">`).join('')}
    </head><body style="margin:16px;max-width:303px">
      <details id="technical-details" class="mt-1 text-[10px] text-token-muted">
        <summary class="${summaryClasses}">技术信息</summary>
        <p>执行来源：MAP</p>
      </details>
    </body></html>`);

  const summary = page.locator('summary');
  await expect(summary).toBeVisible();
  const box = await summary.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await summary.evaluate((element) => getComputedStyle(element).display)).toBe('list-item');

  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#technical-details')).toHaveAttribute('open', '');
  await page.keyboard.press('Space');
  await expect(page.locator('#technical-details')).not.toHaveAttribute('open', '');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
