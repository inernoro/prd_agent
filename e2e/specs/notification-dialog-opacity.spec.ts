/** 生产组件/CSS的隔离浏览器回归；测试身份和API均为替身，不是CDS真实用户路径验收。 */
import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('prd-admin-auth', JSON.stringify({ state: {
      isAuthenticated: true, user: { userId: 'qa-opacity', username: 'qa-opacity', displayName: '通知视觉回归', role: 'ADMIN' },
      token: 'isolated-fixture', refreshToken: 'isolated-fixture', sessionKey: 'isolated-fixture',
      permissions: ['access', 'web-pages.read'], permissionsLoaded: true, isRoot: true,
      menuCatalog: [], menuCatalogLoaded: true, cdnBaseUrl: '', permFingerprint: 'isolated-fixture',
    }, version: 0 }));
  });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const now = '2026-11-13T10:00:00Z';
    let data: unknown = { items: [], total: 0, folders: [], tags: [], teams: [] };
    if (path === '/api/authz/me') data = { effectivePermissions: ['access', 'web-pages.read'], menuCatalog: [], isRoot: true };
    else if (path === '/api/dashboard/notifications') data = {
      items: Array.from({ length: 105 }, (_, i) => ({ id: `opacity-${i}`, source: 'llm-gateway-quota', section: 'admin',
        title: `验收供应商甲 / 线路甲 / 模型甲：最近观测余额不足 ${i + 1}`,
        message: '该次请求由备用线路完成。原线路仍需管理员检查余额；没有恢复证据。',
        level: 'error', status: 'open', createdAt: now, updatedAt: now, pushEpisode: 1,
        incidentId: `isolated-route-${i}`, incidentState: 'active', requestOutcome: 'fallback_succeeded',
        occurrenceCount: i ? 1 : 182, firstOccurredAt: now, lastOccurredAt: now,
      })), hasMore: false, summary: { notificationCount: 105, independentIncidentCount: 105, unclassifiedCount: 0 },
    };
    else if (path.endsWith('/subscriptions')) data = { topics: [], presets: [], resources: [], placeholders: [], subscriptions: [], defaultProfile: null };
    else if (path === '/api/changelog/current-week') data = { weekStart: now, weekEnd: now, fetchedAt: now, dataSourceAvailable: true, source: 'local', totalDays: 0, totalEntries: 0, daysOffset: 0, hasMore: false, fragments: [] };
    await route.fulfill({ json: { success: true, data, error: null } });
  });
}

for (const width of [1440, 390]) {
  for (const theme of ['dark', 'light']) {
    for (const material of ['solid', 'glass']) {
      test(`通知弹窗 ${width} ${theme} ${material} 入场全程实底且能滚动关闭`, async ({ page }, testInfo) => {
        const height = width === 390 ? 844 : 1000;
        await page.setViewportSize({ width, height });
        await fixture(page);
        // 深链用于确定性回归；真人登录→菜单入口另做真实本地API联调，不能混为同一证据。
        await page.goto('/web-pages?panel=notifications');
        const dialog = page.getByRole('dialog', { name: '用户通知' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText('验收供应商甲 / 线路甲 / 模型甲：最近观测余额不足 1', { exact: true })).toBeVisible();
        await page.evaluate(({ theme, material }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.material = material;
        }, { theme, material });
        const frames = [];
        for (const progress of [0.5, 0, 0.99, 1]) {
          const metrics = await dialog.evaluate((element, progress) => {
            const overlay = element.closest('.prd-dialog-overlay')!;
            // 重新播放实际CSS动画并精确停帧，避免一次截图恰好越过260ms而漏掉叠读。
            for (const target of [overlay, element]) {
              (target as HTMLElement).style.animation = 'none';
              void (target as HTMLElement).offsetWidth;
              (target as HTMLElement).style.animation = '';
              for (const animation of target.getAnimations()) {
                animation.pause();
                animation.currentTime = Number(animation.effect!.getTiming().duration) * progress;
              }
            }
            const chain = [];
            for (let node: Element | null = element; node; node = node.parentElement) {
              const style = getComputedStyle(node);
              chain.push({ opacity: Number(style.opacity), background: style.backgroundColor });
            }
            const bounds = element.getBoundingClientRect();
            return { progress, chain, bounds: { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom },
              bodyOverflow: document.documentElement.scrollWidth > innerWidth };
          }, progress);
          frames.push(metrics);
          if (progress === 0.5) await testInfo.attach('入场中间帧', { body: await page.screenshot(), contentType: 'image/png' });
          // alpha=1还不够：父Overlay的opacity也会让整个面板透底。
          expect(metrics.chain.every(item => item.opacity === 1), JSON.stringify(metrics)).toBe(true);
          expect(metrics.chain[0].background).toMatch(/^rgb\(/);
          expect(metrics.bounds.x).toBeGreaterThanOrEqual(0);
          expect(metrics.bounds.right).toBeLessThanOrEqual(width);
          expect(metrics.bounds.bottom).toBeLessThanOrEqual(height);
          expect(metrics.bodyOverflow).toBe(false);
        }
        await testInfo.attach('真实CSS逐帧计算值', { body: JSON.stringify(frames, null, 2), contentType: 'application/json' });
        await expect(page.getByRole('button', { name: '收缩通知', exact: true })).toHaveCount(0);
        await testInfo.attach('通知列表', { body: await page.screenshot(), contentType: 'image/png' });
        const last = dialog.getByText('验收供应商甲 / 线路甲 / 模型甲：最近观测余额不足 105', { exact: true });
        await last.scrollIntoViewIfNeeded();
        await expect(last).toBeVisible();
        await dialog.getByRole('button', { name: '推送订阅', exact: true }).click();
        await expect(dialog.getByText('配置默认推送通道', { exact: true })).toBeVisible();
        await expect(dialog.getByText('接收范围', { exact: true })).toBeVisible();
        await testInfo.attach('推送订阅', { body: await page.screenshot(), contentType: 'image/png' });
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        if (width === 1440) await expect(page.getByRole('button', { name: '收缩通知', exact: true })).toBeVisible();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto('/web-pages?panel=notifications');
        await expect(dialog).toBeVisible();
        expect(await dialog.evaluate(element => [element, element.parentElement!].every(node => getComputedStyle(node).opacity === '1'))).toBe(true);
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await expect(dialog).toHaveCount(0);
      });
    }
  }
}
