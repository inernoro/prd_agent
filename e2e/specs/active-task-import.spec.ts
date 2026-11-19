import { expect, test } from '@playwright/test';

test.use({
  video: 'off',
  ...(process.env.E2E_CHROMIUM_EXECUTABLE
    ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } }
    : {}),
});

const permissions = ['access', 'active-tasks.use'];
const user = { userId: 'fixture-user', username: 'fixture', displayName: '测试成员', role: 'PM' };
const ok = (data: unknown) => ({ success: true, data, error: null });
const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

for (const device of ['桌面', '手机']) {
  test(`${device}首页与任务台导入：显示完整草稿，按所选内容提交并保留失败项`, async ({ page }) => {
    const mobile = device === '手机';
    await page.setViewportSize(mobile ? { width: 390, height: 740 } : { width: 1280, height: 800 });
    const colorScheme = mobile ? 'light' : 'dark';

    let taskReads = 0;
    let draftCount = 20;
    const writes: string[] = [];
    await page.addInitScript(({ permissions, user, colorScheme }) => {
      localStorage.setItem('prd-admin-auth', JSON.stringify({
        state: { isAuthenticated: true, permissions, permissionsLoaded: true, token: 'fixture-token', user },
        version: 0,
      }));
      localStorage.setItem('map-mobile-theme-v2', JSON.stringify({ state: { mode: colorScheme }, version: 0 }));
      localStorage.setItem('atb.welcome.seen.v1', '1');
    }, { permissions, user, colorScheme });

    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/authz/me') {
        return route.fulfill({ json: ok({ ...user, effectivePermissions: permissions, isRoot: false }) });
      }
      if (path === '/api/active-tasks/me') {
        taskReads++;
        return route.fulfill({ json: ok({
          active: { id: 'saved', title: '已有任务', state: 'active', running: true },
          standby: [], history: [], displayName: user.displayName, serverNow: new Date().toISOString(),
        }) });
      }
      if (path === '/api/active-tasks/import/stream') {
        const drafts = Array.from({ length: draftCount }, (_, index) => event('task', { title: `候选任务 ${index + 1}` }));
        return route.fulfill({
          contentType: 'text/event-stream',
          body: drafts.join('') + event('done', { count: draftCount }),
        });
      }
      if (path === '/api/active-tasks' && route.request().method() === 'POST') {
        const draft = route.request().postDataJSON() as { title: string };
        const failOnce = draft.title === '重试任务' && !writes.includes(draft.title);
        writes.push(draft.title);
        return failOnce
          ? route.fulfill({ status: 500, json: { success: false, data: null, error: { code: 'SERVER_ERROR', message: '添加失败' } } })
          : route.fulfill({ json: ok({ ...draft, id: `saved-${writes.length}` }) });
      }
      return route.fulfill({ status: 404, json: { success: false, data: null, error: { code: 'NOT_FOUND' } } });
    });

    await page.goto('/');
    await expect(mobile ? page.getByText('常用应用', { exact: true }) : page.getByRole('searchbox', { name: '搜索智能体、工具或平台能力' })).toBeVisible();
    if (mobile) await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    else await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('region', { name: '我的当前任务' })).toHaveCount(0);
    expect(taskReads).toBe(0);

    if (mobile) {
      await page.getByRole('button', { name: '打开导航菜单' }).click();
      const menu = page.getByRole('dialog', { name: '导航菜单' });
      await menu.getByRole('button', { name: '任务台', exact: true }).click();
    } else {
      await page.keyboard.press('Control+k');
      const palette = page.getByRole('dialog', { name: '命令面板' });
      await palette.getByPlaceholder('搜索 Agent、工具或页面...').fill('任务台');
      await palette.getByText('任务台', { exact: true }).click();
    }
    await expect(page.getByText('已有任务', { exact: true })).toBeVisible();

    const importTrigger = page.getByText('粘一段话，AI 帮你拆', { exact: true });
    const dialog = page.getByRole('dialog', { name: '粘一段话进来' });
    const titles = dialog.getByRole('textbox', { name: '任务标题', exact: true });
    const confirm = (count: number) => dialog.getByRole('button', { name: `加 ${count} 件`, exact: true });
    const newDraft = dialog.getByRole('button', { name: '新增一条', exact: true });
    await importTrigger.click();
    await dialog.getByRole('textbox', { name: '要拆的文字' }).fill('测试用会议纪要');
    await dialog.getByRole('button', { name: '拆开看看' }).click();
    await expect(confirm(20)).toBeEnabled();
    await expect(titles).toHaveCount(20);

    // 操作用户能滚动的浮层区域，防止测试直接聚焦输入框时绕过列表裁切。
    await dialog.locator('.atb-sheet__body').evaluate((body) => { body.scrollTop = body.scrollHeight; });
    await expect(titles.last()).toBeInViewport();
    await titles.last().fill('重试任务');
    await titles.first().fill('修改了标题');
    await titles.nth(1).fill('   ');
    await dialog.getByRole('button', { name: '不要这条：候选任务 3', exact: true }).click();
    await expect(confirm(18)).toBeEnabled();
    await newDraft.click();
    await expect(titles.last()).toBeFocused();
    await expect(confirm(18)).toBeEnabled();
    await titles.last().fill('手动补充');
    await confirm(19).click();
    await expect(confirm(1)).toBeEnabled();
    expect(writes).toEqual([
      '修改了标题',
      ...Array.from({ length: 16 }, (_, index) => `候选任务 ${index + 4}`),
      '重试任务', '手动补充',
    ]);
    await confirm(1).click();
    await expect(dialog).toBeHidden();
    expect(writes).toHaveLength(20);
    expect(writes.at(-1)).toBe('重试任务');

    draftCount = 0;
    await importTrigger.click();
    await dialog.getByRole('textbox', { name: '要拆的文字' }).fill('这段话没有任务');
    await dialog.getByRole('button', { name: '拆开看看' }).click();
    await expect(confirm(0)).toBeDisabled();
    await newDraft.click();
    await titles.last().fill('补一条空结果后的任务');
    await confirm(1).click();
    await expect(dialog).toBeHidden();
    expect(writes.at(-1)).toBe('补一条空结果后的任务');
  });
}
