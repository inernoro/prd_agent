// 实战交代:直连 convert(engine=agent),读 SSE,采集 diag/delta/done/error 时间线
import { loadConfig, launch, login } from './harness.mjs';
const cfg = loadConfig(new URL('../acceptance.config.json', import.meta.url).pathname);
const BASE = process.argv[2];
const { browser, page } = await launch(cfg);
try {
  await login(page, BASE, cfg);
  await page.goto(BASE.replace(/\/+$/,'') + '/md-to-ppt', { waitUntil:'domcontentloaded', timeout:45000 }).catch(()=>{});
  const out = await page.evaluate(async () => {
    let tk=''; const v=sessionStorage.getItem('prd-admin-auth')||''; try{tk=JSON.parse(v).token||JSON.parse(v).state?.token||'';}catch{}
    const t0=Date.now();
    const events=[]; let deltaCount=0, deltaChars=0;
    const resp=await fetch('/api/md-to-ppt/convert',{method:'POST',headers:{'Content-Type':'application/json',Accept:'text/event-stream',Authorization:`Bearer ${tk}`},body:JSON.stringify({content:'# AI 编程信息损耗\n- 四层衰减\n- 端到端\n---\n# 集体幻觉\n- 工具循环\n- 守门员',engine:'agent',theme:'dark-glass'})});
    if(!resp.ok) return { httpError: resp.status };
    const reader=resp.body.getReader(); const dec=new TextDecoder(); let buf='',ev='',data='';
    const deadline=Date.now()+150000;
    while(Date.now()<deadline){ const {done,value}=await reader.read(); if(done)break; buf+=dec.decode(value,{stream:true}); const lines=buf.split('\n'); buf=lines.pop()??'';
      for(const ln of lines){ if(ln.startsWith('event:'))ev=ln.slice(6).trim(); else if(ln.startsWith('data:'))data=ln.slice(5).trim(); else if(ln===''&&ev){ const el=Date.now()-t0; if(ev==='diag'){try{events.push({t:el,diag:JSON.parse(data)});}catch{}} else if(ev==='delta'){deltaCount++; try{deltaChars+=(JSON.parse(data).text||'').length;}catch{}} else if(ev==='done'){events.push({t:el,done:true}); ev='';data=''; return {events,deltaCount,deltaChars,finishedMs:el};} else if(ev==='error'){events.push({t:el,error:data.slice(0,200)}); return {events,deltaCount,deltaChars};} else if(ev!=='model'){events.push({t:el,ev});} ev='';data='';}}
    }
    return { events, deltaCount, deltaChars, timedOutClientSide:true };
  });
  console.log('DIAG_RESULT', JSON.stringify(out));
} catch(e){ console.error('ERR', e.message); }
finally { await browser.close(); }
