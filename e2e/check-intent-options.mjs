import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { installOperationsFixtures } from './fixtures/admin-operations.mjs';

assert.equal(process.env.CI, 'true');
const folder = new URL('../work/gateway-intent-options/', import.meta.url);
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const rows = [];

const scenarios = [
  { name: 'before-light', before: true, theme: 'light', width: 1440 },
  { name: 'desktop-light', theme: 'light', width: 1440 },
  { name: 'desktop-dark', theme: 'dark', width: 1440 },
  { name: 'mobile-light', theme: 'light', width: 390, mobile: true },
  { name: 'mobile-dark', theme: 'dark', width: 320, mobile: true },
];
try {
  for (const { name, before, theme, width, mobile = false } of scenarios) {
    const context = await browser.newContext({
      viewport: { width, height: 850 }, colorScheme: theme, locale: 'zh-CN',
      reducedMotion: 'reduce', isMobile: mobile, hasTouch: mobile,
    });
    try {
      const page = await context.newPage();
      const { writes } = await installOperationsFixtures(page, { quickstart: true });
      await page.goto('http://127.0.0.1:' + (before ? '8210' : '8200') + '/llmgw/login');
      await page.locator('#llmgw-username').fill('demo');
      await page.locator('#llmgw-password').fill('demo');
      await page.getByRole('button', { name: '开始身份确认', exact: true }).click();
      await page.waitForURL(/\/quickstart$/);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByRole('textbox', { name: '我想做什么', exact: true })).toBeEditable();
      const options = page.locator('.gateway-intent-options');
      const button = options.getByRole('button', { name: '手动接入', exact: true });
      await expect(options.getByText('智能建议费用由平台承担', { exact: true })).toBeVisible();
      await expect.poll(() => page.locator('.consciousness-art').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
      await page.evaluate(() => document.fonts.ready);
      const rect = await options.boundingBox();
      assert.ok(rect);
      const result = await button.evaluate(el => {
        const style = getComputedStyle(el);
        const group = el.parentElement.getBoundingClientRect();
        return { border: style.borderTopWidth, height: el.getBoundingClientRect().height, background: style.backgroundColor,
          labelDivider: getComputedStyle(el.previousElementSibling).borderInlineEndWidth,
          fits: group.left >= 0 && group.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth,
          touch: navigator.maxTouchPoints };
      });
      rows.push({ name, width, ...result });
      const right = Math.min(width, Math.ceil(rect.x + rect.width + 38));
      const left = Math.max(0, Math.floor(rect.x - 38));
      await page.screenshot({ path: new URL(name + '.png', folder).pathname, clip: {
        x: left, y: Math.floor(rect.y - 28), width: right - left, height: Math.ceil(rect.height + 56),
      } });
      if (before) {
        assert.notEqual(result.border, '0px');
        continue;
      }
      assert.equal(result.border, '0px');
      assert.equal(result.labelDivider, '1px');
      assert.ok(result.height >= 44 && result.fits);
      if (!mobile) {
        await button.hover();
        await expect.poll(() => button.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(result.background);
        await page.getByRole('group', { name: '从一个想法开始' }).getByRole('button').last().focus();
        await page.keyboard.press('Tab');
        await expect(button).toBeFocused();
        await expect(button).toHaveCSS('outline-width', '2px');
        await page.keyboard.press('Enter');
      } else {
        assert.ok(result.touch > 0);
        await button.tap();
      }
      await expect(page.getByRole('textbox', { name: '应用标识（英文）', exact: true })).toBeVisible();
      assert.ok(!writes.some(write => write.path.endsWith('/app-callers/draft')));
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(new URL('evidence.json', folder), JSON.stringify(rows, null, 2));
}
