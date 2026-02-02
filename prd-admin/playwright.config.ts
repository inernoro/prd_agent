import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Test Configuration
 *
 * Usage:
 *   pnpm test:e2e           - Run all E2E tests
 *   pnpm test:e2e:ui        - Run with UI mode (interactive)
 *   pnpm test:e2e:headed    - Run with browser visible
 *   pnpm test:e2e --grep "login"  - Run specific tests
 *
 * Environment:
 *   TEST_BASE_URL=http://localhost:5173  - Override base URL
 */
export default defineConfig({
  testDir: './e2e',

  // Maximum time for each test
  timeout: 30 * 1000,

  // Maximum time to wait for expect() conditions
  expect: {
    timeout: 5000
  },

  // Run tests in parallel
  fullyParallel: true,

  // Fail fast on CI
  forbidOnly: !!process.env.CI,

  // Retry on CI only
  retries: process.env.CI ? 2 : 0,

  // Limit parallel workers on CI
  workers: process.env.CI ? 1 : undefined,

  // Reporter configuration
  reporter: [
    ['html', { open: 'never' }],
    ['list']
  ],

  // Shared settings for all projects
  use: {
    // Base URL for navigation
    baseURL: process.env.TEST_BASE_URL || 'http://localhost:5173',

    // Collect trace on first retry
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video on first retry
    video: 'on-first-retry',
  },

  // Browser configurations
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Add Firefox/Safari for CI if needed
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
  ],

  // Local dev server configuration
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
