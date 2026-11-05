/** 真实组件的排版回归：开发入口与空 API 桩，不代表登录或业务验收。 */
import { expect, test } from '@playwright/test';

test.use({
  video: 'off',
  ...(process.env.E2E_CHROMIUM_EXECUTABLE
    ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } }
    : {}),
});

for (const scale of [1, 0.75]) {
  test.describe(`市场卡片 · ${scale * 100}% 显示比例`, () => {
    test.use({
      viewport: { width: scale === 1 ? 1600 : 2048, height: 1200 },
      deviceScaleFactor: scale,
    });
    for (const theme of ['light', 'dark']) {
      test(`${theme}：三种尺寸下文字清晰且不与操作栏重叠`, async ({ page }) => {
        await page.route('**/api/**', route => route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { items: [], tags: [] } }),
        }));
        await page.goto('/_dev/marketplace-card-demo');
        await expect(page.locator('.mkt-card')).toHaveCount(3, { timeout: 30_000 });
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        for (const density of ['小', '中', '大']) {
          await page.getByRole('button', { name: /^显示/ }).click();
          await page.getByRole('button', { name: density, exact: true }).click();
          await page.keyboard.press('Escape');
          for (const card of await page.locator('.mkt-card').all()) {
            const title = card.locator('.mkt-card-title');
            await expect(title).toHaveCSS('text-shadow', 'none');
            await expect(card.locator('.mkt-card-title-type-icon')).toBeHidden();
            const style = await title.evaluate(el => {
              const c = getComputedStyle(el);
              return { size: parseFloat(c.fontSize), weight: Number(c.fontWeight) };
            });
            expect(style.size).toBeGreaterThanOrEqual(14);
            expect(style.weight).toBeLessThanOrEqual(500);
            for (const tag of await card.locator('.mkt-card-tag:visible').all()) {
              await expect(tag).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
              await expect(tag).toHaveCSS('border-top-width', '0px');
              await expect(tag).toHaveCSS('text-shadow', 'none');
              expect(await tag.evaluate(el => parseFloat(getComputedStyle(el).fontSize)))
                .toBeGreaterThanOrEqual(11);
            }
            const overlaps = await card.evaluate(el => {
              const footer = el.querySelector('.mkt-card-glass-footer')!.getBoundingClientRect();
              return Array.from(el.querySelectorAll('.mkt-card-title, .mkt-card-desc, .mkt-card-tag, .mkt-card-release-meta'))
                .filter(node => node.getBoundingClientRect().height > 0)
                .filter(node => node.getBoundingClientRect().bottom > footer.top + 1)
                .map(node => node.className);
            });
            expect(overlaps, `${theme}/${density} 正文不应进入操作栏`).toEqual([]);
          }
        }
      });
    }
  });
}
