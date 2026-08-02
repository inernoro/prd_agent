import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';

type TicketResponse = {
  success: boolean;
  data?: { loginUrl?: string; ticketId?: string; expiresAt?: string };
  error?: { code?: string; message?: string };
};

const modules = [
  { key: 'visual', label: '视觉创作', path: '/visual-agent' },
  { key: 'literary', label: '文学创作', path: '/literary-agent' },
  { key: 'video', label: '视频创作', path: '/video-agent' },
  { key: 'transcript', label: '录音与上传解析', path: '/transcript-agent' },
  { key: 'multi-image', label: '多图视觉创作', path: '/visual-agent' },
  { key: 'llmgw', label: '模型网关配置', path: '/open-platform' },
] as const;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}，无法执行合成登录冒烟测试。`);
  return value;
}

async function issueTicket(request: APIRequestContext, returnUrl: string) {
  const response = await request.post('/api/v1/auth/synthetic/ticket', {
    headers: {
      'X-AI-Access-Key': requiredEnv('STABLE_SMOKE_AI_ACCESS_KEY'),
      'X-AI-Impersonate': requiredEnv('STABLE_SMOKE_USER'),
    },
    data: { returnUrl, expiresInSeconds: 180 },
  });
  const body = await response.json() as TicketResponse;
  expect(response.status(), body.error?.message || '生成合成登录入口失败').toBe(200);
  expect(body.success, body.error?.message || '生成合成登录入口失败').toBe(true);
  expect(body.data?.loginUrl).toMatch(/^\/synthetic-login\?code=/);
  return body.data?.loginUrl || '';
}

async function openModule(
  page: Page,
  request: APIRequestContext,
  module: typeof modules[number],
  testInfo: TestInfo,
) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|ResizeObserver/i.test(message.text())) {
      errors.push(message.text());
    }
  });

  const loginUrl = await issueTicket(request, module.path);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((url) => url.pathname.startsWith(module.path), { timeout: 30_000 });
  await expect(page.locator('body')).not.toBeEmpty();
  await expect(page.locator('body')).not.toContainText('合成测试登录未完成');
  await page.waitForTimeout(800);
  expect(errors, `${module.label} 页面出现前端运行错误`).toEqual([]);

  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach(`${module.key}-${testInfo.project.name}`, {
    body: screenshot,
    contentType: 'image/png',
  });
}

test.describe('稳定冒烟：双环境合成登录与模块入口', () => {
  for (const module of modules) {
    test(`${module.label}可通过短时测试会话打开`, async ({ page, request }, testInfo) => {
      await openModule(page, request, module, testInfo);
    });
  }

  test('移动端核心入口无横向溢出', async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const module = modules[0];
    await openModule(page, request, module, testInfo);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
