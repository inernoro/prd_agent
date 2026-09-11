const pw = (await import('/home/user/prd_agent/cds/node_modules/playwright/index.js')).default;
const { chromium } = pw;
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:7852';
const OUT = process.env.UAT_OUT;
const facts = {};
const log = (...a) => console.log('[verify2]', ...a);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const shot = async (n) => { await page.screenshot({ path: `${OUT}/${n}.png` }); log('shot', n); };
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.locator('input[autocomplete=username]').first().fill(process.env.CDS_USERNAME);
await page.locator('input[type=password]').first().fill(process.env.CDS_PASSWORD);
await page.locator('button[type=submit]').first().click();
await page.waitForTimeout(4000);
await page.goto(`${BASE}/status`, { waitUntil: 'domcontentloaded' });
await page.getByText('我盯的业务').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(2500);
await page.getByText('MAP', { exact: true }).first().click();
await page.waitForTimeout(2500);

const envState = async () => page.evaluate(() => [...document.querySelectorAll('button[aria-pressed]')]
  .filter(b => /生产|分支预览|预发|其他/.test(b.innerText))
  .map(b => ({ label: b.innerText.trim(), on: b.getAttribute('aria-pressed') === 'true' })));
facts.envBefore = await envState();
log('环境 chip 初始：', JSON.stringify(facts.envBefore));

// 目标状态：只勾生产（业务监控全在分支预览 → 行为空 → 该出「被筛选挡住」）
for (const want of [{ label: '生产', on: true }, { label: '分支预览', on: false }]) {
  const cur = (await envState()).find(e => e.label.includes(want.label));
  if (cur && cur.on !== want.on) {
    await page.locator('button[aria-pressed]').filter({ hasText: want.label }).first().click();
    await page.waitForTimeout(1800);
    log(`切换 ${want.label} -> ${want.on}`);
  }
}
facts.envAfter = await envState();
await page.waitForTimeout(1500);
await shot('I1-hidden-by-filter');
facts.hidden = await page.evaluate(() => {
  const t = document.body.innerText;
  return {
    saysNone: t.includes('还没有一条业务监控'),
    headline: (t.match(/[^\n]*不在当前环境筛选里[^\n]*/g) || [])[0] || null,
    detail: (t.match(/[^\n]*它们在「[^\n]*/g) || [])[0] || null,
    buttons: [...document.querySelectorAll('button')].filter(b => b.innerText.trim() === '看这些环境').length,
  };
});
log('挡住时：', JSON.stringify(facts.hidden));

const reveal = page.locator('button', { hasText: '看这些环境' }).first();
if (await reveal.count()) {
  await reveal.click();
  await page.waitForTimeout(2500);
  await shot('I2-revealed');
  facts.revealed = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('button')].filter(b => /窗口内|环境都通过判据|没读到样本/.test(b.innerText || '')).length,
    headline: (document.body.innerText.match(/[^\n]*项业务在[^\n]*/g) || [])[0] || null,
  }));
  facts.envRevealed = await envState();
  log('一键切换后：', JSON.stringify(facts.revealed), JSON.stringify(facts.envRevealed));
} else { facts.revealed = { error: '没有「看这些环境」按钮' }; }

fs.writeFileSync(`${OUT}/verify2-facts.json`, JSON.stringify(facts, null, 2));
await browser.close();
