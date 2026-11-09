import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { startViteDevServer } from './lib/vite-dev-server.mjs';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

// 离线 UI 诊断：真实卡片及抽屉、合成 API 数据，不代替线上用户验收。
const { chromium } = createRequire(import.meta.url)('playwright');
const sha = 'a'.repeat(40);
const definitions = [
  ['not_triggered', '镜像构建未触发', '查看工作流'], ['cancelled', 'CI 已取消', '查看构建'],
  ['startup_failed', 'CI 启动失败', '查看构建'], ['unknown', 'CI 状态未确认', '查看 Actions'],
  ['queued', 'CI 等待执行', '查看构建'], ['building', 'CI 正在构建', '查看构建'],
];
const branches = definitions.map(([code, title, actionLabel], i) => ({
  id: `ci-${code}`, projectId: 'fixture-project', branch: `feature/${code}`, status: 'idle', services: {},
  createdAt: new Date().toISOString(), lastPushAt: new Date().toISOString(), ciTargetSha: sha,
  githubRepoFullName: 'example/fixture', ciImageStatus: ['queued', 'building'].includes(code) ? 'waiting' : 'failed',
  deployRuntime: { prebuilt: true, kind: 'release', label: '极速版', activeProfiles: 1, releaseProfiles: 1 },
  ciDiagnosis: { code, title, message: code === 'cancelled' ? '构建被 @fixture-user 身份取消。确认仍需预览后重新运行镜像构建。' : `${title}：请查看对应记录。`,
    targetSha: sha, checkedAt: new Date().toISOString(), actionLabel,
    actionUrl: actionLabel === '查看构建' ? `https://github.com/example/fixture/actions/runs/${100 + i}`
      : actionLabel === '查看工作流' ? `https://github.com/example/fixture/blob/${sha}/.github/workflows/branch-image.yml`
        : 'https://github.com/example/fixture/actions' },
}));
const output = process.env.CI_DIAGNOSIS_OUT || '/tmp/ci-image-diagnosis-ui';
fs.mkdirSync(output, { recursive: true });
const server = await startViteDevServer();
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await context.addInitScript(theme => localStorage.setItem('cds_theme', theme), theme);
    await context.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (isEventStream(path)) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
      const branch = branches.find(b => path === `/api/branches/${b.id}`);
      let body = path === '/api/branches' ? { branches, capacity: { maxContainers: 50, runningContainers: 0, totalMemGB: 64 } }
        : branch || resolveFixture(path) || {};
      if (path === '/api/projects/fixture-project') body = { ...body, branchCount: branches.length };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}/branch-list?project=fixture-project`);
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    const dormant = page.locator('section[aria-label="未运行的分支"]');
    await dormant.waitFor();
    if (!await page.locator('[data-branch-card-id="ci-cancelled"]').isVisible()) await dormant.getByRole('button').first().click();
    for (const [code, title, actionLabel] of definitions) {
      const card = page.locator(`[data-branch-card-id="ci-${code}"]`);
      await card.getByText(title, { exact: true }).waitFor();
      const link = card.getByRole('link', { name: actionLabel, exact: true });
      assert.equal(await link.count(), 1, `${theme}/${code} 有可用入口`);
      assert.match(await link.getAttribute('href'), /^https:\/\/github\.com\/example\/fixture\//);
    }
    await page.screenshot({ path: `${output}/${theme}-cards.png`, fullPage: true });
    await page.locator('[data-branch-card-id="ci-cancelled"]').getByText('CI 已取消', { exact: true }).click();
    const drawer = page.locator('.cds-branch-detail-drawer');
    await drawer.getByText('CI 已取消', { exact: true }).waitFor();
    assert.match(await drawer.innerText(), /@fixture-user/);
    await page.screenshot({ path: `${output}/${theme}-detail.png`, fullPage: true });
    assert.deepEqual(errors, [], '无浏览器运行异常');
    console.log(`PASS ${theme}: 六种原因、跳转入口和卡片到详情一致`);
    await context.close();
  }
} finally {
  await browser?.close();
  await server.stop();
}
