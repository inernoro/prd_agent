/**
 * 使用已创建的隔离空间验收真实界面，不创建、迁移或删除业务数据。
 * E2E_BASE_URL=... MAP_USER=... MAP_PASSWORD=... KB_SCALE_FIXTURE=/tmp/fixture.json
 * OUT_DIR=/tmp/kb-scale node e2e/knowledge-base-scale.mjs
 * fixture: [{"n":200,"id":"...","name":"...","lastEntryId":"...","tail":"tail-200-199"}, ...]
 */
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const base = process.env.E2E_BASE_URL;
const user = process.env.MAP_USER;
const password = process.env.MAP_PASSWORD;
const fixture = JSON.parse(fs.readFileSync(process.env.KB_SCALE_FIXTURE, 'utf8'));
const out = process.env.OUT_DIR || '/tmp/kb-scale';
if (!base || !user || !password || fixture.map(s => s.n).join(',') !== '200,1000,5000') throw Error('需要预览地址、登录凭据与三档隔离空间 manifest');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: process.env.NO_PROXY } : undefined });
const results = process.env.KB_SCALE_MODES && fs.existsSync(path.join(out, 'interaction-results.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'interaction-results.json'))) : [];
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function mark(locator, label) {
  await locator.evaluate((node, label) => {
    document.querySelectorAll('.__acc_box').forEach(el => el.remove());
    const rect = node.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = '__acc_box';
    box.setAttribute('aria-hidden', 'true');
    Object.assign(box.style, { position: 'fixed', left: `${rect.left - 3}px`, top: `${rect.top - 3}px`,
      width: `${rect.width + 6}px`, height: `${rect.height + 6}px`, border: '2px solid #ef4444',
      pointerEvents: 'none', zIndex: '999999', boxSizing: 'border-box' });
    const caption = document.createElement('span');
    caption.textContent = label;
    Object.assign(caption.style, { position: 'absolute', left: '0', bottom: '100%', color: '#ffffff',
      background: '#b91c1c', fontSize: '11px', padding: '2px 5px', whiteSpace: 'nowrap' });
    box.appendChild(caption);
    document.body.appendChild(box);
  }, label);
}

async function login(page) {
  await page.goto(new URL('/login', base).href);
  await page.getByPlaceholder('admin', { exact: true }).fill(user);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: '进入控制台' }).click();
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 60000 });
}

async function dismissGuide(page) {
  const done = page.getByRole('button', { name: '我已学会' });
  if (await done.isVisible().catch(() => false)) await done.click();
}

async function setTheme(page, theme, mobile) {
  const actual = await page.locator('html').getAttribute('data-theme');
  if ((actual || 'dark') === theme) return;
  const toggle = page.getByRole('button', { name: theme === 'light' ? '切换到浅色' : '切换到暗色' });
  if (mobile) { await toggle.waitFor(); await toggle.click(); }
  else {
    await page.getByRole('button', { name: '打开用户菜单', exact: true }).click();
    await page.getByRole('menuitemradio', { name: theme === 'light' ? '白天' : '黑夜', exact: true }).click();
    await page.keyboard.press('Escape');
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

try {
  for (const mobile of [false, true]) for (const theme of ['dark', 'light']) {
    if (process.env.KB_SCALE_MODES && !process.env.KB_SCALE_MODES.split(',').includes(`${mobile ? 'mobile' : 'desktop'}-${theme}`)) continue;
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile, hasTouch: mobile,
      recordVideo: { dir: path.join(out, 'video'), size: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 } },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await login(page);
      await setTheme(page, theme, mobile);
      // 以首页与侧栏中的可见入口进入，禁止深链替代操作路径。
      await page.getByText('知识库', { exact: true }).first().click();
      for (const store of fixture) {
        const label = `${mobile ? 'mobile' : 'desktop'}-${theme}-${store.n}`;
        await page.getByText(store.name, { exact: true }).waitFor();
        await dismissGuide(page);
        const requests = [];
        const handler = request => {
          if (request.url().includes('/api/document-store/')) requests.push({ method: request.method(), path: new URL(request.url()).pathname, query: new URL(request.url()).search, at: Date.now() });
        };
        page.on('request', handler);
        const start = Date.now();
        await page.getByText(store.name, { exact: true }).click();
        const search = page.getByPlaceholder('搜索标题或内容…');
        await search.waitFor();
        await frame(page);
        const firstVisibleMs = Date.now() - start;
        await expect(page.getByText(/正在补齐目录/)).toHaveCount(0);
        const folder = page.locator(`[data-entry-id="${store.id}-folder-0"]`);
        // 导入式 fixture 的文件夹 ID 可由 manifest 覆盖。
        const folderRow = store.folderId ? page.locator(`[data-entry-id="${store.folderId}"]`) : folder;
        await folderRow.waitFor();
        await frame(page);
        const completeBrowseMs = Date.now() - start;
        await mark(folderRow, "1 · 目录补齐");
        await page.screenshot({ path: path.join(out, `${label}-browse.png`) });
        const expandStart = Date.now();
        await folderRow.click();
        await frame(page);
        const expandMs = Date.now() - expandStart;
        await mark(folderRow, "2 · 展开目录");
        await page.screenshot({ path: path.join(out, `${label}-expand.png`) });
        const searchStart = Date.now();
        await search.fill(store.tail);
        const resultRow = page.locator(`[data-entry-id="${store.lastEntryId}"]`);
        await resultRow.waitFor();
        await expect(page.getByText('搜索中...', { exact: true })).toHaveCount(0);
        await frame(page);
        const searchMs = Date.now() - searchStart;
        await mark(resultRow, "3 · 文末关键词命中");
        await page.screenshot({ path: path.join(out, `${label}-search.png`) });
        const openStart = Date.now();
        await resultRow.click();
        await expect(page.locator('body')).toContainText(store.tail);
        await frame(page);
        const openMs = Date.now() - openStart;
        const tailText = page.getByText(new RegExp(`文末唯一词\\s+${store.tail}`));
        await tailText.scrollIntoViewIfNeeded();
        await expect(tailText).toBeInViewport();
        await mark(tailText, "4 · 正文文末回读");
        await page.screenshot({ path: path.join(out, `${label}-open.png`) });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        expect(errors).toEqual([]);
        page.off('request', handler);
        results.push({ n: store.n, mobile, theme, firstVisibleMs, completeBrowseMs, expandMs, searchMs, openMs, requests, errors });
        fs.writeFileSync(path.join(out, 'interaction-results.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ label, firstVisibleMs, completeBrowseMs, expandMs, searchMs, openMs, requests: requests.length }));
        await page.locator('.__acc_box').evaluateAll(nodes => nodes.forEach(node => node.remove()));
        // 使用应用返回控件返回库列表；移动端先从正文返回目录。
        if (mobile) {
          await page.getByRole('button', { name: /返回/ }).first().click();
        }
        const back = page.getByRole('button', { name: '返回知识库列表' });
        if (await back.isVisible().catch(() => false)) await back.click();
        else await page.getByText('知识库', { exact: true }).first().click();
      }
    } catch (error) {
      await page.screenshot({ path: path.join(out, `failure-${mobile}-${theme}.png`) });
      throw error;
    } finally {
      await context.close();
    }
  }
} finally { await browser.close(); }
