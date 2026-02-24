import { test, expect } from '@playwright/test';

/**
 * Visual Agent E2E Tests
 *
 * Run: pnpm test:e2e --grep "VisualAgent"
 */
test.describe('VisualAgent', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to visual agent page
    await page.goto('/visual-agent');
  });

  test('should display workspace list page', async ({ page }) => {
    // Verify page title or key element
    await expect(page.locator('h1, [data-testid="page-title"]')).toBeVisible();
  });

  test('should show create workspace button', async ({ page }) => {
    // Look for create button
    const createButton = page.getByRole('button', { name: /创建|新建|Create/i });
    await expect(createButton).toBeVisible();
  });

  test('should open create workspace dialog', async ({ page }) => {
    // Click create button
    await page.getByRole('button', { name: /创建|新建|Create/i }).click();

    // Verify dialog appears
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
  });
});

test.describe('VisualAgent Workspace', () => {
  // Skip these tests if no test workspace exists
  test.skip(({ }, testInfo) => {
    return !process.env.TEST_WORKSPACE_ID;
  });

  const workspaceId = process.env.TEST_WORKSPACE_ID || 'test_workspace';

  test.beforeEach(async ({ page }) => {
    await page.goto(`/visual-agent/workspace/${workspaceId}`);
  });

  test('should display canvas', async ({ page }) => {
    // Wait for canvas to load
    const canvas = page.locator('canvas, [data-testid="workspace-canvas"]');
    await expect(canvas).toBeVisible({ timeout: 10000 });
  });

  test('should have toolbar visible', async ({ page }) => {
    // Verify toolbar elements
    const toolbar = page.locator('[data-testid="toolbar"], .toolbar');
    await expect(toolbar).toBeVisible();
  });
});
