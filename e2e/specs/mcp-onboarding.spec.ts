import { expect, test, devices, type Page } from '@playwright/test';

const user = process.env.MAP_AI_USER;
const password = process.env.MAP_ACCEPT_PASS;

test.use({ trace: 'off', video: 'off', permissions: ['clipboard-write'] });

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[type="text"]').fill(user!);
  await page.locator('input[type="password"]').fill(password!);
  await page.getByRole('button', { name: '进入控制台', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function checkClientSelection(page: Page) {
  const panel = page.getByRole('region', { name: 'MAP 配套技能', exact: true });
  await expect(panel).toContainText('服务发布版本');
  const codexDownload = await panel.getByRole('link', { name: '下载技能 ZIP' }).getAttribute('href');
  expect(codexDownload).toContain('/api/official-skills/map-agent/download');
  await panel.getByRole('combobox', { name: '技能安装客户端' }).selectOption('workbuddy');
  await expect(panel).toContainText('WorkBuddy');
  await expect(panel.getByRole('link', { name: '下载技能 ZIP' })).toHaveAttribute('href', /client=workbuddy/);
  await expect(panel).toContainText('网页无法读取本机已装版本');
  await panel.getByRole('button', { name: '复制版本检查', exact: true }).click();
  await expect(panel.getByRole('button', { name: '复制版本检查已复制', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '接入新的', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '接入你的智能体' });
  await expect(dialog.getByRole('button', { name: 'Codex', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('textbox')).toHaveValue('我的 Codex');
  await dialog.getByRole('button', { name: 'WorkBuddy', exact: true }).click();
  await expect(dialog.getByRole('textbox')).toHaveValue('我的 WorkBuddy');
  await dialog.getByRole('textbox').fill('验收自定义客户端名');
  await dialog.getByRole('button', { name: 'Codex', exact: true }).click();
  await expect(dialog.getByRole('textbox')).toHaveValue('验收自定义客户端名');
  await dialog.getByRole('button', { name: 'WorkBuddy', exact: true }).click();
  await expect(dialog.getByRole('textbox')).toHaveValue('验收自定义客户端名');
  // 停在签发前即可证明客户端选择，截图中不产生或暴露长期凭据。
  await expect(dialog.getByRole('button', { name: '生成接入配置', exact: true })).toBeEnabled();
}

test.describe('接入台真实导航与客户端引导', () => {
  test.skip(!user || !password || !process.env.E2E_BASE_URL, '需要预览域名和表单登录凭据');

  for (const theme of ['白天', '黑夜']) {
    test(`桌面${theme}可从账号菜单取得技能并选择 WorkBuddy`, async ({ page }, testInfo) => {
      await login(page);
      await page.getByRole('button', { name: '打开用户菜单', exact: true }).click();
      await page.getByRole('menuitemradio', { name: theme, exact: true }).click();
      await page.getByRole('menuitem', { name: '智能体接入台', exact: true }).click();
      await expect(page).toHaveURL(/\/mcp-console/);
      await expect(page.getByRole('heading', { name: '智能体接入台', exact: true })).toBeVisible();
      await checkClientSelection(page);
      await page.screenshot({ path: testInfo.outputPath(`mcp-${theme}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    });
  }

  test.describe('移动触控', () => {
    test.use({
      viewport: devices['iPhone 13'].viewport,
      userAgent: devices['iPhone 13'].userAgent,
      deviceScaleFactor: devices['iPhone 13'].deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
    });

    test('从导航菜单进入并完成客户端切换', async ({ page }, testInfo) => {
      await login(page);
      await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
      await page.getByRole('button', { name: '智能体接入台', exact: true }).click();
      await expect(page).toHaveURL(/\/mcp-console/);
      await checkClientSelection(page);
      await page.screenshot({ path: testInfo.outputPath('mcp-mobile.png') });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    });
  });
});
