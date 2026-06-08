import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { login } from './harness.mjs';
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const fs=require('fs'); fs.mkdirSync('/tmp/flip',{recursive:true});
const BASE='https://cds-agent-integration-x6rck-claude-prd-agent.miduo.org';
const cfg={auth:{browser:{userEnv:'MAP_AI_USER',passEnv:'MAP_ACCEPT_PASS',loginPath:'/login',userSelector:'input[type=text]',passSelector:'input[type=password]',submitSelector:'button:has-text("进入控制台")'}}};
const MD=`# 信息损耗\n\n- 四层衰减\n- 语义漂移\n\n---\n\n# 端到端范式\n\n- 直出系统\n- 保真提升\n\n---\n\n# 集体幻觉\n\n- 新工具循环\n- 守门员效应`;
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await (await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}})).newPage();
try{
 await login(page,BASE,cfg);
 await page.goto(BASE+'/md-to-ppt-agent',{waitUntil:'domcontentloaded',timeout:45000});
 await page.waitForTimeout(2500);
 await page.locator('textarea').first().fill(MD);
 await page.locator('button:has-text("生成 PPT")').first().click();
 // wait for iframe (done), up to 160s
 let ok=false; for(let i=0;i<53;i++){await page.waitForTimeout(3000);if(await page.locator('iframe').count()>0){ok=true;break;}}
 console.log('iframe present:',ok);
 if(!ok){await page.screenshot({path:'/tmp/flip/nodeck.png'});throw new Error('no deck');}
 await page.waitForTimeout(4000);
 const childFrames=()=>page.frames().filter(fr=>fr!==page.mainFrame());
 const fr=childFrames()[0];
 const i0=await fr.evaluate(()=>window.Reveal?JSON.stringify(window.Reveal.getIndices()):'no-reveal').catch(e=>'err:'+e.message.slice(0,40));
 console.log('slide index initial:',i0);
 await page.screenshot({path:'/tmp/flip/slide1.png'});
 // method A: call Reveal.next() programmatically
 const navOk=await fr.evaluate(()=>{try{if(window.Reveal){window.Reveal.next();return true;}return false;}catch(e){return 'err:'+e.message;}}).catch(e=>'err');
 await page.waitForTimeout(1200);
 const i1=await fr.evaluate(()=>window.Reveal?JSON.stringify(window.Reveal.getIndices()):'no-reveal').catch(e=>'err');
 console.log('Reveal.next() called:',navOk,' index after:',i1);
 await page.screenshot({path:'/tmp/flip/slide2.png'});
 // method B: click the iframe then ArrowRight (simulates user)
 const box=await page.locator('iframe').first().boundingBox();
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2); await page.waitForTimeout(300);
 await page.keyboard.press('ArrowRight'); await page.waitForTimeout(1000);
 const i2=await fr.evaluate(()=>window.Reveal?JSON.stringify(window.Reveal.getIndices()):'x').catch(e=>'err');
 console.log('after click+ArrowRight index:',i2);
 // method C: are reveal controls visible?
 const ctrl=await fr.evaluate(()=>{const c=document.querySelector('.reveal .controls');return c?{display:getComputedStyle(c).display,opacity:getComputedStyle(c).opacity}:'no-controls';}).catch(e=>'err');
 console.log('reveal controls:',JSON.stringify(ctrl));
}catch(e){console.log('ERR',e.message);}finally{await b.close();}
