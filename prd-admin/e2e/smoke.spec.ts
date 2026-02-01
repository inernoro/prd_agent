import { test, expect } from '@playwright/test';

/**
 * Smoke Tests - Basic health checks for the application
 *
 * These tests verify that the application is running and basic
 * navigation works. Run these first before other E2E tests.
 *
 * Run: pnpm test:e2e --grep "Smoke"
 */
test.describe('Smoke Tests', () => {
  test('app loads without errors', async ({ page }) => {
    // Navigate to root
    await page.goto('/');

    // Should redirect to login or dashboard
    await expect(page).toHaveURL(/.*login|.*dashboard|.*sessions/);
  });

  test('login page is accessible', async ({ page }) => {
    await page.goto('/login');

    // Verify login form elements
    await expect(page.getByLabel(/用户名|username/i)).toBeVisible();
    await expect(page.getByLabel(/密码|password/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /登录|login/i })).toBeVisible();
  });

  test('no console errors on page load', async ({ page }) => {
    const errors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('/login');

    // Wait for page to fully load
    await page.waitForLoadState('networkidle');

    // Filter out known acceptable errors (like missing favicon)
    const criticalErrors = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('404')
    );

    expect(criticalErrors).toHaveLength(0);
  });

  test('API health check endpoint responds', async ({ request }) => {
    // Test API health endpoint if available
    const response = await request.get('/api/health');

    // Accept 200 or 404 (if endpoint doesn't exist)
    expect([200, 404]).toContain(response.status());
  });
});

/**
 * Navigation Tests - Verify key routes are accessible
 */
test.describe('Navigation', () => {
  // These tests may require authentication
  test.use({ storageState: 'e2e/.auth/user.json' });

  const routes = [
    { path: '/dashboard', name: 'Dashboard' },
    { path: '/visual-agent', name: 'Visual Agent' },
    { path: '/models', name: 'Models' },
    { path: '/settings', name: 'Settings' },
  ];

  for (const route of routes) {
    test(`${route.name} page loads`, async ({ page }) => {
      const response = await page.goto(route.path);

      // Should not be a server error
      expect(response?.status()).toBeLessThan(500);

      // Page should have some content
      await expect(page.locator('body')).not.toBeEmpty();
    });
  }
});
