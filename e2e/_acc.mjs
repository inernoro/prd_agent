import { chromium } from '@playwright/test';
import fs from 'node:fs';

const API = 'https://home-model-leaderboard-claude-prd-agent.miduo.org';  // 登录走 node（信任库正常）
const APP = 'http://127.0.0.1:7801';                                      // 浏览器走 relay
const OUT = process.env.OUT; fs.mkdirSync(OUT, { recursive: true });

const r = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: process.env.MAP_USER, password: process.env.MAP_PASSWORD, clientType: 'admin' }),
});
const b = await r.json();
if (!b.success) throw new Error('登录失败 ' + JSON.stringify(b.error));
const d = b.data;
console.log('登录:', d.user?.username, '| 角色:', d.user?.role, '| isRoot:', d.user?.isRoot);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-proxy-server'],
});

async function shoot(theme) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(([payload, th]) => {
    const st = { state: {
      isAuthenticated: true, user: payload.user,
      token: payload.accessToken, refreshToken: payload.refreshToken, sessionKey: payload.sessionKey,
      permissions: [], permissionsLoaded: false, isRoot: false,
      menuCatalog: [], menuCatalogLoaded: false, cdnBaseUrl: '', permFingerprint: '',
    }, version: 0 };
    // 键名取自 authStore.ts 的 AUTH_STORAGE_KEY，storage 是 localStorage
    try { localStorage.setItem('prd-admin-auth', JSON.stringify(st)); } catch {}
    try { localStorage.setItem('mobile-theme', JSON.stringify({ state: { theme: th }, version: 0 })); } catch {}
    try { document.documentElement.setAttribute('data-theme', th); } catch {}
  }, [d, theme]);

  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
  page.on('response', (res) => { if (res.status() >= 400 && res.url().includes('/api/')) errs.push(`${res.status()} ${new URL(res.url()).pathname}`); });

  // 真人路径：从首页进，点导航，不地址栏直达
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  console.log(`[${theme}] 首页 URL:`, page.url());
  await page.screenshot({ path: `${OUT}/${theme}-1-home.png` });

  // 首页右上角的模型榜挂件
  const widget = page.locator('[data-tour-id="home-model-rank"]');
  const hasWidget = await widget.count();
  console.log(`[${theme}] 首页模型榜挂件:`, hasWidget ? '在' : '没找到');
  if (hasWidget) {
    await widget.first().click();
  } else {
    await page.goto(`${APP}/model-leaderboard`, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForTimeout(3500);
  console.log(`[${theme}] 榜单页 URL:`, page.url());
  await page.screenshot({ path: `${OUT}/${theme}-2-agent.png` });

  // 量列宽：空白到底还在不在
  const grid = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((n) =>
      getComputedStyle(n).display === 'grid' && getComputedStyle(n).gridTemplateColumns.split(' ').length > 5);
    if (!el) return null;
    return { cols: getComputedStyle(el).gridTemplateColumns, width: el.getBoundingClientRect().width };
  });
  console.log(`[${theme}] 表格列宽:`, JSON.stringify(grid));

  // 切到文生图
  const tab = page.getByRole('button', { name: '文生图', exact: true });
  if (await tab.count()) {
    await tab.first().click();
    await page.waitForTimeout(3000);
    console.log(`[${theme}] 切换后 URL:`, page.url());
    await page.screenshot({ path: `${OUT}/${theme}-3-text-to-image.png` });
    const g2 = await page.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find((n) =>
        getComputedStyle(n).display === 'grid' && getComputedStyle(n).gridTemplateColumns.split(' ').length > 4);
      return el ? getComputedStyle(el).gridTemplateColumns : null;
    });
    console.log(`[${theme}] 文生图列宽:`, g2);
  } else {
    console.log(`[${theme}] 没找到「文生图」按钮`);
  }

  const bad = errs.filter((e) => !/cloudflareinsights|favicon/i.test(e));
  console.log(`[${theme}] 报错:`, bad.length ? bad.slice(0, 4) : '无');
  await ctx.close();
}

await shoot('dark');
await shoot('light');
await browser.close();
