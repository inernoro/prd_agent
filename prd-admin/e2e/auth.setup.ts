import { test as setup, expect } from '@playwright/test';

const authFile = 'e2e/.auth/user.json';

/**
 * Authentication setup - runs once before all tests
 *
 * This stores authenticated state that other tests can reuse,
 * avoiding login for every test.
 */
setup('authenticate', async ({ page }) => {
  // Navigate to login page
  await page.goto('/login');

  // Fill in credentials
  // Note: In real tests, use environment variables for credentials
  await page.getByLabel('用户名').fill(process.env.TEST_USERNAME || 'admin');
  await page.getByLabel('密码').fill(process.env.TEST_PASSWORD || 'testpassword');

  // Click login button
  await page.getByRole('button', { name: '登录' }).click();

  // Wait for successful login - redirect to dashboard
  await expect(page).toHaveURL(/.*dashboard|.*sessions/);

  // Store authentication state
  await page.context().storageState({ path: authFile });
});
