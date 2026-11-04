import { expect, test } from '@playwright/test';
import { installMarketplaceFixture } from '../fixtures/marketplace';

test.use({ video: 'off', ...(process.env.E2E_CHROMIUM_EXECUTABLE ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } } : {}) });

test('市场平铺：实际组件铺满可用宽度，搜索、分类与角色筛选仍使用原逻辑', async ({ page }) => {
  await installMarketplaceFixture(page);
  await page.setViewportSize({ width: 2560, height: 1200 });
  await page.goto('/marketplace');
  await expect(page.locator('.mkt-card-density-tile')).toHaveCount(24, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: '技能', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const geometry = await page.locator('.marketplace-tile-grid').evaluate(el => {
    const grid = el.getBoundingClientRect();
    const content = el.closest('.marketplace-results-scroll')!;
    const host = content.getBoundingClientRect();
    return { width: grid.width, left: grid.left - host.left, right: host.right - grid.right,
      padding: parseFloat(getComputedStyle(content).paddingLeft) };
  });
  expect(geometry.width).toBeGreaterThan(2000);
  expect(geometry.left).toBeCloseTo(geometry.padding, 0);
  expect(geometry.right).toBeCloseTo(geometry.padding, 0);
  await page.setViewportSize({ width: 820, height: 1100 });
  const uploadBox = await page.getByRole('button', { name: '上传技能', exact: true }).boundingBox();
  const toolbarBox = await page.locator('.marketplace-workspace-toolbar').boundingBox();
  expect(uploadBox!.x + uploadBox!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width);
  await page.setViewportSize({ width: 2560, height: 1200 });
  await page.getByPlaceholder('搜索名称、描述').fill('Git');
  await expect(page.locator('.mkt-card')).toHaveCount(2);
  await page.getByRole('button', { name: '清空筛选' }).click();
  const roles = page.locator('[data-tour-id="marketplace-role-row"]');
  await roles.getByRole('button', { name: '产品经理', exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(8);
  await page.getByRole('button', { name: '清空筛选' }).click();
  await page.locator('[data-tour-id="marketplace-tag-filters"]').getByRole('button', { name: /工具/ }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(12);
  await page.getByRole('button', { name: '清空筛选' }).click();
  await page.getByRole('button', { name: /^显示/ }).click();
  const request = page.waitForRequest(req => req.url().includes('/api/marketplace/skills?') && req.url().includes('sort=new'));
  await page.getByRole('button', { name: '最新', exact: true }).click();
  await request;
  await page.getByRole('button', { name: '小', exact: true }).click();
  await expect(page.locator('.marketplace-workspace')).toHaveAttribute('data-card-size', 'small');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '提示词', exact: true }).click();
  await expect(page).toHaveURL(/type=prompt/);
  await expect(page.locator('.marketplace-empty')).toBeVisible();
  await expect(page.locator('[aria-label="接入 AI"]')).toHaveCount(0);
});

test('手机筛选和接入浮层：小屏不横溢出，生成结果与 Esc 关闭可见', async ({ page }) => {
  await installMarketplaceFixture(page);
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto('/marketplace');
  await expect(page.locator('.mkt-card-density-tile')).toHaveCount(24, { timeout: 30_000 });
  await expect(page.locator('.marketplace-filter-rail')).toHaveCount(0);
  await page.getByRole('button', { name: /^筛选/ }).click();
  await page.getByRole('button', { name: '产品经理', exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(8);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '接入 AI', exact: true }).click();
  await page.getByRole('button', { name: '一键生成', exact: true }).click();
  await expect(page.getByRole('button', { name: '复制给 AI 使用（一键接入）', exact: true })).toBeVisible();
  const box = await page.locator('.marketplace-quick-connect').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  await page.keyboard.press('Escape');
  await expect(page.locator('.marketplace-quick-connect')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test('个人技能范围：收藏即时移除、分类联动及上传元信息准确', async ({ page }) => {
  await installMarketplaceFixture(page);
  await page.goto('/marketplace?scope=favorites');
  await expect(page.locator('.mkt-card')).toHaveCount(3, { timeout: 30_000 });
  await expect(page.locator('.mkt-card-uploaded-at').first()).toHaveText('上传于 2026-10-01');
  await expect(page.locator('.mkt-card-uploaded-at').first()).toHaveAttribute('datetime', '2026-10-01T00:00:00Z');
  await expect(page.locator('.mkt-card-version').first()).toHaveText('v1.0.0');
  await page.locator('[data-tour-id="marketplace-tag-filters"]').getByRole('button', { name: '工具 2', exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(2);
  await page.locator('.mkt-card').filter({ hasText: 'dev-starter · 开发入门套装 · 进阶' }).getByTitle('取消收藏', { exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(1);
  await page.getByRole('button', { name: '我的技能', exact: true }).click();
  await expect(page).toHaveURL(/scope=mine/);
  await expect(page.locator('.mkt-card')).toHaveCount(4);
  await expect(page.locator('.mkt-card').getByTitle('编辑', { exact: true })).toHaveCount(4);
  await expect(page.locator('[data-tour-id="marketplace-tag-filters"]').getByRole('button', { name: '工具 4', exact: true })).toBeVisible();
  await page.getByPlaceholder('搜索名称、描述').fill('html-ppt');
  await expect(page.locator('.mkt-card')).toHaveCount(2);
  await page.getByRole('button', { name: '我的收藏', exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(2);
  await expect(page.getByPlaceholder('搜索名称、描述')).toHaveValue('');
  await page.getByRole('button', { name: '全部内容', exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(24);
  await expect(page.locator('.mkt-card').filter({ has: page.getByTitle('monthly-report', { exact: true }) }).locator('.mkt-card-version')).toHaveCount(0);
  await page.getByPlaceholder('搜索名称、描述').fill('goal-pipeline-board');
  await expect(page.locator('.mkt-card').filter({ has: page.getByTitle('goal-pipeline-board', { exact: true }) }).locator('.mkt-card-version')).toHaveText('v2.0.0');
});

test('个人列表请求失败可重试，取消收藏失败保留列表与状态', async ({ page }) => {
  await installMarketplaceFixture(page);
  await page.route('**/api/marketplace/skills?*scope=favorites*', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'TEMPORARY', message: '暂时不可用' } }),
  }));
  await page.goto('/marketplace?scope=favorites');
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.mkt-card')).toHaveCount(0);
  await page.unroute('**/api/marketplace/skills?*scope=favorites*');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(3);
  await page.route('**/api/marketplace/skills/*/unfavorite', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: '暂时不可用' } }),
  }));
  const favorite = page.locator('.mkt-card-favorite').first();
  await favorite.click();
  await expect(favorite).toBeEnabled();
  await expect(favorite).toHaveAttribute('data-active', 'true');
  await expect(page.locator('.mkt-card')).toHaveCount(3);
});
