import { expect, test } from '@playwright/test';
import { installMarketplaceFixture } from '../fixtures/marketplace';

test.use({ video: 'off', ...(process.env.E2E_CHROMIUM_EXECUTABLE ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } } : {}) });

test('市场平铺：实际组件铺满可用宽度，搜索、分类与角色筛选仍使用原逻辑', async ({ page }) => {
  await installMarketplaceFixture(page);
  await page.setViewportSize({ width: 2560, height: 1200 });
  await page.goto('/marketplace');
  await expect(page.locator('.mkt-card-density-tile')).toHaveCount(24, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: '技能', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const geometry = await page.locator('.marketplace-tile-grid').evaluate(el => {
    const grid = el.getBoundingClientRect();
    const content = el.closest('.marketplace-results-scroll')!;
    const host = content.getBoundingClientRect();
    return { width: grid.width, left: grid.left - host.left, right: host.right - grid.right,
      padding: parseFloat(getComputedStyle(content).paddingLeft) };
  });
  expect(geometry.width).toBeGreaterThan(2000);
  expect(geometry.left).toBeCloseTo(geometry.padding, 0);
  expect(geometry.right).toBeCloseTo(geometry.padding, 0);
  await page.setViewportSize({ width: 820, height: 1100 });
  const uploadBox = await page.getByRole('button', { name: '上传技能', exact: true }).boundingBox();
  const toolbarBox = await page.locator('.marketplace-workspace-toolbar').boundingBox();
  expect(uploadBox!.x + uploadBox!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width);
  await page.setViewportSize({ width: 2560, height: 1200 });
  await page.getByPlaceholder('搜索名称、描述').fill('Git');
  await expect(page.locator('.mkt-card')).toHaveCount(2);
  await page.getByRole('button', { name: '清空筛选' }).click();
  const roles = page.locator('[data-tour-id="marketplace-role-row"]');
  await roles.getByRole('button', { name: '产品经理', exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(8);
  await page.getByRole('button', { name: '清空筛选' }).click();
  await page.locator('[data-tour-id="marketplace-tag-filters"]').getByRole('button', { name: /工具/ }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(12);
  await page.getByRole('button', { name: '清空筛选' }).click();
  await page.getByRole('button', { name: /^显示/ }).click();
  const request = page.waitForRequest(req => req.url().includes('/api/marketplace/skills?') && req.url().includes('sort=new'));
  await page.getByRole('button', { name: '最新', exact: true }).click();
  await request;
  await page.getByRole('button', { name: '小', exact: true }).click();
  await expect(page.locator('.marketplace-workspace')).toHaveAttribute('data-card-size', 'small');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '提示词', exact: true }).click();
  await expect(page).toHaveURL(/type=prompt/);
  await expect(page.locator('.marketplace-empty')).toBeVisible();
  await expect(page.locator('[aria-label="接入 AI"]')).toHaveCount(0);
});

test('接入 AI 桌面浮层宽度固定且描述按设计换行', async ({ page }) => {
  await installMarketplaceFixture(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/marketplace');
  await expect(page.locator('.mkt-card')).toHaveCount(24, { timeout: 30_000 });
  await page.getByRole('button', { name: '接入 AI', exact: true }).click();
  const panel = page.locator('.marketplace-quick-connect');
  await expect(panel).toBeVisible();
  expect((await panel.boundingBox())!.width).toBeCloseTo(380, 0);
});

test('手机筛选和接入浮层：小屏不横溢出，生成结果与 Esc 关闭可见', async ({ page }) => {
  await installMarketplaceFixture(page);
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto('/marketplace');
  await expect(page.locator('.mkt-card-density-tile')).toHaveCount(24, { timeout: 30_000 });
  await expect(page.locator('.marketplace-filter-rail')).toHaveCount(0);
  const categoryAnchor = page.locator('[data-tour-id="marketplace-category-tabs"]');
  await expect(categoryAnchor).toBeVisible();
  await expect(categoryAnchor).toHaveCount(1);
  await page.getByRole('button', { name: /^筛选/ }).click();
  await expect(categoryAnchor).toHaveCount(1);
  await page.getByRole('button', { name: '产品经理', exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(8);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '接入 AI', exact: true }).click();
  await page.getByRole('button', { name: '一键生成', exact: true }).click();
  await expect(page.getByRole('button', { name: '复制给 AI 使用（一键接入）', exact: true })).toBeVisible();
  const box = await page.locator('.marketplace-quick-connect').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  await page.keyboard.press('Escape');
  await expect(page.locator('.marketplace-quick-connect')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test('个人技能范围：收藏即时移除、分类联动及上传元信息准确', async ({ page }) => {
  await installMarketplaceFixture(page);
  await page.goto('/marketplace?scope=favorites');
  await expect(page.locator('.mkt-card')).toHaveCount(3, { timeout: 30_000 });
  await expect(page.locator('.mkt-card-uploaded-at').first()).toHaveText('上传于 2026-10-01');
  await expect(page.locator('.mkt-card-uploaded-at').first()).toHaveAttribute('datetime', '2026-10-01T00:00:00Z');
  await expect(page.locator('.mkt-card-version').first()).toHaveText('v1.0.0');
  await page.locator('[data-tour-id="marketplace-tag-filters"]').getByRole('button', { name: '工具 2', exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(2);
  await page.locator('.mkt-card').filter({ hasText: 'dev-starter · 开发入门套装 · 进阶' }).getByTitle('取消收藏', { exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(1);
  await page.getByRole('button', { name: '我的技能', exact: true }).click();
  await expect(page).toHaveURL(/scope=mine/);
  await expect(page.locator('.mkt-card')).toHaveCount(4);
  await expect(page.locator('.mkt-card').getByTitle('编辑', { exact: true })).toHaveCount(4);
  await expect(page.locator('[data-tour-id="marketplace-tag-filters"]').getByRole('button', { name: '工具 4', exact: true })).toBeVisible();
  await page.getByPlaceholder('搜索名称、描述').fill('html-ppt');
  await expect(page.locator('.mkt-card')).toHaveCount(2);
  await page.getByRole('button', { name: '我的收藏', exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(2);
  await expect(page.getByPlaceholder('搜索名称、描述')).toHaveValue('');
  await page.getByRole('button', { name: '全部内容', exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(24);
  await expect(page.locator('.mkt-card').filter({ has: page.getByTitle('monthly-report', { exact: true }) }).locator('.mkt-card-version')).toHaveCount(0);
  await page.getByPlaceholder('搜索名称、描述').fill('goal-pipeline-board');
  await expect(page.locator('.mkt-card').filter({ has: page.getByTitle('goal-pipeline-board', { exact: true }) }).locator('.mkt-card-version')).toHaveText('v2.0.0');
});

test('个人列表请求失败可重试，取消收藏失败保留列表与状态', async ({ page }) => {
  await installMarketplaceFixture(page);
  await page.route('**/api/marketplace/skills?*scope=favorites*', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { code: 'TEMPORARY', message: '暂时不可用' } }),
  }));
  await page.goto('/marketplace?scope=favorites');
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.mkt-card')).toHaveCount(0);
  await page.unroute('**/api/marketplace/skills?*scope=favorites*');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.mkt-card')).toHaveCount(3);
  await page.route('**/api/marketplace/skills/*/unfavorite', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: '暂时不可用' } }),
  }));
  const favorite = page.locator('.mkt-card-favorite').first();
  await favorite.click();
  await expect(favorite).toBeEnabled();
  await expect(favorite).toHaveAttribute('data-active', 'true');
  await expect(page.locator('.mkt-card')).toHaveCount(3);
});

for (const scope of ['all', 'mine'] as const) {
  test(`取消收藏延迟返回不能移除已切换的${scope}范围卡片`, async ({ page }) => {
    test.setTimeout(120_000);
    const items = await installMarketplaceFixture(page);
    const item = items.find(item => item.id === 'fixture-skill-20')!;
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
    await page.route(`**/api/marketplace/skills/${item.id}/unfavorite`, async route => {
      await responseGate;
      item.isFavoritedByCurrentUser = false;
      item.favoriteCount = 0;
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { item }, error: null }) });
    });
    try {
      await page.goto('/marketplace?scope=favorites');
      await expect(page.locator('.mkt-card')).toHaveCount(3, { timeout: 60_000 });
      const card = page.locator('.mkt-card').filter({ has: page.getByTitle(item.title, { exact: true }) });
      const requestStarted = page.waitForRequest(request => request.url().endsWith(`/${item.id}/unfavorite`));
      await card.getByTitle('取消收藏', { exact: true }).click();
      await requestStarted;
      await page.getByRole('button', { name: scope === 'all' ? '全部内容' : '我的技能', exact: true }).click();
      const count = scope === 'all' ? 24 : 4;
      await expect(page.locator('.mkt-card')).toHaveCount(count);
      await expect(card).toBeVisible();
      const response = page.waitForResponse(response => response.url().endsWith(`/${item.id}/unfavorite`));
      releaseResponse();
      await (await response).finished();
      await page.waitForLoadState('networkidle');
      await expect(page.locator('.mkt-card')).toHaveCount(count);
      await expect(card).toBeVisible();
      await expect(card.locator('.mkt-card-favorite')).toHaveAttribute('data-active', 'false');
    } finally {
      releaseResponse();
    }
  });
}

for (const refreshFails of [false, true]) {
  test(`收藏确认晚于切换范围时，新收藏与计数进入当前个人列表（刷新${refreshFails ? '失败' : '成功'}）`, async ({ page }) => {
    const items = await installMarketplaceFixture(page);
    const item = items.find(item => item.id === 'fixture-skill-4')!;
    let releaseFavorite!: () => void;
    const gate = new Promise<void>(resolve => { releaseFavorite = resolve; });
    await page.route(`**/api/marketplace/skills/${item.id}/favorite`, async route => {
      await gate;
      item.isFavoritedByCurrentUser = true;
      item.favoriteCount = 1;
      await route.fulfill({ json: { success: true, data: { item }, error: null } });
    });
    try {
      await page.goto('/marketplace');
      await expect(page.locator('.mkt-card')).toHaveCount(24, { timeout: 30_000 });
      const card = page.locator('.mkt-card').filter({ has: page.getByTitle(item.title, { exact: true }) });
      const started = page.waitForRequest(request => request.url().endsWith(`/${item.id}/favorite`));
      await card.getByTitle('收藏', { exact: true }).click();
      await started;
      await page.getByRole('button', { name: '我的收藏', exact: true }).click();
      await expect(page.locator('.mkt-card')).toHaveCount(3);
      if (refreshFails) await page.route('**/api/marketplace/skills?*', route => route.fulfill({
        status: 503, json: { success: false, error: { code: 'TEMPORARY', message: '暂时不可用' } },
      }));
      releaseFavorite();
      await expect(page.locator('.mkt-card')).toHaveCount(4);
      await expect(card.locator('.mkt-card-favorite')).toHaveAttribute('data-active', 'true');
      await expect(page.locator('[data-tour-id="marketplace-tag-filters"]').getByRole('button', { name: '工具 3', exact: true })).toBeVisible();
      if (refreshFails) {
        await expect(page.getByText('列表刷新失败', { exact: true })).toBeVisible();
        await expect(page.locator('.marketplace-empty[role="alert"]')).toHaveCount(0);
        await page.unroute('**/api/marketplace/skills?*');
        await page.getByRole('button', { name: /^显示/ }).click();
        await page.getByRole('button', { name: '最新', exact: true }).click();
        await page.waitForLoadState('networkidle');
        await expect(page.locator('.mkt-card')).toHaveCount(4);
        await expect(card.locator('.mkt-card-favorite')).toHaveAttribute('data-active', 'true');
      }
    } finally {
      releaseFavorite();
    }
  });
}

for (const responseOrder of ['list-first', 'favorite-first'] as const) {
  test(`取消收藏与同范围排序并发：${responseOrder} 保留已确认结果`, async ({ page }) => {
    const items = await installMarketplaceFixture(page);
    const item = items.find(item => item.id === 'fixture-skill-20')!;
    let releaseFavorite!: () => void;
    let releaseList!: () => void;
    let listCaptured!: () => void;
    const favoriteGate = new Promise<void>(resolve => { releaseFavorite = resolve; });
    const listGate = new Promise<void>(resolve => { releaseList = resolve; });
    const captured = new Promise<void>(resolve => { listCaptured = resolve; });
    await page.route(`**/api/marketplace/skills/${item.id}/unfavorite`, async route => {
      await favoriteGate;
      item.isFavoritedByCurrentUser = false;
      item.favoriteCount = 0;
      await route.fulfill({ json: { success: true, data: { item }, error: null } });
    });
    await page.route('**/api/marketplace/skills?*sort=new*', async route => {
      const body = JSON.stringify({ success: true, data: { items: items.filter(item => item.isFavoritedByCurrentUser) }, error: null });
      listCaptured();
      await listGate;
      await route.fulfill({ contentType: 'application/json', body });
    });
    try {
      await page.goto('/marketplace?scope=favorites');
      await expect(page.locator('.mkt-card')).toHaveCount(3, { timeout: 30_000 });
      const card = page.locator('.mkt-card').filter({ has: page.getByTitle(item.title, { exact: true }) });
      const favoriteStarted = page.waitForRequest(request => request.url().endsWith(`/${item.id}/unfavorite`));
      await card.getByTitle('取消收藏', { exact: true }).click();
      await favoriteStarted;
      await page.getByRole('button', { name: /^显示/ }).click();
      await page.getByRole('button', { name: '最新', exact: true }).click();
      await captured;
      const favoriteResponse = page.waitForResponse(response => response.url().endsWith(`/${item.id}/unfavorite`));
      if (responseOrder === 'list-first') {
        releaseList();
        await expect(page.locator('.mkt-card')).toHaveCount(3);
        releaseFavorite();
        await (await favoriteResponse).finished();
      } else {
        releaseFavorite();
        await (await favoriteResponse).finished();
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        releaseList();
      }
      await page.waitForLoadState('networkidle');
      await expect(page.locator('.mkt-card')).toHaveCount(2);
      await expect(card).toHaveCount(0);
    } finally {
      releaseFavorite();
      releaseList();
    }
  });
}

for (const scope of ['mine', 'favorites'] as const) {
  test(`个人筛选在 ${scope} 请求完成前不展示上一范围的数据`, async ({ page }) => {
    await installMarketplaceFixture(page);
    let releaseList!: () => void;
    const gate = new Promise<void>(resolve => { releaseList = resolve; });
    await page.route(`**/api/marketplace/skills?*scope=${scope}*`, async route => {
      await gate;
      await route.fallback();
    });
    try {
      await page.goto('/marketplace');
      await expect(page.locator('.mkt-card')).toHaveCount(24, { timeout: 30_000 });
      await expect(page.locator('[data-tour-id="marketplace-tag-filters"]')).toBeVisible();
      const started = page.waitForRequest(request => request.url().includes(`scope=${scope}`));
      await page.getByRole('button', { name: scope === 'mine' ? '我的技能' : '我的收藏', exact: true }).click();
      await started;
      await expect(page.locator('.mkt-card')).toHaveCount(0);
      await expect(page.locator('[data-tour-id="marketplace-tag-filters"]')).toHaveCount(0);
      await expect(page.locator('[data-tour-id="marketplace-role-row"]')).toHaveCount(0);
      releaseList();
      await expect(page.locator('.mkt-card')).toHaveCount(scope === 'mine' ? 4 : 3);
      await expect(page.locator('[data-tour-id="marketplace-tag-filters"]').getByRole('button', {
        name: scope === 'mine' ? '工具 4' : '工具 2', exact: true,
      })).toBeVisible();
    } finally {
      releaseList();
    }
  });
}

test('收藏后台只刷新技能，无关类型故障不触发刷新失败提示', async ({ page }) => {
  const items = await installMarketplaceFixture(page);
  const item = items.find(item => item.id === 'fixture-skill-20')!;
  await page.goto('/marketplace');
  await expect(page.locator('.mkt-card')).toHaveCount(24, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  const unrelatedRequests: string[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/marketplace') && path !== '/api/marketplace/skills') {
      unrelatedRequests.push(path);
      await route.fulfill({ status: 503, json: { success: false, error: { code: 'TEMPORARY', message: '无关类型暂时不可用' } } });
    } else await route.fallback();
  });
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/marketplace/skills' && response.ok());
  const card = page.locator('.mkt-card').filter({ has: page.getByTitle(item.title, { exact: true }) });
  await card.getByTitle('取消收藏', { exact: true }).click();
  await refreshed;
  await page.waitForLoadState('networkidle');
  await expect(card.locator('.mkt-card-favorite')).toHaveAttribute('data-active', 'false');
  await expect(page.locator('.mkt-card')).toHaveCount(24);
  expect(unrelatedRequests).toEqual([]);
  await expect(page.getByText('列表刷新失败', { exact: true })).toHaveCount(0);
});

