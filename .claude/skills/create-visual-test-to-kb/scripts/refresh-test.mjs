import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { login } from './harness.mjs';
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const fs=require('fs'); fs.mkdirSync('/tmp/refresh',{recursive:true});
const BASE='https://cds-agent-integration-x6rck-claude-prd-agent.miduo.org';
const cfg={auth:{browser:{userEnv:'MAP_AI_USER',passEnv:'MAP_ACCEPT_PASS',loginPath:'/login',userSelector:'input[type=text]',passSelector:'input[type=password]',submitSelector:'button:has-text("进入控制台")'}}};
const MD=`# 刷新持久化测试\n\n- 服务端落库\n- 刷新重连\n\n---\n\n# 第二页\n\n- 要点 A\n- 要点 B`;
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const ctx=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}});const page=await ctx.newPage();
try{
 await login(page,BASE,cfg);
 await page.goto(BASE+'/md-to-ppt-agent',{waitUntil:'domcontentloaded',timeout:45000});
 await page.waitForTimeout(2500);
 await page.locator('textarea').first().fill(MD);
 await page.locator('button:has-text("生成 PPT")').first().click();
 let ok=false;for(let i=0;i<53;i++){await page.waitForTimeout(3000);if(await page.locator('iframe').count()>0){ok=true;break;}}
 console.log('generated, iframe present:',ok);
 const runId=await page.evaluate(()=>{try{return sessionStorage.getItem('md-to-ppt-active-run');}catch{return null;}});
 console.log('stored runId:',runId?runId.slice(0,12)+'...':'NONE');
 await page.waitForTimeout(2000);
 await page.screenshot({path:'/tmp/refresh/before-refresh.png'});
 // THE TEST: reload the page
 console.log('--- reloading page ---');
 await page.reload({waitUntil:'domcontentloaded'});
 // wait for restore (mount effect fetches run → restores html → iframe)
 let restored=false;for(let i=0;i<10;i++){await page.waitForTimeout(1500);if(await page.locator('iframe').count()>0){restored=true;break;}}
 console.log('AFTER REFRESH: iframe count =',await page.locator('iframe').count(),restored?'(RESTORED - persistence works!)':'(LOST - still broken)');
 await page.waitForTimeout(1500);
 await page.screenshot({path:'/tmp/refresh/after-refresh.png'});
}catch(e){console.log('ERR',e.message);}finally{await b.close();}
