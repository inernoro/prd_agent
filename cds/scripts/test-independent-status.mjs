import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=readFileSync(process.argv[2]||new URL('./independent-status.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
async function render(snapshot,{drill=false,recovered=false}={}){
  const elements=new Map();
  const el=id=>{if(!elements.has(id))elements.set(id,{textContent:'',classList:{add(){},remove(){},toggle(){}},replaceChildren(){},append(){}});return elements.get(id)};
  const notice={name:'外部监控',assessment:'monitor-heartbeat',finding:'心跳中断',detectedAt:new Date().toISOString(),drill,recovered};
  const context=vm.createContext({URL,URLSearchParams,Date,JSON,Number,String,Error,AbortController,
    setTimeout,clearTimeout,setInterval(){},document:{getElementById:el,querySelector(){return null},createElement:()=>el(Math.random())},
    location:{hash:'#'+new URLSearchParams({watchdog:'https://fixture.invalid/status',notice:JSON.stringify(notice)}),search:''},
    localStorage:{getItem(){return null},setItem(){}},fetch:async()=>({ok:true,json:async()=>snapshot})});
  vm.runInContext(script,context);await new Promise(r=>setImmediate(r));return elements;
}
const fresh={healthy:true,updatedAt:new Date().toISOString(),incident:null};
let e=await render(fresh);assert.equal(e.get('watchdog-title').textContent,'外部监控心跳正常');assert.match(e.get('notice-action').textContent,/外部监控进程/);
e=await render({...fresh,healthy:false,incident:{startedAt:fresh.updatedAt}});assert.equal(e.get('watchdog-title').textContent,'外部监控心跳中断');
e=await render({...fresh,incident:{startedAt:fresh.updatedAt}});assert.match(e.get('watchdog-title').textContent,/正在确认稳定恢复/);
e=await render({...fresh,updatedAt:new Date(Date.now()-1000000).toISOString()});assert.match(e.get('watchdog-title').textContent,/已过期/);
e=await render({...fresh,updatedAt:'invalid'});assert.match(e.get('watchdog-title').textContent,/无法读取/);
e=await render(fresh,{drill:true});assert.match(e.get('notice-impact').textContent,/模拟心跳过期/);assert.doesNotMatch(e.get('notice-impact').textContent,/5 项/);
console.log('独立故障页：6 个场景通过');
