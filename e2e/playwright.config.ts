/**
 * Playwright E2E configuration — Phase 6 of the test-system build-out.
 *
 * Aims at a DEPLOYED CDS preview environment (any branch domain like
 * `https://my-branch.miduo.org`), not a locally-served dev build.
 * Setting `E2E_BASE_URL` via env makes every spec relative-path-safe.
 *
 * Keep the golden-path count small (≤5) — these run slow and break
 * easy. Unit tests (vitest) remain the load-bearing layer; these only
 * catch UI regressions that survive everything else.
 */

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5500';
const START_LOCAL_SERVER = process.env.E2E_LOCAL_SERVER === '1';

export default defineConfig({
  testDir: './specs',
  webServer: START_LOCAL_SERVER ? {
    // 验收生产构建，不用 React 开发态 StrictMode 的双副作用替代用户实际环境。
    command: 'pnpm --dir ../prd-admin preview --host 127.0.0.1 --port 5500 --strictPort',
    url: 'http://127.0.0.1:5500',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  } : undefined,
  // Fail the build on `.only` — `.only` left in CI silently skips the
  // rest of the suite, creating a dangerous false-green.
  forbidOnly: !!process.env.CI,
  // Retry once on CI; locally fail fast so the developer sees flake.
  retries: process.env.CI || process.env.STABLE_SMOKE_RUN ? 1 : 0,
  // Workers: default to 1 locally (debuggable) and use reported
  // capacity in CI. Keep deterministic ordering for CI log grok.
  workers: process.env.STABLE_SMOKE_RUN ? 1 : process.env.CI ? 2 : 1,
  // Generate HTML report AND JSON so CI can upload both; dot reporter
  // keeps stdout readable for human tails.
  reporter: process.env.STABLE_SMOKE_JSON_OUTPUT
    ? [
        ['list'],
        ['json', { outputFile: process.env.STABLE_SMOKE_JSON_OUTPUT }],
        ['html', { open: 'never', outputFolder: process.env.STABLE_SMOKE_HTML_OUTPUT }],
      ]
    : process.env.CI
    ? [['dot'], ['html', { open: 'never' }], ['json', { outputFile: 'results.json' }]]
    : [['list'], ['html', { open: 'on-failure' }]],
  use: {
    baseURL: BASE_URL,
    // Always capture a screenshot on failure — ~50KB each, negligible
    // cost for post-mortem. Trace only on retry so first-try flake is
    // invisible but deterministic failure has a deep dive.
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    // Network fixture tests use page.route() to replace API responses.
    // Service workers can satisfy fetches before Playwright sees them,
    // which makes visual fixture tests silently hit live data.
    serviceWorkers: 'block',
    // 10s action timeout matches "if a button click takes >10s you
    // already have a worse problem" heuristic.
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  outputDir: process.env.STABLE_SMOKE_TEST_OUTPUT || 'test-results',
  // Per-test timeout (all assertions+actions combined).
  timeout: 60_000,
  expect: {
    timeout: 5_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.STABLE_SMOKE_RUN
          ? {
              args: [
                '--use-fake-device-for-media-stream',
                '--use-fake-ui-for-media-stream',
              ],
            }
          : undefined,
      },
    },
    // Add firefox / webkit projects later when core chromium paths
    // are stable. Cross-browser coverage isn't worth the 3x CI time
    // for a Phase 6 baseline.
  ],
});
