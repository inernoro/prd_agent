import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { login } from './harness.mjs';
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const BASE='https://cds-agent-integration-x6rck-claude-prd-agent.miduo.org';
const cfg={auth:{browser:{userEnv:'MAP_AI_USER',passEnv:'MAP_ACCEPT_PASS',loginPath:'/login',userSelector:'input[type=text]',passSelector:'input[type=password]',submitSelector:'button:has-text("进入控制台")'}}};
const b=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await (await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}})).newPage();
try{
 await login(page,BASE,cfg);
 await page.goto(BASE+'/md-to-ppt-agent',{waitUntil:'domcontentloaded',timeout:45000});
 await page.waitForTimeout(2500);
 await page.locator('textarea').first().fill('# 示例\n\n- 要点一\n- 要点二\n\n这是一段用来触发页数估算的内容，让建议页数显示出来。');
 await page.waitForTimeout(800);
 // click CDS Agent engine to show it selected
 await page.locator('button:has-text("CDS Agent")').last().click().catch(()=>{});
 await page.waitForTimeout(500);
 await page.screenshot({path:'/tmp/ui-controls.png'});
 console.log('captured');
}catch(e){console.log('ERR',e.message);}finally{await b.close();}
