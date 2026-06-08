import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { login } from './harness.mjs';
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const fs=require('fs'); fs.mkdirSync('/tmp/kbacc',{recursive:true});
const BASE='https://cds-agent-integration-x6rck-claude-prd-agent.miduo.org';
const cfg={auth:{browser:{userEnv:'MAP_AI_USER',passEnv:'MAP_ACCEPT_PASS',loginPath:'/login',userSelector:'input[type=text]',passSelector:'input[type=password]',submitSelector:'button:has-text("进入控制台")'}}};
const MD=fs.readFileSync('/tmp/kb-article.md','utf8');
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await (await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}})).newPage();
const shotIframe=async(name)=>{const box=await page.locator('iframe').first().boundingBox();await page.screenshot({path:'/tmp/kbacc/'+name+'.png',clip:box});};
try{
 await login(page,BASE,cfg);
 await page.goto(BASE+'/md-to-ppt-agent',{waitUntil:'domcontentloaded',timeout:45000});
 await page.waitForTimeout(2500);
 await page.locator('textarea').first().fill(MD);
 await page.locator('button:has-text("生成 PPT")').first().click();
 let ok=false;for(let i=0;i<53;i++){await page.waitForTimeout(3000);if(await page.locator('iframe').count()>0){ok=true;break;}}
 console.log('deck rendered:',ok); if(!ok){await page.screenshot({path:'/tmp/kbacc/fail.png'});throw new Error('no deck');}
 await page.waitForTimeout(4500);
 const fr=()=>page.frames().filter(f=>f!==page.mainFrame())[0];
 const total=await fr().evaluate(()=>window.Reveal?window.Reveal.getTotalSlides():0).catch(()=>0);
 console.log('total slides:',total);
 await shotIframe('slide1');
 // flip via the NEW 下一页 button, capturing each
 for(let i=2;i<=Math.min(total,5);i++){
   await page.locator('button[title="下一页"]').click();
   await page.waitForTimeout(900);
   const idx=await fr().evaluate(()=>window.Reveal?window.Reveal.getIndices().h:-1).catch(()=>-1);
   console.log('clicked 下一页 -> slide index h=',idx);
   await shotIframe('slide'+i);
 }
 // refresh persistence test
 await page.reload({waitUntil:'domcontentloaded'}); await page.waitForTimeout(3000);
 const afterReload=await page.locator('iframe').count();
 console.log('after refresh: iframe count =',afterReload,'(0 = result lost, server-authority gap)');
 await page.screenshot({path:'/tmp/kbacc/after-refresh.png'});
}catch(e){console.log('ERR',e.message);}finally{await b.close();}
