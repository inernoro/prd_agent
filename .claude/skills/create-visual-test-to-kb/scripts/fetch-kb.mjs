import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { login } from './harness.mjs';
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const fs=require('fs');
const BASE='https://cds-agent-integration-x6rck-claude-prd-agent.miduo.org';
const cfg={auth:{browser:{userEnv:'MAP_AI_USER',passEnv:'MAP_ACCEPT_PASS',loginPath:'/login',userSelector:'input[type=text]',passSelector:'input[type=password]',submitSelector:'button:has-text("进入控制台")'}}};
const b=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await (await b.newContext({ignoreHTTPSErrors:true})).newPage();
try{
 await login(page,BASE,cfg);
 const tok=await page.evaluate(()=>{for(const st of[sessionStorage,localStorage])for(let i=0;i<st.length;i++){const v=st.getItem(st.key(i));if(v&&/^ey/.test(v))return v;try{const o=JSON.parse(v);if(o?.state?.token)return o.state.token;if(o?.token)return o.token;}catch{}}return null;});
 const res=await page.evaluate(async({base,token})=>{
  const h={'Authorization':'Bearer '+token};
  // try common document-store endpoints
  for(const url of ['/api/document-stores','/api/document-store/stores','/api/document/stores']){
   try{const r=await fetch(base+url,{headers:h});if(r.ok){const j=await r.json();return {url,j:JSON.stringify(j).slice(0,500)};}}catch(e){}
  }
  return {none:true};
 },{base:BASE,token:tok});
 console.log(JSON.stringify(res).slice(0,600));
}catch(e){console.log('ERR',e.message);}finally{await b.close();}
