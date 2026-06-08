import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const fs=require('fs');
let html=fs.readFileSync('/tmp/ppt_agent.html','utf8');
const revealJs=fs.readFileSync('/tmp/reveal.js','utf8');
const revealCss=fs.readFileSync('/tmp/reveal.css','utf8');
// inline: replace CDN reveal.css link + reveal.js script with local content
html=html.replace(/<link[^>]*reveal\.css[^>]*>/i, '<style>'+revealCss+'</style>');
html=html.replace(/<script[^>]*reveal\.js[^>]*><\/script>/i, '<script>'+revealJs+'</script>');
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const p=await (await b.newContext({viewport:{width:1280,height:720}})).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message.slice(0,140)));
await p.setContent(html,{waitUntil:'load',timeout:20000});
await p.waitForTimeout(2500);
const info=await p.evaluate(()=>({
  revealReady: !!(window.Reveal&&window.Reveal.isReady&&window.Reveal.isReady()),
  presentText: (document.querySelector('section.present')||{}).innerText?.slice(0,120)||'NONE',
  titleRect: (()=>{const t=document.querySelector('.title-xl,.title-md');if(!t)return 'no';const r=t.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});})(),slidesTransform: (()=>{const s=document.querySelector('.reveal .slides');return s?getComputedStyle(s).transform:'no';})(),
}));
console.log(JSON.stringify(info)); console.log('ERRS',JSON.stringify(errs.slice(0,3)));
await p.screenshot({path:'/tmp/cover-render.png'});
await b.close();
