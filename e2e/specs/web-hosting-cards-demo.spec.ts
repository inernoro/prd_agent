import { expect, test } from '@playwright/test';

for (const width of [390, 1440]) {
  for (const theme of ['dark', 'light']) {
    test(`三档实际卡片演示 ${width}px ${theme}：布局与操作`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const errors: string[] = [];
      const writes: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (request.url().includes('/api/web-pages') && request.method() !== 'GET') writes.push(request.url()); });
      await page.goto('/_dev/web-hosting-cards');
      await expect(page.getByRole('heading', { name: '同一张卡片，三种尺寸。' })).toBeVisible();
      await expect(page.locator('[data-demo-scenario]')).toHaveCount(10);
      await expect(page.locator('[data-hosted-site-id]')).toHaveCount(30);
      await expect(page.locator('[data-card] .related-trigger')).toHaveCount(30);
      const plainLink = page.locator('[data-demo-scenario="plain"] [data-demo-size="large"] .related-trigger');
      await expect(plainLink).toBeVisible();
      await expect(plainLink.locator('svg.lucide-link2')).toBeVisible();
      await expect(plainLink.locator('.related-count')).toHaveCount(0);
      if (theme === 'light') await page.getByRole('button', { name: '切换演示主题' }).click();
      const geometry = await page.locator('[data-demo-size]').evaluateAll(elements => elements.map(element => {
        const card = element.querySelector('[data-card]')!;
        const meta = card.querySelector<HTMLElement>('[data-site-card-meta]')!;
        const stats = Array.from(card.querySelector('[data-site-card-stats]')!.children);
        const thumb = card.querySelector('[data-site-card-thumbnail]')!.getBoundingClientRect();
        const badge = card.querySelector('[data-site-card-badges]')!.getBoundingClientRect();
        return { size: element.getAttribute('data-demo-size'), width: element.getBoundingClientRect().width,
          metaOverflow: meta.scrollWidth > meta.clientWidth, stats: stats.map(item => ({ top: item.getBoundingClientRect().top, height: item.getBoundingClientRect().height })),
          badgeOnLeft: Math.abs(badge.left - thumb.left - 8) < 1,
          type: card.querySelector('[data-site-card-type]')?.textContent,
          htmlType: card.querySelector('[data-site-card-type]')?.textContent === 'HTML' };
      }));
      for (const item of geometry) {
        expect(item.width).toBe(({ large: 360, medium: 264, small: 176 })[item.size as 'small' | 'medium' | 'large']);
        expect(item.metaOverflow, JSON.stringify(item)).toBe(false);
        expect(item.stats).toHaveLength(3);
        expect(Math.max(...item.stats.map(stat => stat.top)) - Math.min(...item.stats.map(stat => stat.top))).toBeLessThan(1);
        expect(item.stats.every(stat => stat.height <= 16)).toBe(true);
        expect(item.badgeOnLeft).toBe(true);
        expect(item.htmlType).toBe(false);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      // 每一档都验证右键、更多按钮、空白关闭；使用真实指针而非程序化 click。
      await page.getByLabel('筛选演示场景').selectOption('crowded');
      for (const size of ['large', 'medium', 'small']) {
        const card = page.locator(`[data-demo-size="${size}"] [data-card]`);
        await card.scrollIntoViewIfNeeded();
        await card.click({ button: 'right' });
        const menu = page.getByRole('menu', { name: '网页操作' });
        await expect(menu).toBeVisible();
        if (width === 390) {
          const heights = await menu.getByRole('menuitem').evaluateAll(items => items.map(item => item.getBoundingClientRect().height));
          expect(heights.every(height => height >= 44)).toBe(true);
        }
        const labels = await menu.getByRole('menuitem').allTextContents();
        expect(labels).toContain('编辑信息');
        expect(labels).toContain('替换内容');
        await page.getByRole('heading', { level: 1 }).click();
        await expect(menu).toHaveCount(0);
        await card.hover();
        const more = card.getByRole('button', { name: '更多设置', exact: true }).filter({ visible: true });
        await more.click();
        await expect(menu).toBeVisible();
        expect(await menu.getByRole('menuitem').allTextContents()).toEqual(labels);
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
        // 格式与选择框均可见时，左右信息互不重叠。
        await card.getByRole('button', { name: '选择', exact: true }).click();
        await expect.poll(() => card.evaluate(element => {
          const type = element.querySelector('[data-site-card-type]')!.getBoundingClientRect();
          const select = element.querySelector('[data-site-select]')!.getBoundingClientRect();
          const badges = element.querySelector('[data-site-card-badges]')!.getBoundingClientRect();
          return { typeSelect: type.right > select.left, badgeType: badges.right > type.left };
        }), { message: `${size} 格式角标完成避让后不与选择框重叠` }).toEqual({ typeSelect: false, badgeType: false });
        await card.getByRole('button', { name: '取消选择', exact: true }).click();
      }
      await page.getByLabel('筛选演示场景').selectOption('markdown');
      const readOnly = page.locator('[data-demo-size="small"] [data-card]');
      await readOnly.click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: '二维码', exact: true })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: '删除', exact: true })).toHaveCount(0);
      await expect(page.getByRole('menuitem', { name: '编辑信息', exact: true })).toHaveCount(0);
      await page.getByRole('heading', { level: 1 }).click();
      await readOnly.getByRole('button', { name: '查看网页详情' }).click();
      const details = page.getByRole('dialog', { name: '网页详情' });
      await expect(details).toContainText('工作流生成');
      await page.keyboard.press('Escape');
      await page.getByLabel('筛选演示场景').selectOption('all');
      await page.getByRole('button', { name: '重置演示' }).click();
      await testInfo.attach(`三档演示-${width}-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

for (const width of [390, 1440]) {
  test(`合集 A 目录 ${width}px 背景等比铺满，动态画布使用实际尺寸`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const sites = Array.from({ length: 3 }, (_, index) => ({ id: `background-${index}`, title: `背景验证文档 ${index + 1}`, siteUrl: '', entryFile: 'index.html', fileCount: 1, totalSize: 1024 }));
    await page.route('**/api/web-pages/shares/view/qa-background**', route => route.fulfill({ json: { success: true, data: { title: '背景验证合集', shareType: 'collection', mainSiteId: sites[0].id, sites }, error: null } }));
    await page.goto('/s/wp/qa-background');
    await expect(page.locator('.ledger-main-document')).toBeVisible();
    const svg = page.locator('.hosted-share-still-threads');
    await expect(svg).toBeVisible();
    const geometry = await svg.evaluate(element => {
      const stage = element.parentElement!.getBoundingClientRect();
      const root = element.closest('.hosted-ledger')!.getBoundingClientRect();
      const matrix = (element as SVGSVGElement).getScreenCTM()!;
      return { height: stage.height, rootHeight: root.height, width: stage.width, rootWidth: root.width, xScale: matrix.a, yScale: matrix.d };
    });
    expect(geometry.height).toBeCloseTo(geometry.rootHeight, 0);
    expect(geometry.width).toBeCloseTo(geometry.rootWidth, 0);
    expect(geometry.xScale).toBeCloseTo(geometry.yScale, 5);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.bringToFront();
    const canvas = page.locator('.hosted-share-threads canvas');
    await expect(canvas).toBeVisible();
    const bounds = await canvas.boundingBox();
    expect(bounds!.height).toBeCloseTo(geometry.height, 0);
    expect(bounds!.width).toBeCloseTo(geometry.width, 0);
  });
}
