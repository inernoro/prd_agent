import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const fs=require('fs'); const html=fs.readFileSync('/tmp/ppt_out.html','utf8');
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const p=await (await b.newContext({viewport:{width:1280,height:720}})).newPage();
await p.setContent(html,{waitUntil:'networkidle',timeout:30000});
await p.waitForTimeout(2500);
await p.screenshot({path:'/tmp/render-slide1.png'});
for(let i=0;i<2;i++){await p.keyboard.press('ArrowRight');await p.waitForTimeout(1200);}
await p.screenshot({path:'/tmp/render-slide3.png'});
console.log('rendered');
await b.close();
