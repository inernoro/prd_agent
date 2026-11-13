import { test, expect, type Page } from '@playwright/test';
import { installOperationsFixtures } from '../fixtures/admin-operations.mjs';

test.beforeEach(async ({ browser, page }, info) => {
  info.annotations.push({ type: 'engine-version', description: browser.version() });
  page.on('pageerror', error => info.annotations.push({ type: 'pageerror', description: error.message }));
});
test.afterEach(async ({}, info) => {
  expect(info.annotations.filter(x => x.type === 'pageerror')).toEqual([]);
});

async function branchCard(page: Page) {
  await page.goto('http://127.0.0.1:5273/project-list');
  await page.getByText('窄屏样例项目', { exact: true }).first().click();
  const card = page.locator('[data-branch-card-id="compat-branch"]');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '发布到', exact: true }).click();
  return page.getByRole('dialog', { name: '发布到', exact: true });
}

for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
  test(`分支卡片 ${width} ${theme} 选择环境即发布`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const fixture = await installOperationsFixtures(page);
    fixture.setPreflightPass(true);
    fixture.setReleaseTargets([{ id: 'compat-target', projectId: 'fixture-project', name: '预发环境', type: 'site', isEnabled: true }]);
    await page.addInitScript(t => localStorage.setItem('cds_theme', t), theme);
    const dialog = await branchCard(page);
    if (width === 320) await page.evaluate(() => document.documentElement.style.fontSize = '200%');
    const option = dialog.getByRole('button', { name: '发布到 预发环境', exact: true });
    await option.scrollIntoViewIfNeeded();
    const bounds = await option.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await expect(dialog.getByText('选择一个环境，自动检查并发布当前分支。')).toBeVisible();
    const onboarding = dialog.getByRole('button', { name: '接入新环境', exact: true });
    await onboarding.scrollIntoViewIfNeeded();
    // 按钮边界在屏内仍可能有 nowrap 文字溢出；检查实际内容宽度。
    expect(await onboarding.evaluate(button => button.scrollWidth <= button.clientWidth)).toBe(true);
    const record = dialog.getByRole('link', { name: '发布记录', exact: true });
    await record.scrollIntoViewIfNeeded();
    expect(await record.evaluate(link => link.scrollWidth <= link.clientWidth)).toBe(true);
    await option.scrollIntoViewIfNeeded();
    const optionBox = await option.boundingBox();
    const titleBox = await dialog.getByRole('heading', { name: '发布到', exact: true }).boundingBox();
    const footerBox = await record.boundingBox();
    expect(optionBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height);
    expect(optionBox!.y + optionBox!.height).toBeLessThanOrEqual(footerBox!.y);
    expect(fixture.writes.filter(x => x.path.endsWith('/runs'))).toHaveLength(0);
    await page.screenshot({ path: info.outputPath('branch-release-environments.png') });
    await dialog.getByRole('button', { name: '发布到 预发环境', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '发布成功', exact: true })).toBeVisible();
    expect(fixture.writes.filter(x => x.path.endsWith('/runs'))).toEqual([{ path: '/api/releases/branches/compat-branch/runs', method: 'POST', body: { targetId: 'compat-target', previewUrl: 'https://example.test' } }]);
    await page.screenshot({ path: info.outputPath('branch-release-success.png') });
  });
}

