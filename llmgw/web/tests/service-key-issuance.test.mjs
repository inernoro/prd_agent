import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('密钥页直接签发以权威身份裁决，未知登记或签发不盲重提且不伪造明文', async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/service-keys'});const names=['window','document','HTMLElement','HTMLInputElement','Event','MouseEvent'];const old=Object.fromEntries(names.map(n=>[n,globalThis[n]]));for(const n of names)globalThis[n]=dom.window[n];globalThis.IS_REACT_ACT_ENVIRONMENT=true;dom.window.HTMLElement.prototype.scrollTo=()=>{};
 const router=await import('react-router-dom');globalThis.__keyRouter={...router.default,...router};const {createRoot}=await import('react-dom/client');
 const key={id:'old',name:'已有密钥',keyPrefix:'gwk_old',enabled:true,sourceSystem:'external',clientCode:'old',environment:'test',purpose:'external-platform',appCallerCodes:['old.feature::chat'],ingressProtocols:['openai-compatible'],scopes:['invoke'],allowedCidrs:[],rotationState:'active'};
 const f={callers:[],keys:[key],callerWrites:[],keyWrites:[],callerResult:{success:false,error:{code:'UNRECOGNISED_ERROR',message:'body lost'}}};globalThis.__keyFixture=f;
 const api=await readFile(new URL('../src/lib/api.ts',import.meta.url),'utf8');const exports=[...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(m=>m[1]);
 const server=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),server:{middlewareMode:true},appType:'custom',logLevel:'silent',optimizeDeps:{noDiscovery:true,include:[]},ssr:{noExternal:['react-router-dom']},plugins:[{name:'key-issue-fixture',enforce:'pre',resolveId(id){if(id==='react-router-dom')return '\0key-router'},load(id){
  if(id==='\0key-router')return Object.keys(globalThis.__keyRouter).filter(n=>n!=='default').map(n=>`export const ${n}=globalThis.__keyRouter.${n};`).join('\n');
  if(id.endsWith('/src/lib/auth.tsx'))return 'export function useAuth(){return {tenant:{id:"tenant",role:"owner",teamIds:["team"]}}}';
  if(id.endsWith('/src/components/ConfirmDialog.tsx'))return 'export function useDialogs(){return {confirm:async()=>false,alert:async()=>{}}}';
  if(id.endsWith('/src/lib/api.ts'))return exports.map(n=>{
   if(n==='getGatewayAppCallers')return 'export async function getGatewayAppCallers(){return {success:true,data:{items:globalThis.__keyFixture.callers,total:globalThis.__keyFixture.callers.length}}}';
   if(n==='getServiceKeys')return 'export async function getServiceKeys(){return {success:true,data:globalThis.__keyFixture.keys}}';
   if(n==='getOrganization')return 'export async function getOrganization(){return {success:true,data:{teams:[{id:"team",name:"业务团队",status:"active"}]}}}';
   if(n==='createGatewayAppCaller')return 'export async function createGatewayAppCaller(body){const f=globalThis.__keyFixture;f.callerWrites.push(body);return f.callerResult}';
   if(n==='createServiceKey')return 'export async function createServiceKey(body){const f=globalThis.__keyFixture;f.keyWrites.push(body);return f.keyResult??{success:false,error:{code:"NETWORK_ERROR",message:"response lost"}}}';
   return `export async function ${n}(){return {success:true,data:{applicable:false,items:[]}}}`;
  }).join('\n');
 }}]});
 let root;const button=t=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);const click=async t=>act(async()=>{assert.ok(button(t),t);button(t).click()});const input=async(el,value)=>act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new dom.window.Event('input',{bubbles:true}))});
 const mount=async()=>{if(root)await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));const {MemoryRouter}=globalThis.__keyRouter;const {ServiceKeysPage}=await server.ssrLoadModule('/src/pages/ServiceKeysPage.tsx');await act(async()=>root.render(React.createElement(MemoryRouter,{},React.createElement(ServiceKeysPage))));};
 try{
  await mount();await click('新建密钥');await input(document.querySelector('input[placeholder="例如 cherry-studio"]'),'desktop-client');await input(document.querySelector('input[aria-label="调用用途"]'),'summary');assert.ok(document.body.textContent.includes('不修改已有预算'));
  assert.equal(button('生成 API Key').disabled,false);await act(async()=>{button('生成 API Key').click();button('生成 API Key').click()});assert.equal(f.callerWrites.length,1);assert.equal(f.keyWrites.length,0);assert.equal(document.querySelector('fieldset').disabled,true);assert.ok(document.body.textContent.includes('调用身份登记结果未确认'));
  const caller={...f.callerWrites[0],id:'caller',status:'configured'};f.callers=[{...caller,teamId:'other-team'}];await click('核对本次步骤');assert.equal(document.querySelector('fieldset').disabled,true,'同码不同团队不能解锁');f.callers=[{...caller,requestType:'vision',id:'other-purpose'},caller];await click('核对本次步骤');assert.equal(document.querySelector('fieldset').disabled,false,'同码另一用途不能抢先，当精确用途和团队证实后才继续');f.callerResult={success:true,data:caller};
  await click('生成 API Key');assert.equal(f.callerWrites.length,2,'每次generate由权威端点裁决，不跳过已登记身份');assert.equal(f.keyWrites.length,1);assert.equal(document.querySelector('fieldset').disabled,true);assert.ok(document.body.textContent.includes('可能已生效'));assert.equal(document.querySelector('.lg-created-key'),null);await click('生成 API Key');assert.equal(f.keyWrites.length,1);
  f.keys=[key,{...key,id:'candidate',clientCode:f.keyWrites[0].clientCode,appCallerCodes:f.keyWrites[0].appCallerCodes}];await click('核对本次步骤');assert.ok(document.body.textContent.includes('不能确认哪把属于本次签发'));assert.equal(document.querySelector('fieldset').disabled,true);assert.equal(f.keyWrites.length,1);assert.equal(document.body.textContent.includes('gwk_secret'),false);
  f.callerResult={success:true,data:caller};f.keyResult={success:true,data:{...key,id:'new-key',key:'gwk_secret_fixture_only',warning:'once'}};await mount();await click('新建密钥');await input(document.querySelector('input[placeholder="例如 cherry-studio"]'),'desktop-client');await input(document.querySelector('input[aria-label="调用用途"]'),'summary');await click('生成 API Key');assert.ok(document.body.textContent.includes('gwk_secret_fixture_only'));const help=[...document.querySelectorAll('a')].find(a=>a.textContent==='查看已有密钥接入说明');assert.equal(help.getAttribute('href'),'/learn#existing-key');
  const callerCount=f.callerWrites.length;await mount();await click('新建密钥');await input(document.querySelector('input[placeholder="例如 cherry-studio"]'),'legacy-client');await click('选择已有调用用途');await input(document.querySelector('input[list="llmgw-app-callers"]'),'Legacy/InternalGeneration');assert.equal(button('生成 API Key').disabled,false);await click('生成 API Key');assert.equal(f.callerWrites.length,callerCount,'既有历史身份不套自助新码格式，也不重新登记');assert.deepEqual(f.keyWrites.at(-1).appCallerCodes,['Legacy/InternalGeneration']);
 }finally{if(root)await act(async()=>root.unmount());await server.close();dom.window.close();for(const n of names)globalThis[n]=old[n];delete globalThis.__keyFixture;delete globalThis.__keyRouter;delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});
