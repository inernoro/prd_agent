import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { login } from './harness.mjs';
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const fs=require('fs');
const BASE='https://cds-agent-integration-x6rck-claude-prd-agent.miduo.org';
const cfg={auth:{browser:{userEnv:'MAP_AI_USER',passEnv:'MAP_ACCEPT_PASS',loginPath:'/login',userSelector:'input[type=text]',passSelector:'input[type=password]',submitSelector:'button:has-text("进入控制台")'}}};
const MD=`# 信息损耗\n\n- 四层衰减\n- 语义漂移\n\n---\n\n# 端到端\n\n- 直出系统\n- 保真提升\n\n---\n\n# 集体幻觉\n\n- 新工具循环\n- 守门员效应`;
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const ctx=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}});const page=await ctx.newPage();
fs.mkdirSync('/tmp/flip',{recursive:true});
try{
 await login(page,BASE,cfg);
 await page.goto(BASE+'/md-to-ppt-agent',{waitUntil:'domcontentloaded',timeout:45000});
 await page.waitForTimeout(2500);
 await page.locator('textarea').first().fill(MD);
 await page.locator('button:has-text("生成 PPT")').first().click();
 // wait for done (iframe appears)
 for(let i=0;i<40;i++){await page.waitForTimeout(3000);if(await page.locator('iframe').count()>0)break;}
 await page.waitForTimeout(3000);
 const frame=page.frameLocator('iframe').first();
 // capture slide 1
 await page.screenshot({path:'/tmp/flip/s1.png'});
 // get reveal state in iframe
 const f=page.frames().find(fr=>fr.url().includes('srcdoc')||fr.name()===''&&fr!==page.mainFrame());
 const frm = page.frames().filter(fr=>fr!==page.mainFrame());
 console.log('frames:', page.frames().length, frm.map(x=>x.url().slice(0,30)));
 // try clicking the iframe then ArrowRight
 const ifr=page.locator('iframe').first(); const box=await ifr.boundingBox();
 await page.mouse.click(box.x+box.width/2, box.y+box.height/2);
 await page.waitForTimeout(400);
 await page.keyboard.press('ArrowRight'); await page.waitForTimeout(1200);
 await page.screenshot({path:'/tmp/flip/s2-after-arrow.png'});
 // try clicking reveal's next control inside iframe
 try{ await frame.locator('.navigate-right, button[aria-label*="next"], .controls .navigate-right').first().click({timeout:3000}); }catch(e){console.log('next-ctrl click err',e.message.slice(0,60));}
 await page.waitForTimeout(1200);
 await page.screenshot({path:'/tmp/flip/s3-after-ctrl.png'});
 // read current slide index from iframe reveal
 try{ const idx=await page.frames().filter(fr=>fr!==page.mainFrame())[0].evaluate(()=>window.Reveal&&window.Reveal.getIndices?JSON.stringify(window.Reveal.getIndices()):'no-reveal'); console.log('reveal indices after nav:', idx);}catch(e){console.log('idx err',e.message.slice(0,60));}
}catch(e){console.log('ERR',e.message);}finally{await b.close();}
