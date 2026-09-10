/*
 * 真视觉验收：以真人路径打开 CDS 监控中心第一屏，双主题取证。
 * 凭据从环境变量读，绝不写盘、绝不打印。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:7801';
const OUT = process.argv[2] || '.';
const user = process.env.CDS_USERNAME;
const pass = process.env.CDS_PASSWORD;
if (!user || !pass) { console.error('缺少 CDS_USERNAME / CDS_PASSWORD'); process.exit(2); }

const log = (...a) => console.log('[shoot]', ...a);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-proxy-server'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') log('console.error:', m.text().slice(0, 200)); });

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
log('login page', page.url());
await page.waitForTimeout(5000);
try { await page.locator('input').first().waitFor({ timeout: 20000 }); } catch { log('无 input'); }

// 表单字段名未知，按常见 selector 逐个试
const userSel = ['input:not([type=password])'];
const passSel = ['input[name=password]', 'input[type=password]'];
let filled = false;
for (const us of userSel) {
  if (await page.locator(us).count()) {
    await page.locator(us).first().fill(user);
    for (const ps of passSel) {
      if (await page.locator(ps).count()) { await page.locator(ps).first().fill(pass); filled = true; break; }
    }
    break;
  }
}
if (!filled) { fs.writeFileSync(`${OUT}/login-dom.html`, await page.content()); log('未找到登录表单，DOM 已存盘'); await browser.close(); process.exit(3); }
await page.locator('button[type=submit], button:has-text("登录")').first().click();
await page.waitForTimeout(4000);
log('after login', page.url());

// 真人路径：登录后从导航点进监控中心，不用地址栏直达
const navHit = await page.locator('a[href="/status"], a:has-text("监控")').first();
if (await navHit.count()) { await navHit.click(); } else { log('导航里没找到监控入口，退回直达'); await page.goto(`${BASE}/status`, { waitUntil: 'domcontentloaded' }); }
await page.waitForTimeout(6000);
log('status page', page.url());

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  log('shot', name);
}

// 第一屏必须真的渲染出来才截图（不截骨架屏）
try {
  await page.getByText('我盯的业务').first().waitFor({ timeout: 30000 });
  log('第一屏已渲染：找到「我盯的业务」');
} catch {
  log('警告：30s 内没等到「我盯的业务」，下面的图只用于记录现象');
}

const mapChip = page.getByRole('button', { name: 'MAP', exact: true });
if (await mapChip.count()) { await mapChip.first().click(); await page.waitForTimeout(1500); log('已选中 MAP 项目'); }
for (const theme of ['dark', 'light']) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForTimeout(1200);
  await shot(`status-owner-${theme}`);
}

// 切到「全部目标」看曲线与柱条（那三处缺陷所在）
const allTab = page.getByRole('tab', { name: '全部目标' });
if (await allTab.count()) {
  await allTab.first().click();
  await page.waitForTimeout(3000);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(600);
  await shot('v2-all-dark');
}

// 抓一份第一屏的机读事实，供断言
const facts = await page.evaluate(() => {
  const txt = (sel) => Array.from(document.querySelectorAll(sel)).map((e) => e.textContent?.trim()).filter(Boolean);
  const svg = document.querySelector('svg[aria-label="响应时间曲线"]');
  const rect = svg?.getBoundingClientRect();
  return {
    hasOwnerBoard: document.body.innerText.includes('我盯的业务'),
    headline: document.body.innerText.split('\n').slice(0, 40),
    chart: svg ? { viewBox: svg.getAttribute('viewBox'), w: rect?.width, h: rect?.height } : null,
    readout: txt('[data-testid="bar-readout"]'),
  };
});
fs.writeFileSync(`${OUT}/facts.json`, JSON.stringify(facts, null, 2));
log('facts written');

await browser.close();
