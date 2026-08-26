import { chromium } from '@playwright/test';
import fs from 'node:fs';

const GW = 'http://127.0.0.1:7801';
const sso = JSON.parse(fs.readFileSync('/tmp/gwsso.json', 'utf8')).data;
const OUT = process.argv[2];

const seed = (s) => {
  localStorage.setItem('llmgw.token', s.token);
  localStorage.setItem('llmgw.user', JSON.stringify({ username: s.username, displayName: s.displayName, identityProvider: s.identityProvider }));
  localStorage.setItem('llmgw.tenant', JSON.stringify(s.tenant));
  localStorage.setItem('llmgw.expiresAt', s.expiresAt);
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-proxy-server'] });
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
  const page = await ctx.newPage();
  await page.addInitScript(seed, sso);
  await page.addInitScript((t) => localStorage.setItem('llmgw.theme', t), theme);
  await page.goto(`${GW}/pools`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('text=ASR 豆包 BigModel', { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/pools-${theme}.png`, fullPage: true });
  console.log(`pools-${theme} ok; 主题=`, await page.evaluate(() => document.documentElement.getAttribute('data-theme')));
  await ctx.close();
}

// 窄屏行操作菜单：注入一个和 CDS 徽章同尺寸同位置的占位，验证菜单会让开
const ctx = await browser.newContext({ viewport: { width: 420, height: 780 } });
const page = await ctx.newPage();
await page.addInitScript(seed, sso);
await page.goto(`${GW}/platforms`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('text=OpenRouter', { timeout: 60000 });
await page.evaluate(() => {
  const w = document.createElement('div');
  w.id = 'cds-widget';
  w.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;padding:5px 10px;border-radius:8px;background:rgba(35,134,54,.85);color:#e2e8f0;font:12px ui-monospace,monospace;line-height:1';
  w.textContent = 'cds 预览徽章占位';
  document.body.appendChild(w);
});
await page.waitForTimeout(400);
await page.locator('button[aria-label="更多操作"]').first().click();
await page.waitForTimeout(600);
const geo = await page.evaluate(() => {
  const menu = document.querySelector('.lg-row-actions-popover')?.getBoundingClientRect();
  const badge = document.getElementById('cds-widget')?.getBoundingClientRect();
  return { menuBottom: menu?.bottom, badgeTop: badge?.top, overlap: menu && badge ? menu.bottom > badge.top : null };
});
console.log('几何:', JSON.stringify(geo));
await page.screenshot({ path: `${OUT}/narrow-menu.png` });
await ctx.close();
await browser.close();
