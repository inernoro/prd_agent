import { loadConfig, launch, login } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const { browser, page } = await launch(cfg);
let r = null;
page.on('request', (req) => { if (req.url().includes('/api/md-to-ppt/render')) r = { url: req.url(), method: req.method(), headers: req.headers() }; });
page.on('response', async (resp) => { if (resp.url().includes('/api/md-to-ppt/render') && r) { r.status = resp.status(); try{r.respBody=(await resp.text()).slice(0,150);}catch{} } });
try {
  await login(page, BASE, cfg);
  await page.goto(BASE.replace(/\/+$/,'') + '/md-to-ppt-agent', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('textarea', { timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.locator('textarea').first().fill('# A\n- x\n---\n# B\n- y');
  await page.locator('button:has-text("生成")').first().click({ timeout: 8000 }).catch(()=>{});
  await page.waitForTimeout(30000);
  console.log('REALREQ', JSON.stringify(r, null, 1));
} catch (e) { console.error('ERR', e.message); }
finally { await browser.close(); }
