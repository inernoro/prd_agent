import { test, expect, devices } from '@playwright/test';

test.describe.configure({ retries: 0 });

for (const mobile of [false, true]) {
  test(`公开登录入口使用文档导航 ${mobile ? '手机' : '桌面'}`, async ({ browser }, testInfo) => {
    const context = await browser.newContext(mobile ? devices['iPhone 13'] : {});
    const page = await context.newPage();
    const baseURL = testInfo.project.use.baseURL as string;
    await page.goto(new URL('/home', baseURL).href, { waitUntil: 'networkidle' });
    await page.getByRole('navigation').waitFor({ state: 'visible' });
    const entry = page.locator('button:visible').filter({ hasText: '登录 / 注册' });
    await expect(entry).toHaveCount(1);
    await expect(entry).toBeVisible();
    // Authentication must not wait for the animated landing page's SPA transition.
    const box = await entry.boundingBox();
    expect(box).not.toBeNull();
    expect(await entry.evaluate(element => {
      const r = element.getBoundingClientRect();
      const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return target === element || element.contains(target);
    })).toBe(true);
    const navigation = page.waitForResponse(response => response.request().isNavigationRequest()
      && response.request().resourceType() === 'document'
      && new URL(response.url()).pathname === '/login', { timeout: 30_000 });
    const responsePromise = Promise.all([navigation, mobile ? page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2) : page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)]);
    const [response] = await responsePromise;
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
    await expect(page.getByPlaceholder('admin', { exact: true })).toBeVisible();
    await context.close();
  });
}
