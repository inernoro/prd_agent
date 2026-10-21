import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('../.dropdown-validation-dist');
const server = createServer(async (req, res) => {
  const file = path.resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const bytes = await readFile(file);
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(5519, '127.0.0.1', resolve));
await mkdir('dropdown-evidence', { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:5519/');
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
    await page.getByText('打开申领弹窗', { exact: true }).click();
    const input = page.getByPlaceholder('搜索已有方案');
    await expect(input).toBeVisible();
    await input.click();
    const list = page.locator('[role="dialog"] [style*="overflow-y: auto"]').last();
    await expect(list).toBeVisible();
    await expect(page.getByText('共 120 个方案', { exact: true })).toBeVisible();
    console.log(JSON.stringify(await list.evaluate(el => ({
      stage: 'before-wheel',
      height: el.clientHeight, scrollHeight: el.scrollHeight,
      display: getComputedStyle(el).display,
      parentDisplay: getComputedStyle(el.parentElement).display,
      menuMaxHeight: getComputedStyle(el.parentElement.parentElement).maxHeight,
      menuHeight: el.parentElement.parentElement.clientHeight,
    }))));
    await page.screenshot({ path: `dropdown-evidence/${theme}-initial.png` });
    await expect.poll(() => list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const body = page.locator('.prd-dialog-body');
    const bodyBefore = await body.evaluate(el => el.scrollTop);
    await list.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    const down = await list.evaluate(el => el.scrollTop);
    await page.mouse.wheel(0, -250);
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeLessThan(down);
    const up = await list.evaluate(el => el.scrollTop);
    expect(await body.evaluate(el => el.scrollTop)).toBe(bodyBefore);
    await page.screenshot({ path: `dropdown-evidence/${theme}-wheel.png` });
    await input.fill('模拟方案 119');
    await expect(page.getByText('1 / 120 个方案匹配', { exact: true })).toBeVisible();
    await page.locator('div[title="模拟方案 119"]').click();
    await expect(page.getByTestId('selection')).toHaveText('119');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('个方案匹配', { exact: false })).toHaveCount(0);
    expect(errors).toEqual([]);
    results.push({ theme, down, up, outerScrollUnchanged: true, searchAndSelection: 'passed' });
    await page.close();
  }
  console.log(JSON.stringify({ verdict: 'PASS', source: process.env.SOURCE, results }));
  await writeFile('dropdown-evidence/result.json', JSON.stringify({ verdict: 'PASS', source: process.env.SOURCE, results }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