for (const scope of ['all', 'favorites'] as const) {
  test(`收藏后台刷新失败保留 ${scope} 已确认内容并可恢复`, async ({ page }) => {
    const items = await installMarketplaceFixture(page);
    const item = items.find(item => item.id === 'fixture-skill-20')!;
    await page.goto(scope === 'all' ? '/marketplace' : '/marketplace?scope=favorites');
    await expect(page.locator('.mkt-card')).toHaveCount(scope === 'all' ? 24 : 3, { timeout: 30_000 });
    await page.route('**/api/marketplace/skills?*', route => route.fulfill({
      status: 503, json: { success: false, error: { code: 'TEMPORARY', message: '暂时不可用' } },
    }));
    const failed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/marketplace/skills' && response.status() === 503);
    const card = page.locator('.mkt-card').filter({ has: page.getByTitle(item.title, { exact: true }) });
    await card.getByTitle('取消收藏', { exact: true }).click();
    await (await failed).finished();
    await page.waitForLoadState('networkidle');
    const expected = scope === 'all' ? 24 : 2;
    await expect(page.locator('.mkt-card')).toHaveCount(expected);
    await expect(page.getByText('列表刷新失败', { exact: true })).toBeVisible();
    await expect(page.locator('.marketplace-empty[role="alert"]')).toHaveCount(0);
    if (scope === 'all') await expect(card.locator('.mkt-card-favorite')).toHaveAttribute('data-active', 'false');
    else await expect(card).toHaveCount(0);
    await page.unroute('**/api/marketplace/skills?*');
    await page.getByRole('button', { name: /^显示/ }).click();
    const refreshed = page.waitForResponse(response => response.url().includes('sort=new') && new URL(response.url()).pathname === '/api/marketplace/skills' && response.ok());
    await page.getByRole('button', { name: '最新', exact: true }).click();
    await refreshed;
    await expect(page.locator('.mkt-card')).toHaveCount(expected);
  });
}