test('Agent 接入环境后在原窗口出现，排除其他项目、停用与归档环境', async ({ page }) => {
  const fixture = await installOperationsFixtures(page);
  fixture.setPreflightPass(true);
  fixture.setReleaseTargets([
    { id: 'foreign', name: '其他项目', projectId: 'other', isEnabled: true },
    { id: 'disabled', name: '停用环境', projectId: 'fixture-project', isEnabled: false },
    { id: 'archived', name: '归档环境', projectId: 'fixture-project', isEnabled: true, lifecycle: 'archived' },
  ]);
  const dialog = await branchCard(page);
  await expect(dialog.getByText(/还没有发布环境/)).toBeVisible();
  // Agent 与 UI 共用同一个登记及列表合同；写入全部由测试夹具隔离。
  const registered = await page.evaluate(async () => {
    const response = await fetch('/api/releases/targets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Agent 新接入环境', projectId: 'fixture-project', environment: 'staging', host: 'new.example.test', port: 22, user: 'deploy', privateKeyRef: 'test-key-reference', appPath: '/srv/example', strategy: 'project-script', healthcheckUrl: 'https://new.example.test' }) });
    return response.status;
  });
  expect(registered).toBe(200);
  await expect(dialog.getByRole('button', { name: '发布到 Agent 新接入环境' })).toBeVisible({ timeout: 10000 });
  await expect(dialog.getByRole('button', { name: /发布到 (其他项目|停用环境|归档环境)/ })).toHaveCount(0);
  expect(fixture.writes.filter(x => x.path.endsWith('/runs'))).toHaveLength(0);
  await dialog.getByRole('button', { name: '发布到 Agent 新接入环境', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '发布成功', exact: true })).toBeVisible();
  expect(fixture.writes.filter(x => x.path.endsWith('/runs'))).toEqual([{ path: '/api/releases/branches/compat-branch/runs', method: 'POST', body: { targetId: 'compat-new-environment', previewUrl: 'https://example.test' } }]);
});

test('预检失败不会发布，修复后重新选择环境只发布一次', async ({ page }) => {
  const fixture = await installOperationsFixtures(page);
  fixture.setReleaseTargets([{ id: 'compat-target', projectId: 'fixture-project', name: '测试环境', isEnabled: true }]);
  const dialog = await branchCard(page);
  await dialog.getByRole('button', { name: '发布到 测试环境', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('未开始发布');
  expect(fixture.writes.filter(x => x.path.endsWith('/runs'))).toHaveLength(0);
  // 后台环境刷新不能抹掉检查失败的反馈。
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(dialog.getByRole('alert')).toContainText('未开始发布');
  fixture.setPreflightPass(true);
  await dialog.getByRole('button', { name: '发布到 测试环境', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '发布成功', exact: true })).toBeVisible();
  expect(fixture.writes.filter(x => x.path.endsWith('/runs'))).toHaveLength(1);
});

test('快速重复选择只受理一次发布', async ({ page }) => {
  const fixture = await installOperationsFixtures(page);
  fixture.setPreflightPass(true);
  fixture.setReleaseTargets([{ id: 'compat-target', projectId: 'fixture-project', name: '测试环境', isEnabled: true }]);
  const dialog = await branchCard(page);
  await dialog.getByRole('button', { name: '发布到 测试环境', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByRole('dialog', { name: '发布成功', exact: true })).toBeVisible();
  expect(fixture.writes.filter(x => x.path.endsWith('/preflight'))).toHaveLength(1);
  expect(fixture.writes.filter(x => x.path.endsWith('/runs'))).toHaveLength(1);
});

test('检查期间关闭窗口不会在后台开始发布', async ({ page }) => {
  const fixture = await installOperationsFixtures(page);
  fixture.setReleaseTargets([{ id: 'compat-target', projectId: 'fixture-project', name: '测试环境', isEnabled: true }]);
  let finishCheck!: () => void;
  let observed!: () => void;
  let served!: () => void;
  const gate = new Promise<void>(resolve => { finishCheck = resolve; });
  const entered = new Promise<void>(resolve => { observed = resolve; });
  const finished = new Promise<void>(resolve => { served = resolve; });
  await page.route('**/api/releases/branches/compat-branch/preflight', async route => {
    observed();
    await gate;
    try { await route.fulfill({ json: { ok: true, checks: [] } }); }
    finally { served(); }
  });
  const dialog = await branchCard(page);
  await dialog.getByRole('button', { name: '发布到 测试环境', exact: true }).click();
  await entered;
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  await expect(dialog).not.toBeVisible();
  finishCheck();
  await finished;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  expect(fixture.writes.filter(x => x.path.endsWith('/runs'))).toHaveLength(0);
});
