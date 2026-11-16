/** Offline browser regression for native fields and the shared portalled menu. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { startViteDevServer } from './lib/vite-dev-server.mjs';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || 'playwright');
const server = process.argv[2] ? null : await startViteDevServer();
const base = process.argv[2] || server.url;
let browser;
let checks = 0;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await context.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (isEventStream(pathname)) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    await route.fulfill({ json: resolveFixture(pathname) ?? {} });
  });
  const page = await context.newPage();
  page.on('pageerror', error => console.error(error.message));
  for (const theme of ['light', 'dark']) {
    for (const width of [375, 390, 760, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/project-list`);
      const sort = page.getByLabel('项目排序', { exact: true });
      await sort.waitFor();
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const field of await page.locator('.cds-project-inventory-tools select').all()) {
        const s = await field.evaluate(el => {
          const css = getComputedStyle(el), r = el.getBoundingClientRect();
          return { appearance: css.appearance, arrow: css.backgroundImage, padding: parseFloat(css.paddingInlineEnd), icon: parseFloat(css.backgroundSize), left: r.left, right: r.right, viewport: innerWidth };
        });
        assert.equal(s.appearance, 'none');
        assert.ok(s.arrow.includes('svg'));
        assert.ok(s.padding > s.icon * 2, 'text leaves space for inset arrow');
        assert.ok(s.left >= 0 && s.right <= s.viewport, 'field stays inside viewport');
        checks++;
      }
      await sort.focus();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[aria-label="项目排序"]').value === 'name');
      checks++;
      await page.goto(`${base}/code-reviews`);
      const filter = page.getByLabel('筛选任务状态', { exact: true });
      await filter.waitFor();
      assert.equal(await filter.evaluate(el => getComputedStyle(el).appearance), 'none');
      checks++;
    }
  }
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 300 });
    for (const edge of ['left', 'right']) {
      for (const align of ['start', 'end']) {
        for (const menuWidth of [220, 1800]) {
          await page.goto(`${base}/project-list`);
          await page.getByLabel('项目排序', { exact: true }).waitFor();
          // Mount the shared component at the viewport edge, outside the app layout.
          await page.evaluate(async ({ edge, align, menuWidth }) => {
            const { default: React } = await import('/node_modules/.vite/deps/react.js');
            const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
            const { DropdownMenu, DropdownItem } = await import('/src/components/ui/dropdown-menu.tsx');
            document.getElementById('root').style.display = 'none';
            const host = document.createElement('div'); document.body.append(host);
            ReactDOM.createRoot(host).render(React.createElement('div',
              { style: { position: 'fixed', [edge]: 0, bottom: 0 } },
              React.createElement(DropdownMenu, { align, width: menuWidth,
                trigger: React.createElement('button', null, '打开菜单') },
              Array.from({ length: 20 }, (_, i) => React.createElement(DropdownItem, { key: i }, '菜单项 ' + i)))));
          }, { edge, align, menuWidth });
          await page.getByRole('button', { name: '打开菜单' }).click();
          const menu = page.getByRole('menu');
          await menu.waitFor();
          await page.waitForFunction(() => {
            const r=document.querySelector('[role="menu"]')?.getBoundingClientRect();
            return r && r.left >= 8 && r.right <= innerWidth - 7 && r.top >= 0 && r.bottom <= innerHeight;
          });
          assert.equal(await menu.evaluate(el => getComputedStyle(el).overflowY), 'auto');
          await page.getByText('菜单项 19', { exact: true }).scrollIntoViewIfNeeded();
          await page.getByText('菜单项 19', { exact: true }).click();
          await menu.waitFor({ state: 'hidden' });
          checks++;
        }
      }
    }
  }
  // A trigger spanning the whole short viewport leaves zero space on either side.
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.getByRole('button', { name: '打开菜单' }).evaluate(el => {
    el.style.height = '400px';
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => document.querySelector('[role="menu"]')?.style.maxHeight === '0px');
  checks++;
  // Existing custom arrows and multi-row listboxes must remain opt-outs.
  await page.evaluate(() => {
    const custom = document.createElement('select'); custom.className='appearance-none'; custom.id='custom';
    const multiple = document.createElement('select'); multiple.multiple=true; multiple.id='multiple';
    const sized = document.createElement('select'); sized.size=4; sized.id='sized';
    document.body.append(custom,multiple,sized);
  });
  for (const id of ['custom', 'multiple', 'sized']) {
    assert.equal(await page.locator(`#${id}`).evaluate(el => getComputedStyle(el).backgroundImage), 'none'); checks++;
  }
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto(`${base}/project-list`);
  await page.getByLabel('项目排序', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('项目排序', { exact: true }).evaluate(el => getComputedStyle(el).appearance), 'auto');
  checks++;
  console.log(`PASS ${checks} select/menu boundary checks (offline fixtures; not production acceptance)`);
} finally {
  await browser?.close();
  server?.stop();
}
