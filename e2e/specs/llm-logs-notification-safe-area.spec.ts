import { expect, test } from '@playwright/test';

const hasSyntheticLogin = Boolean(
  process.env.STABLE_SMOKE_AI_ACCESS_KEY?.trim()
  && process.env.STABLE_SMOKE_USER?.trim(),
);

test.describe('请求日志分页与通知浮标', () => {
  test.skip(!hasSyntheticLogin, '需要专用合成验收账号');

  test('普通鼠标可以点击下一页且热区不被通知浮标覆盖', async ({ page, request }) => {
    await page.route('**/api/logs/llm*', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET') return route.continue();
      if (url.pathname.endsWith('/meta')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { providers: ['openai'], models: ['gpt-4o-mini'], appCallerCodes: [], statuses: ['completed'] },
            error: null,
          }),
        });
      }
      if (url.pathname.endsWith('/timeseries')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { items: [{ date: new Date().toISOString(), count: 60 }] }, error: null }),
        });
      }
      if (url.pathname === '/api/logs/llm') {
        const currentPage = Number(url.searchParams.get('page') || 1);
        const items = Array.from({ length: 30 }, (_, index) => ({
          id: `notification-safe-area-${currentPage}-${index}`,
          requestId: `req-${currentPage}-${index}`,
          startedAt: new Date(Date.now() - index * 60_000).toISOString(),
          model: 'gpt-4o-mini',
          provider: 'openai',
          platformName: 'OpenAI',
          appCallerCode: 'daily-visual-fix',
          appCallerCodeDisplayName: '视觉复测',
          status: 'completed',
          statusCode: 200,
          inputTokens: 120,
          outputTokens: 80,
          durationMs: 1000,
          requestType: 'chat',
          isStreaming: true,
          userDisplayName: '合成验收账号',
        }));
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { items, total: 60, page: currentPage, pageSize: 30 }, error: null }),
        });
      }
      return route.continue();
    });

    await page.route('**/api/dashboard/notifications*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            items: [{
              id: 'llm-logs-notification-safe-area',
              title: '页面交互复测通知',
              message: '用于验证通知入口不会遮挡请求日志分页',
              level: 'info',
              status: 'open',
              section: 'personal',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }],
          },
          error: null,
        }),
      });
    });

    const ticketResponse = await request.post('/api/v1/auth/synthetic/ticket', {
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Access-Key': process.env.STABLE_SMOKE_AI_ACCESS_KEY!.trim(),
        'X-AI-Impersonate': process.env.STABLE_SMOKE_USER!.trim(),
      },
      data: { returnUrl: '/', expiresInSeconds: 180 },
    });
    const ticketBody = await ticketResponse.json() as {
      success: boolean;
      data?: { loginUrl?: string };
      error?: { message?: string };
    };
    expect(ticketResponse.ok(), ticketBody.error?.message || '合成登录入口创建失败').toBe(true);
    expect(ticketBody.success, ticketBody.error?.message || '合成登录入口创建失败').toBe(true);

    await page.goto(ticketBody.data!.loginUrl!);
    await page.waitForURL((url) => url.pathname !== '/synthetic-login');
    await page.keyboard.press('Meta+K');
    await page.getByPlaceholder(/搜索|输入/).last().fill('请求日志');
    await page.getByText('请求日志', { exact: true }).last().click();
    await page.waitForURL((url) => url.pathname === '/logs');
    const pagerLabel = page.getByText('共 60 条 · 第 1/2 页', { exact: true });
    await expect(pagerLabel).toBeVisible();

    await page.getByRole('button', { name: '收缩通知' }).click();
    const notification = page.getByRole('button', { name: '展开通知' });
    const next = pagerLabel.locator('..').getByRole('button').nth(1);
    await expect(notification).toBeVisible();
    await expect(next).toBeEnabled();

    const [notificationBox, nextBox] = await Promise.all([notification.boundingBox(), next.boundingBox()]);
    expect(notificationBox).not.toBeNull();
    expect(nextBox).not.toBeNull();
    expect(nextBox!.x + nextBox!.width).toBeLessThanOrEqual(notificationBox!.x);

    await next.click();
    await expect(page.getByText('共 60 条 · 第 2/2 页', { exact: true })).toBeVisible();
  });
});
