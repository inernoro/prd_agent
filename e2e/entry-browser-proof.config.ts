import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  testMatch: ['admin-operations-compat.spec.ts', 'collection-scroll-compat.spec.ts'],
  grep: /少量密钥|菜单导航后新任务|慢加载日景|临界宽度/,
  timeout: 60000,
  workers: 3,
  reporter: [['list'], ['json', { outputFile: '../work/entry-browser/results.json' }]],
  outputDir: '../work/entry-browser/tests',
  use: { actionTimeout: 8000, screenshot: 'only-on-failure' },
  projects: ['chromium', 'firefox', 'webkit'].map(browserName => ({
    name: browserName,
    use: { browserName: browserName as 'chromium' | 'firefox' | 'webkit' },
  })),
  webServer: {
    command: 'pnpm --dir ../llmgw/web preview --host 127.0.0.1 --strictPort --port 8200',
    url: 'http://127.0.0.1:8200/llmgw/',
  },
});
