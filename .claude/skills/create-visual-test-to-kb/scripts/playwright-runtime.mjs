import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export function loadPlaywright({ env = process.env, root = repositoryRoot, load = require } = {}) {
  const explicit = env.PWPATH?.trim();
  const candidates = explicit ? [explicit] : [
    'playwright',
    resolve(root, 'e2e/node_modules/@playwright/test'),
    resolve(root, 'cds/node_modules/playwright'),
    '/opt/node22/lib/node_modules/playwright',
  ];
  for (const candidate of candidates) {
    try {
      const runtime = load(candidate);
      if (runtime.chromium?.launch) return runtime;
    } catch {
      // 缺失的候选运行时只继续发现，不输出机器路径或异常堆栈。
    }
  }
  throw new Error(explicit
    ? '配置的 Playwright 运行时不可用，请修复 PWPATH 后重试。'
    : '未找到 Playwright，请在项目 e2e 或 CDS 模块安装锁定依赖后重试。');
}
