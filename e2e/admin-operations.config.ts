// 先构建 cds/web 与 llmgw/web；本配置验收实际 bundle，API 写入全部由合成夹具隔离。
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./specs",
  testMatch: "admin-operations-compat.spec.ts",
  timeout: 90000,
  outputDir: process.env.COMPAT_OUTPUT || "../work/compat/test-results",
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: process.env.COMPAT_REPORT || "../work/compat/results.json",
      },
    ],
    [
      "html",
      {
        outputFolder: process.env.COMPAT_HTML || "../work/compat/html",
        open: "never",
      },
    ],
  ],
  use: {
    actionTimeout: 8000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: ["chromium", "firefox", "webkit"].map((browserName) => ({
    name: browserName,
    use: { browserName: browserName as "chromium" | "firefox" | "webkit" },
  })),
  webServer: [
    {
      command:
        "pnpm --dir ../cds/web preview --host 127.0.0.1 --strictPort --port 5273",
      url: "http://127.0.0.1:5273",
      reuseExistingServer: true,
    },
    {
      command:
        "pnpm --dir ../llmgw/web preview --host 127.0.0.1 --strictPort --port 8200",
      url: "http://127.0.0.1:8200/llmgw/",
      reuseExistingServer: true,
    },
  ],
});
