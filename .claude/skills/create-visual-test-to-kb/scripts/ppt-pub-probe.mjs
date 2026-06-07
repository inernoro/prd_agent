import { loadConfig, launch, login } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const { browser, page } = await launch(cfg);
try {
  await login(page, BASE, cfg);
  await page.goto(BASE.replace(/\/+$/,'') + '/md-to-ppt-agent', { waitUntil:'domcontentloaded', timeout:45000 });
  await page.waitForSelector('textarea', { timeout: 20000 });
  const out = await page.evaluate(async () => {
    let token=''; const v=sessionStorage.getItem('prd-admin-auth')||localStorage.getItem('prd-admin-auth')||''; try{const j=JSON.parse(v); token=j.token||j.state?.token||'';}catch{}
    const H={'Content-Type':'application/json',Authorization:`Bearer ${token}`};
    const html='<!DOCTYPE html><html><head><title>t</title></head><body><div class="reveal"><div class="slides"><section><h2>A</h2></section></div></div></body></html>';
    const call=async(body,label)=>{try{const r=await fetch('/api/md-to-ppt/publish',{method:'POST',headers:H,body:JSON.stringify(body)});return{label,status:r.status,ct:r.headers.get('content-type'),server:r.headers.get('server'),body:(await r.text()).slice(0,250)};}catch(e){return{label,err:String(e)};}};
    return { withHtml: await call({htmlContent:html,title:'测试PPT'},'htmlContent'), withSlides: await call({slides:[{title:'A',bullets:['x']}],theme:'black',title:'t'},'slides-old') };
  });
  console.log('PUBPROBE', JSON.stringify(out, null, 1));
} catch (e) { console.error('ERR', e.message); }
finally { await browser.close(); }
