import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { login } from './harness.mjs';
const fs = require('fs');
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const BASE='https://cds-agent-integration-x6rck-claude-prd-agent.miduo.org';
const cfg={auth:{browser:{userEnv:'MAP_AI_USER',passEnv:'MAP_ACCEPT_PASS',loginPath:'/login',userSelector:'input[type=text]',passSelector:'input[type=password]',submitSelector:'button:has-text("进入控制台")'}}};
const MD=`# AI 编程的信息损耗\n\n- 传统流程四层信息衰减\n- 端到端编程减少漂移\n\n---\n\n# 行业集体幻觉\n\n- 新工具循环\n- 守门员效应`;
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const ctx=await b.newContext({ignoreHTTPSErrors:true});const page=await ctx.newPage();
try{
 await login(page,BASE,cfg);
 const tok=await page.evaluate(()=>{for(const st of[sessionStorage,localStorage])for(let i=0;i<st.length;i++){const v=st.getItem(st.key(i));if(v&&/^ey/.test(v))return v;try{const o=JSON.parse(v);if(o?.state?.token)return o.state.token;if(o?.token)return o.token;}catch{}}return null;});
 const html=await page.evaluate(async({base,md,token})=>{
  const r=await fetch(base+'/api/md-to-ppt/convert',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({content:md,slideCount:0,theme:'深色玻璃',engine:'map'})});
  const rd=r.body.getReader();const dec=new TextDecoder();let buf='',ev='',out='';
  while(true){const{done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});const parts=buf.split('\n');buf=parts.pop();for(const ln of parts){if(ln.startsWith('event:'))ev=ln.slice(6).trim();else if(ln.startsWith('data:')){if(ev==='done'){try{out=JSON.parse(ln.slice(5)).html||'';}catch{}}}}}
  return out;
 },{base:BASE,md:MD,token:tok});
 fs.writeFileSync('/tmp/ppt_out.html',html);
 console.log('HTML len',html.length);
}catch(e){console.log('ERR',e?.message);}finally{await b.close();}
