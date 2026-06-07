import { loadConfig, launch } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const { browser, page } = await launch(cfg);
try {
  await page.goto('https://cfi.miduo.org/data/web-hosting/sites/d7cbaf0db4644cfe9e7c1135ec11dd40/index.html', { waitUntil:'networkidle', timeout:30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path:'/tmp/acc_ppt/04-published-site.png' });
  const t = await page.evaluate(()=>({ hasReveal:!!document.querySelector('.reveal'), sections:document.querySelectorAll('.slides section').length, title:document.title }));
  console.log('SITE', JSON.stringify(t));
} catch(e){ console.log('SITEERR', e.message); } finally { await browser.close(); }
