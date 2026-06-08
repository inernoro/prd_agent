import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { login } from './harness.mjs';
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const fs=require('fs'); fs.mkdirSync('/tmp/styles',{recursive:true});
const BASE='https://cds-agent-integration-x6rck-claude-prd-agent.miduo.org';
const cfg={auth:{browser:{userEnv:'MAP_AI_USER',passEnv:'MAP_ACCEPT_PASS',loginPath:'/login',userSelector:'input[type=text]',passSelector:'input[type=password]',submitSelector:'button:has-text("进入控制台")'}}};
const MD=`# 端到端 AI 编程\n\n- 信息损耗：传统四层衰减\n- 端到端范式减少漂移\n\n---\n\n# 三大变化\n\n- 速度 2.4x\n- 意图保留 87%\n- 缺陷下降 62%`;
const themes=[['dark-glass','深色玻璃'],['light-clean','浅色简洁'],['corporate-blue','商务蓝']];
const b=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await (await b.newContext({ignoreHTTPSErrors:true})).newPage();
try{
 await login(page,BASE,cfg);
 const tok=await page.evaluate(()=>{for(const st of[sessionStorage,localStorage])for(let i=0;i<st.length;i++){const v=st.getItem(st.key(i));if(v&&/^ey/.test(v))return v;try{const o=JSON.parse(v);if(o?.state?.token)return o.state.token;}catch{}}return null;});
 for(const [val,label] of themes){
   const html=await page.evaluate(async({base,md,token,theme})=>{
     const r=await fetch(base+'/api/md-to-ppt/convert',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({content:md,slideCount:5,theme,engine:'map'})});
     const rd=r.body.getReader();const dec=new TextDecoder();let buf='',ev='',out='';
     while(true){const{done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});const parts=buf.split('\n');buf=parts.pop();for(const ln of parts){if(ln.startsWith('event:'))ev=ln.slice(6).trim();else if(ln.startsWith('data:')){if(ev==='done'){try{out=JSON.parse(ln.slice(5)).html||'';}catch{}}}}}
     return out;
   },{base:BASE,md:MD,token:tok,theme:val});
   fs.writeFileSync('/tmp/styles/'+val+'.html',html);
   console.log(label,'('+val+'):',html.length,'chars');
 }
}catch(e){console.log('ERR',e.message);}finally{await b.close();}
