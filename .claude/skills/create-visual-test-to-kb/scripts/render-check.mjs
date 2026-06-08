import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const fs=require('fs'); const html=fs.readFileSync('/tmp/ppt_out.html','utf8');
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const p=await (await b.newContext({viewport:{width:1280,height:720}})).newPage();
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,120));});
p.on('pageerror',e=>errs.push('PAGEERR '+e.message.slice(0,120)));
await p.setContent(html,{waitUntil:'load',timeout:30000});
await p.waitForTimeout(4000);
const st=await p.evaluate(()=>({
  revealDefined: typeof window.Reveal!=='undefined',
  revealReady: window.Reveal&&window.Reveal.isReady&&window.Reveal.isReady(),
  sectionCount: document.querySelectorAll('.slides section').length,
  presentSlide: document.querySelector('section.present')?document.querySelector('section.present').innerText.slice(0,80):'NONE',
  firstSectionDisplay: getComputedStyle(document.querySelector('.slides section')).display,
  firstSectionVisibility: getComputedStyle(document.querySelector('.slides section')).visibility,
  titleColor: (()=>{const t=document.querySelector('.title-xl,.title-md,h1,h2');return t?getComputedStyle(t).color+' / clip:'+getComputedStyle(t).webkitBackgroundClip:'no-title';})(),
}));
console.log(JSON.stringify(st,null,1));
console.log('CONSOLE_ERRORS', JSON.stringify(errs.slice(0,5)));
await b.close();
