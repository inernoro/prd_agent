// 验证 MD→PPT 走 CDS Agent: convert→流式HTML预览 + 确认创建了带 cdsSessionId 的会话
import { loadConfig, launch, login, shot, writeManifest } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const OUT = '/tmp/acc_cdsppt';
const { browser, page } = await launch(cfg);
const MD = '# AI 编程的信息损耗理论\n\n- 传统流程四层信息衰减\n- 端到端编程减少漂移\n\n---\n\n# 行业的集体幻觉\n\n- 新工具循环\n- 守门员效应';
let convertErr = null;
page.on('response', async (r) => { if (r.url().includes('/api/md-to-ppt/convert') && r.status()>=400) { try{convertErr=`${r.status()}:${(await r.text()).slice(0,150)}`;}catch{convertErr=String(r.status());} } });
try {
  await login(page, BASE, cfg);
  // 记录 convert 前的会话数
  const before = await page.evaluate(async () => { let tk=''; const v=sessionStorage.getItem('prd-admin-auth')||''; try{tk=JSON.parse(v).token||JSON.parse(v).state?.token||'';}catch{} const r=await fetch('/api/infra-agent-sessions?limit=100',{headers:{Authorization:`Bearer ${tk}`}}); const j=await r.json().catch(()=>({})); const items=j.data?.items||j.items||[]; return { count: items.length, ids: items.slice(0,3).map(s=>s.id) }; });
  await page.goto(BASE.replace(/\/+$/,'') + '/md-to-ppt-agent', { waitUntil:'domcontentloaded', timeout:45000 });
  await page.waitForSelector('textarea', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.locator('textarea').first().fill(MD);
  await shot(page, OUT, '01-input', 'MD 输入');
  await page.locator('button:has-text("生成")').first().click({ timeout: 8000 }).catch(e=>console.log('GENCLICK',e.message));
  // 等 agent 出 HTML(可能较久,CDS agent 链路)
  let gotHtml = false;
  for (let i=0;i<60;i++){ await page.waitForTimeout(3000); const has=await page.evaluate(()=>{const f=document.querySelector('iframe'); return !!(f&&f.getAttribute('srcdoc')&&f.getAttribute('srcdoc').includes('reveal'));}); if(has){gotHtml=true;break;} if(convertErr)break; }
  await page.waitForTimeout(2000);
  await shot(page, OUT, '02-preview', 'CDS Agent 产出的 HTML PPT 预览');
  // convert 后会话数 + 是否有带 cdsSessionId 的新会话
  const after = await page.evaluate(async () => { let tk=''; const v=sessionStorage.getItem('prd-admin-auth')||''; try{tk=JSON.parse(v).token||JSON.parse(v).state?.token||'';}catch{} const r=await fetch('/api/infra-agent-sessions?limit=100',{headers:{Authorization:`Bearer ${tk}`}}); const j=await r.json().catch(()=>({})); const items=j.data?.items||j.items||[]; const withCds=items.filter(s=>s.cdsSessionId); return { count: items.length, newestHasCds: items[0]?.cdsSessionId?true:false, newestTitle: items[0]?.title, withCdsCount: withCds.length }; });
  console.log('CDSPPT_VERIFY', JSON.stringify({ convertErr, gotHtml, before, after }));
  writeManifest(OUT);
} catch (e) { console.error('ERR', e.message); try{await shot(page,OUT,'99-err',e.message);}catch{} }
finally { await browser.close(); }
