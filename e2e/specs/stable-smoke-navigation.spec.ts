import { test, expect, devices } from '@playwright/test';
import { enterVisualFromHome, openOwnVisualWorkspace } from '../utils/stableSmokeNavigation.mjs';

test('独立触控导航夹具：错误名称红、真实生图点击绿；不证明线上生成能力', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const id = 'a'.repeat(32);
  try {
    await context.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: new URL(route.request().url()).pathname === '/' ? '<span>生图</span><button onclick="location.href=\'/visual-agent\'">生图</button>' : `<a href="/visual-agent/${id}" data-ws-card="1" data-ws-id="${id}">本轮项目</a>` }));
    const page = await context.newPage();
    await page.goto('http://localhost/');
    await expect(enterVisualFromHome(page, { touch: false, timeout: 200 })).rejects.toThrow(/Timeout/);
    expect((await enterVisualFromHome(page, { touch: true })).path).toBe('/visual-agent');
    expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
    await openOwnVisualWorkspace(page, id, { touch: true });
    expect(new URL(page.url()).pathname).toBe(`/visual-agent/${id}`);
  } finally { await context.close(); }
});
