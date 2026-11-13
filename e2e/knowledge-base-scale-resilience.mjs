/** 仅对本轮隔离空间的 GET 注入一次失败/延迟；验证可恢复提示与过时搜索隔离。 */
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
const base = process.env.E2E_BASE_URL;
const fixture = JSON.parse(fs.readFileSync(process.env.KB_SCALE_FIXTURE)).find(s => s.n === 1000);
const out = process.env.OUT_DIR || '/tmp/kb-scale-resilience';
if (!base || !fixture || !process.env.MAP_USER || !process.env.MAP_PASSWORD) throw Error('缺少地址、凭据或隔离 fixture');
if (process.env.MAP_PROD_HOST && new URL(base).host === new URL(process.env.MAP_PROD_HOST).host) throw Error('故障注入不得在正式环境执行');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: path.join(out, 'video') } });
const page = await context.newPage();
page.setDefaultTimeout(45000);
let failNavigation = true;
let failSearch = false;
const requests = [];
page.on('request', r => { if (new URL(r.url()).pathname.endsWith(`/stores/${fixture.id}/entries`)) requests.push({ method: r.method(), query: new URL(r.url()).search }); });
async function shot(locator, name) {
  await locator.evaluate(node => { node.style.outline = '2px solid #ef4444'; node.classList.add('__acc_box'); });
  await page.screenshot({ path: path.join(out, name + '.png') });
  await locator.evaluate(node => { node.style.outline = ''; node.classList.remove('__acc_box'); });
}
try {
  await page.route(`**/api/document-store/stores/${fixture.id}/entries?**`, async route => {
    const query = new URL(route.request().url()).searchParams;
    if ((failNavigation && query.has('cursor') && !query.has('keyword')) || (failSearch && query.has('cursor') && query.has('keyword'))) {
      if (query.has('keyword')) failSearch = false; else failNavigation = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, data: null, error: { code: 'TEST_TEMPORARY', message: '隔离验证：临时读取失败' } }) });
    }
    if (query.get('keyword') === '过时查询') {
      const response = await route.fetch();
      await new Promise(resolve => setTimeout(resolve, 800));
      return route.fulfill({ response });
    }
    await route.continue();
  });
  await page.goto(new URL('/login', base).href);
  await page.getByPlaceholder('admin', { exact: true }).fill(process.env.MAP_USER);
  await page.locator('input[type=password]').fill(process.env.MAP_PASSWORD);
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.waitForURL(u => !u.pathname.includes('/login'));
  await page.getByText('知识库', { exact: true }).first().click();
  await page.getByText(fixture.name, { exact: true }).waitFor();
  if (await page.getByRole('button', { name: '我已学会' }).isVisible().catch(() => false)) await page.getByRole('button', { name: '我已学会' }).click();
  await page.getByText(fixture.name, { exact: true }).click();
  const incomplete = page.getByText('文档列表尚未加载完整', { exact: false });
  await incomplete.waitFor();
  await shot(incomplete, '01-incomplete');
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(incomplete).toHaveCount(0);
  await expect(page.getByText(/正在补齐目录/)).toHaveCount(0);
  await expect(page.locator('body')).toContainText(/1000\s*个文档/);
  const search = page.getByPlaceholder('搜索标题或内容…');
  const oldRequest = page.waitForRequest(r => r.url().includes('keyword=') && decodeURIComponent(r.url()).includes('过时查询'));
  await search.fill('过时查询');
  await oldRequest;
  await search.fill(fixture.tail);
  await page.locator(`[data-entry-id="${fixture.lastEntryId}"]`).waitFor();
  await page.waitForTimeout(900);
  await expect(page.locator(`[data-entry-id="${fixture.lastEntryId}"]`)).toHaveCount(1);
  await shot(page.locator(`[data-entry-id="${fixture.lastEntryId}"]`), '02-stale-response-ignored');
  await search.fill('样本文档');
  let more = page.getByRole('button', { name: /^加载更多搜索结果/ });
  await expect(more).toContainText('50 / 1000');
  await more.click();
  await expect(more).toContainText('100 / 1000');
  failSearch = true;
  await more.click();
  await page.getByRole('alert').waitFor();
  await expect(more).toContainText('100 / 1000');
  await more.click();
  await expect(more).toContainText('150 / 1000');
  const ids = await page.locator('[data-entry-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-entry-id')));
  expect(new Set(ids).size).toBe(ids.length);
  await shot(more, '03-search-page-recovered');
  expect(requests.every(r => r.method === 'GET')).toBe(true);
  fs.writeFileSync(path.join(out, 'resilience.json'), JSON.stringify({ navigationRecovery: true, staleResponseIgnored: true, searchPageRecovery: true, duplicateVisibleIds: 0, requests }, null, 2));
  console.log('目录中断重试、过时响应隔离与搜索分页恢复通过');
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png') });
  throw error;
} finally { await context.close(); await browser.close(); }
