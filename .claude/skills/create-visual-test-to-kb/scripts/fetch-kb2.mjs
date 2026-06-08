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
 const out=await page.evaluate(async({base,token})=>{
  const h={'Authorization':'Bearer '+token};
  const stores=(await (await fetch(base+'/api/document-store/stores',{headers:h})).json()).data.items;
  const log=[];
  for(const s of stores.slice(0,8)) log.push(s.name+'('+s.documentCount+')'+' id='+s.id);
  // pick a store with docs, list entries
  const store=stores.find(s=>s.documentCount>0&&s.name!=='验收报告')||stores[0];
  let entries=null;
  for(const u of ['/api/document-store/stores/'+store.id+'/entries','/api/document-store/stores/'+store.id]){
    try{const r=await fetch(base+u,{headers:h});if(r.ok){const j=await r.json();entries=j.data?.entries||j.data?.items||j.data?.recentEntries||(j.data&&j.data.id?[j.data]:null);if(entries){break;}}}catch(e){}
  }
  if(!entries||!entries.length) return {log,store:store.name,noentries:true};
  // fetch first entry content
  const e0=entries[0];
  let content='';
  for(const u of ['/api/document-store/entries/'+e0.id,'/api/document-store/entries/'+e0.id+'/content','/api/document-store/stores/'+store.id+'/entries/'+e0.id]){
    try{const r=await fetch(base+u,{headers:h});if(r.ok){const j=await r.json();content=j.data?.content||j.data?.markdown||j.data?.body||'';if(content)break;}}catch(e){}
  }
  return {log,store:store.name,entryTitle:e0.title||e0.name,contentLen:content.length,content:content.slice(0,4000)};
 },{base:BASE,token:tok});
 console.log('STORES:',out.log&&out.log.join(' | '));
 console.log('PICKED:',out.store,'ENTRY:',out.entryTitle,'LEN:',out.contentLen);
 if(out.content) fs.writeFileSync('/tmp/kb-article.md',out.content);
 console.log('saved /tmp/kb-article.md');
}catch(e){console.log('ERR',e.message);}finally{await b.close();}