test('网页创作与市场共用显示控件，样式一致且偏好各自保留', async ({ page }) => {
  test.setTimeout(180_000);
  await installMarketplaceFixture(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  const styles: unknown[] = [];
  for (const route of ['/marketplace', '/web-pages']) {
    await page.goto(route);
    const trigger = page.getByRole('button', { name: /^显示/ });
    await trigger.waitFor({ timeout: 30_000 });
    await trigger.click();
    const panel = page.locator('[data-list-display-options]');
    await expect(panel).toBeVisible();
    await panel.evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    const sizes = panel.getByRole('group', { name: '卡片尺寸', exact: true });
    const medium = sizes.getByRole('button', { name: '中', exact: true });
    await expect(medium).toHaveAttribute('aria-pressed', 'true');
    styles.push(await medium.evaluate(button => {
      const style = getComputedStyle(button);
      const group = getComputedStyle(button.parentElement!);
      const label = getComputedStyle(button.closest('[data-list-display-options]')!.querySelector('.text-token-muted')!);
      return { height: style.height, fontSize: style.fontSize, radius: style.borderRadius,
        weight: style.fontWeight, background: style.backgroundColor, color: style.color, shadow: style.boxShadow,
        groupBorder: group.border, groupRadius: group.borderRadius, padding: group.padding,
        labelSize: label.fontSize, labelColor: label.color };
    }));
    await panel.getByRole('group', { name: '排序', exact: true }).getByRole('button', {
      name: route === '/marketplace' ? '最新' : '最早', exact: true,
    }).click();
    await sizes.getByRole('button', { name: route === '/marketplace' ? '小' : '大', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.reload();
    await page.getByRole('button', { name: /^显示/ }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: /^显示/ }).click();
    await expect(page.getByRole('group', { name: '卡片尺寸', exact: true }).getByRole('button', {
      name: route === '/marketplace' ? '小' : '大', exact: true,
    })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('group', { name: '排序', exact: true }).getByRole('button', {
      name: route === '/marketplace' ? '最新' : '最早', exact: true,
    })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
  }
  expect(styles[0]).toEqual(styles[1]);
  await page.goto('/marketplace');
  await page.getByRole('button', { name: /^显示/ }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: /^显示/ }).click();
  await expect(page.getByRole('group', { name: '卡片尺寸', exact: true }).getByRole('button', { name: '小', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
});
