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
import { stableSmokeReporterConfig, stableSmokeTraceMode } from './utils/stableSmokeDiagnostics.mjs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5500';
const START_LOCAL_SERVER = process.env.E2E_LOCAL_SERVER === '1';
const STABLE_SMOKE_RUN = process.env.STABLE_SMOKE_RUN === '1';
const stableSmokeReporters = stableSmokeReporterConfig({
  jsonOutput: process.env.STABLE_SMOKE_JSON_OUTPUT || '',
  htmlOutput: process.env.STABLE_SMOKE_HTML_OUTPUT,
  stableRun: STABLE_SMOKE_RUN,
});

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
  // 常规 CI 生成 HTML + JSON；带认证头的稳定冒烟只保留脱敏 JSON。
  // dot/list reporter keeps stdout readable for human tails.
  reporter: stableSmokeReporters
    ? stableSmokeReporters
    : process.env.CI
    ? [['dot'], ['html', { open: 'never' }], ['json', { outputFile: 'results.json' }]]
    : [['list'], ['html', { open: 'on-failure' }]],
  use: {
    baseURL: BASE_URL,
    // Always capture a screenshot on failure — ~50KB each, negligible
    // cost for post-mortem. Trace only on retry so first-try flake is
    // invisible but deterministic failure has a deep dive.
    screenshot: 'only-on-failure',
    // 稳定冒烟会携带短期认证头；trace 会保存完整网络请求，禁止在该模式生成。
    trace: stableSmokeTraceMode(STABLE_SMOKE_RUN),
    video: 'retain-on-failure',
    // Network fixture tests use page.route() to replace API responses.
    // Service workers can satisfy fetches before Playwright sees them,
    // which makes visual fixture tests silently hit live data.
    // Playwright 原生 block 初始化脚本会读取 opaque srcDoc 的受限属性并抛 SecurityError。
    // 巡检 context 在导航前安装同等的安全注册阻断；普通网络夹具继续用原生 block。
    serviceWorkers: process.env.STABLE_SMOKE_RUN ? 'allow' : 'block',
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
