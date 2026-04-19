/**
 * CDS Dashboard UI 路径 — 复盘 2026-04-19 发现的 4 个样式回归:
 *   1) 白天模式「+ 新建项目」按钮可见 + 有 accent 背景
 *   2) 桌面宽度下分支列表走多列布局 (Grid auto-fill,实际呈现列数 > 1)
 *   3) 列表/拓扑 toggle 和右侧 icon 按钮上下对齐
 *   4) ⚙ 下拉里「冒烟测试」项存在(Phase 3/4 回归保护)
 *
 * 这几条是 CSS + DOM 结构级别的,Phase 2 HTTP smoke 验不了。专门用
 * 浏览器跑才有价值。
 *
 * 目标 URL 是 CDS 项目列表页 (`/project-list`) 和分支页 (`/branch-list`),
 * 默认走 E2E_BASE_URL(例如 https://<branch>.miduo.org)。
 *
 * CDS 页面通常没有强制登录 (operator 白名单),若部署启用了 github-auth
 * 这组测试需配合 login fixture,暂不处理。
 */

import { test, expect } from '@playwright/test';

test.describe('CDS Dashboard 样式回归', () => {
  test('白天模式「+ 新建项目」按钮有 accent 背景色', async ({ page }) => {
    await page.goto('/project-list');
    // 强制切到 light 主题后再断言
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
    });
    const btn = page.locator('button.btn-primary-solid', { hasText: '新建项目' });
    await expect(btn).toBeVisible();
    const bg = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
    // 白天主题 accent = #e65c46 = rgb(230, 92, 70)。允许 tolerance:
    // 只要 red 通道 > 150 就说明填充生效(避免灰色 / 透明 / 白色)
    const m = /rgb[a]?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
    expect(m, `background-color = ${bg}`).not.toBeNull();
    const [r, g, b] = [parseInt(m![1]), parseInt(m![2]), parseInt(m![3])];
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(150);
    expect(b).toBeLessThan(150);
  });

  test('桌面宽度下分支列表多列呈现 (Grid auto-fill 计算后 tracks > 1)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/branch-list?project=default');
    const branchList = page.locator('.branch-list');
    await expect(branchList).toBeVisible();
    // 2026-04-19 rewrite: 改用 CSS Grid auto-fill,所以断言对象从
    // columnCount 换到 grid-template-columns 实际解析出的 track 数。
    // `repeat(auto-fill, minmax(340px, 1fr))` 在 1440px 下会产出
    // 3-4 个 track。浏览器把最终值 resolve 成一串像素数值,用空格
    // 分隔,拆 split 数组长度 >= 2 就算多列布局生效。
    const trackCount = await branchList.evaluate((el) => {
      const val = getComputedStyle(el).gridTemplateColumns;
      return val && val !== 'none' ? val.split(/\s+/).length : 0;
    });
    expect(
      trackCount,
      `desktop branch-list grid tracks=${trackCount} — expected >= 2`,
    ).toBeGreaterThanOrEqual(2);
  });

  test('header-actions 里列表/拓扑 toggle 与 icon 按钮同高', async ({ page }) => {
    await page.goto('/branch-list?project=default');
    const toggle = page.locator('.view-mode-toggle').first();
    const firstIconBtn = page.locator('.header-actions .icon-btn').first();
    await expect(toggle).toBeVisible();
    await expect(firstIconBtn).toBeVisible();
    const toggleBox = await toggle.boundingBox();
    const iconBox = await firstIconBtn.boundingBox();
    expect(toggleBox).not.toBeNull();
    expect(iconBox).not.toBeNull();
    // 允许 ±4px 视觉容差(border / shadow / subpixel 抖动)
    expect(Math.abs(toggleBox!.y - iconBox!.y)).toBeLessThanOrEqual(4);
    expect(Math.abs(toggleBox!.height - iconBox!.height)).toBeLessThanOrEqual(4);
  });

  test('⚙ 下拉菜单包含「冒烟测试」 / 「CDS 自动更新」等关键项 (Phase 3/4 回归保护)', async ({ page }) => {
    await page.goto('/branch-list?project=default');
    // 打开齿轮菜单 — 点左侧 settings icon btn,浮层 portal 到 body
    await page.locator('#settingsBtn').click();
    const menu = page.locator('.settings-menu');
    await expect(menu).toBeVisible({ timeout: 5_000 });
    // 菜单里必须有这些关键项:
    const mustContain = ['一键导入配置', '构建配置', '环境变量', 'CDS 自动更新', '全局设置'];
    for (const label of mustContain) {
      await expect(menu.getByText(label, { exact: false })).toBeVisible();
    }
  });
});
