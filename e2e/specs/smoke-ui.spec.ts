/**
 * UI 冒烟路径 — 最轻量的一组 E2E,只验证「页面能打开 + 核心文字
 * 出现 + 无 console.error」。跑这 3 条就能排除部署后静态资源
 * 404 / JS 全崩 / CSS 裸奔 / 前端路由白屏之类的"部署绿但页面黑"
 * 缺陷,对应 Phase 3 smoke 后端链路绿灯之外的补充层。
 *
 * 不用登录。auth-gated 路径放到 agent-flow.spec.ts。
 */

import { test, expect } from '@playwright/test';

test.describe('UI 冒烟 (无需登录)', () => {
  test('登录页渲染成功,无 console.error', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/login');
    await expect(page).toHaveTitle(/.+/); // 非空 title
    // 登录页至少要有用户名 + 密码两个字段
    await expect(
      page.locator('input[name="username"], #username, [data-testid="login-user"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('input[name="password"], #password, [data-testid="login-pass"]').first(),
    ).toBeVisible();

    // Console error 允许列表:第三方 SDK 自带的、已经归档处理的噪声。
    // 正则加到这里,避免每次新部署都得人工 diff console。
    const allowRegexes = [
      /Failed to load resource.*favicon/i,
      /ResizeObserver loop/i,
    ];
    const critical = consoleErrors.filter(
      (e) => !allowRegexes.some((r) => r.test(e)),
    );
    expect(critical, `Unexpected console errors:\n${critical.join('\n')}`).toHaveLength(0);
  });

  test('根路径 / 响应 200 或 重定向到 /login', async ({ page }) => {
    const resp = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(resp?.status()).toBeLessThan(500);
    // 要么停在根路径(带 dashboard 文案),要么已跳到登录
    const url = page.url();
    expect(url).toMatch(/(\/login|\/dashboard|\/$|\/home|\/groups)/);
  });

  test('静态资源样式就位 (body 有 computed background)', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' });
    // 如果 CSS 打包坏了,body 会是浏览器默认白底。主题系统至少会
    // 给 body 加 --bg-primary 背景。
    const bg = await page.evaluate(() => {
      const s = getComputedStyle(document.body);
      return { bg: s.backgroundColor, fontFamily: s.fontFamily };
    });
    // 白底 / 空字符串视为 CSS 丢失
    expect(bg.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg.bg).not.toBe('');
    expect(bg.fontFamily).not.toBe('');
  });
});
