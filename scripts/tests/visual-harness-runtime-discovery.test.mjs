import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const harness = new URL('../../.claude/skills/create-visual-test-to-kb/scripts/harness.mjs', import.meta.url);
test('实际验收harness导入不依赖固定机器的Playwright绝对目录，也不启动浏览器', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const h = await import(${JSON.stringify(harness.href)}); if (typeof h.loadConfig !== 'function') process.exit(2);`],
    { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
});

test('运行时优先使用明确路径，配置失效不隐式换到其它安装', async () => {
  const { loadPlaywright } = await import('../../.claude/skills/create-visual-test-to-kb/scripts/playwright-runtime.mjs');
  const seen = [];
  assert.throws(() => loadPlaywright({ env: { PWPATH: '/synthetic/explicit' }, root: '/synthetic/repo',
    load(candidate) { seen.push(candidate); throw Error('missing'); } }), /PWPATH/);
  assert.deepEqual(seen, ['/synthetic/explicit']);
});
test('缺失全局安装时发现项目原锁定运行时，不安装软件或启动浏览器', async () => {
  const { loadPlaywright } = await import('../../.claude/skills/create-visual-test-to-kb/scripts/playwright-runtime.mjs');
  let launches = 0; const expected = { chromium: { launch() { launches++; } } };
  const seen = [];
  const runtime = loadPlaywright({ env: {}, root: '/synthetic/repo', load(candidate) {
    seen.push(candidate); if (candidate.endsWith('e2e/node_modules/@playwright/test')) return expected;
    throw Error('missing');
  } });
  assert.equal(runtime, expected); assert.equal(launches, 0);
  assert.deepEqual(seen, ['playwright', '/synthetic/repo/e2e/node_modules/@playwright/test']);
});
