import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  testMatch: 'admin-operations-compat.spec.ts',
  grep: /临界宽度|慢加载日景/,
  timeout: 45000,
  workers: 1,
  reporter: [['list'], ['json']],
  outputDir: '../work/entry-review/tests',
  use: { channel: 'chromium', screenshot: 'only-on-failure' },
  webServer: {
    command: `pnpm --dir "${process.env.ENTRY_APP}" preview --host 127.0.0.1 --strictPort --port 8200`,
    url: 'http://127.0.0.1:8200/llmgw/',
  },
});
