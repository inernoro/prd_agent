import { expect, test } from '@playwright/test';

const realAuthEnabled = process.env.E2E_REAL_AUTH === '1';
const username = process.env.E2E_REAL_USERNAME ?? 'admin';
const password = process.env.E2E_REAL_PASSWORD ?? 'admin';

test.use({ viewport: { width: 390, height: 844 } });
test.skip(!realAuthEnabled, '仅在 CDS 等真实预览环境显式启用，不允许用接口拦截替代登录');

test('真实账号从产品首页登录并通过导航进入知识库', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: /进入 MAP/ }).first().click();
  await page.locator('input[type="text"]').first().fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /进入控制台/ }).click();

  await expect(page.getByText('用户名或密码错误', { exact: false })).toHaveCount(0);
  await expect(page.getByText('常用应用', { exact: true })).toBeVisible({ timeout: 15_000 });
  await testInfo.attach('real-login-home', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

  await page.getByText('知识库', { exact: true }).last().click();
  await expect(page.getByText('我的空间', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByPlaceholder(/按名称或标签筛选/)).toBeVisible();
  await testInfo.attach('real-knowledge-base', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});
