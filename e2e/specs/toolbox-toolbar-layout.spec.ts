import { expect, test } from '@playwright/test';

// 生产页面的隔离布局回归；存储与 API 均为测试夹具，不作为真实登录或上游验收证据。
for (const width of [769, 800, 960, 1556]) {
  for (const collapsed of [true, false]) {
    test(`百宝箱 ${width}px 侧栏${collapsed ? '收起' : '展开'}后筛选不重叠`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(({ collapsed }) => {
        localStorage.setItem('ai-toolbox.pref.displayMode', collapsed ? 'showcase' : 'standard');
        sessionStorage.setItem('prd-admin-layout', JSON.stringify({ state: { navCollapsed: collapsed }, version: 0 }));
        localStorage.setItem('prd-admin-auth', JSON.stringify({ state: {
          isAuthenticated: true,
          user: { userId: 'qa-toolbox-layout', username: 'qa-toolbox-layout', displayName: '布局回归', role: 'ADMIN' },
          token: 'qa-toolbox-token', refreshToken: 'qa-toolbox-refresh', sessionKey: 'qa-toolbox-session',
          permissions: ['super'], permissionsLoaded: true, isRoot: true,
          menuCatalog: [], menuCatalogLoaded: true, cdnBaseUrl: '', permFingerprint: 'qa-toolbox',
        }, version: 0 }));
      }, { collapsed });
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        const tool = (id: string, name: string, owner: string, isPublic: boolean) => ({
          id, name, description: '验证列表中的作者和操作位置', tags: [], icon: 'Bot',
          createdByUserId: owner, createdByName: owner, isPublic, usageCount: 0,
        });
        let data: unknown = { items: [], total: 0, folders: [], tags: [], teams: [], fragments: [] };
        if (path === '/api/authz/me') data = { effectivePermissions: ['super'], menuCatalog: [], isRoot: true };
        if (path === '/api/ai-toolbox/items') data = { items: [tool('qa-owned', '自建布局工具', 'qa-toolbox-layout', false)] };
        if (path === '/api/ai-toolbox/marketplace') data = { items: [tool('qa-shared', '共享布局工具', 'qa-other', true)] };
        await route.fulfill({ json: { success: true, data, error: null } });
      });
      await page.goto('/ai-toolbox');
      const toolbar = page.locator('.toolbox-gallery-toolbar');
      await expect(toolbar).toBeVisible({ timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('.toolbox-card-grid')).toHaveAttribute('data-display-mode', 'compact');
      const bounds = await toolbar.evaluate(el => {
        const bar = el.closest('.toolbox-filter-bar')!.getBoundingClientRect();
        const category = el.querySelector('[role="tablist"]')!.getBoundingClientRect();
        const options = el.querySelector('.toolbox-gallery-options')!.getBoundingClientRect();
        return {
          fits: [category, options].every(r => r.left >= bar.left && r.right <= bar.right && r.bottom <= bar.bottom),
          overlaps: category.left < options.right && category.right > options.left
            && category.top < options.bottom && category.bottom > options.top,
        };
      });
      expect(bounds.fits).toBe(true);
      expect(bounds.overlaps).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const visiblePurpose = await page.locator('.toolbox-tool-card').filter({ hasText: '视觉创作智能体' }).locator('.toolbox-gallery-description').textContent();
      await page.getByRole('searchbox', { name: '搜索工具' }).fill(visiblePurpose!.trim());
      await expect(page.locator('.toolbox-tool-card')).toHaveCount(1);
      await expect(page.locator('.toolbox-gallery-name')).toHaveText('视觉创作智能体');
      await page.getByRole('button', { name: '清空搜索', exact: true }).click();
      await page.getByRole('combobox', { name: '工具类型' }).selectOption('tool');
      await expect(page.getByRole('combobox', { name: '工具类型' })).toHaveValue('tool');
      await page.getByRole('tab', { name: '收藏', exact: true }).click();
      await expect(page.getByRole('tab', { name: '收藏', exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.getByRole('button', { name: '清除筛选', exact: true }).first().click();
      await expect(page.getByRole('tab', { name: '收藏', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByText('还没有收藏工具', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '浏览全部工具', exact: true }).click();
      await expect(page.getByRole('tab', { name: '全部工具', exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.getByRole('tab', { name: '我的创建', exact: true }).click();
      await page.getByRole('searchbox', { name: '搜索工具' }).fill('没有这个工具');
      await page.getByRole('button', { name: '清除筛选', exact: true }).first().click();
      await expect(page.getByRole('tab', { name: '我的创建', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.toolbox-gallery-name')).toHaveText('自建布局工具');
      await page.getByRole('tab', { name: '全部工具', exact: true }).click();
      await page.getByRole('button', { name: '列表视图', exact: true }).click();
      await expect(page.getByRole('button', { name: '列表视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
      // 在原断言预算内等既有有限过渡结束，再比较同一稳定态的卡片。
      await expect.poll(async () => page.locator('.toolbox-tool-card').evaluateAll(cards =>
        cards.reduce((count, card) => count + card.getAnimations().filter(animation =>
          animation.playState === 'running'
          && Number.isFinite(animation.effect?.getComputedTiming().iterations)).length, 0)),
      { timeout: 5_000 }).toBe(0);
      const builtinHeight = (await page.locator('.toolbox-tool-card[data-has-artwork="true"]').first().boundingBox())!.height;
      for (const name of ['自建布局工具', '共享布局工具']) {
        const card = page.locator('.toolbox-tool-card').filter({ hasText: name });
        const rect = await card.boundingBox();
        expect(rect!.height).toBeLessThanOrEqual(builtinHeight + 1);
        const row = await card.evaluate(el => {
          const caption = el.querySelector('.toolbox-gallery-caption')!.getBoundingClientRect();
          const footer = el.querySelector('.toolbox-card-footer')!.getBoundingClientRect();
          return { sideBySide: caption.right <= footer.left + 1, sameRow: footer.top < caption.bottom && caption.top < footer.bottom };
        });
        expect(row.sideBySide).toBe(true);
        expect(row.sameRow).toBe(true);
      }
      const copyCard = page.locator('.toolbox-tool-card').filter({ hasText: '代码审查员' });
      await copyCard.hover();
      await copyCard.getByRole('button', { name: '复制并编辑', exact: true }).click();
      await expect(page.getByPlaceholder('给你的智能体起个名字')).toHaveValue('代码审查员（我的副本）');
    });
  }
}
