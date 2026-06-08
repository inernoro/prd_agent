import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');

const BASE = 'https://cds.miduo.org';
const USER = process.env.CDS_USERNAME;
const PASS = process.env.CDS_PASSWORD;
const OUT = '/tmp/cds_obs';
require('fs').mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
try {
  // 1. API login → cds_token cookie stored in this context's jar
  const login = await page.request.post(`${BASE}/api/login`, { data: { username: USER, password: PASS } });
  console.log('LOGIN', login.status());
  if (login.status() !== 200) { console.log('LOGIN_BODY', (await login.text()).slice(0, 200)); }

  // 2. project list
  await page.goto(`${BASE}/project-list`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/01-project-list.png` });
  console.log('project-list shot');

  // 3. open the Agent 会话 dialog (Sidecar Pool card trigger)
  const btn = page.locator('button[title="Agent 会话"]').first();
  const has = await btn.count();
  console.log('agent-session buttons:', has);
  if (has > 0) {
    await btn.click({ timeout: 8000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/02-session-list.png` });
    console.log('session-list shot');

    // 4. if a session row exists, open detail
    // dialog body lists sessions; try clicking the first clickable session row
    const rows = page.locator('[role="dialog"] button, [role="dialog"] [role="button"], [role="dialog"] li');
    const n = await rows.count();
    console.log('dialog rows:', n);
    let opened = false;
    for (let i = 0; i < Math.min(n, 8); i++) {
      const t = (await rows.nth(i).innerText().catch(() => '')) || '';
      if (/deepseek|claude|deny-all|running|done|会话|session|fccd|sess|PPT/i.test(t) && !/关闭|close|刷新/i.test(t)) {
        await rows.nth(i).click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await page.screenshot({ path: `${OUT}/03-session-detail.png` });
        console.log('session-detail shot via row', i, JSON.stringify(t.slice(0, 60)));
        opened = true;
        break;
      }
    }
    if (!opened) {
      const body = (await page.locator('[role="dialog"]').first().innerText().catch(() => '')) || '';
      console.log('DIALOG_TEXT', JSON.stringify(body.slice(0, 300)));
    }
  }
} catch (e) {
  console.log('ERR', e?.message || e);
} finally {
  await browser.close();
}
