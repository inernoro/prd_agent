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
 const f={auth:{tenant:{id:'tenant',role:'owner',teamIds:['team']},user:{username:'owner-a'}},confirm:true,confirmations:[],revokes:[],callers:[],keys:[key],callerWrites:[],keyWrites:[],callerResult:{success:false,error:{code:'UNRECOGNISED_ERROR',message:'body lost'}}};globalThis.__keyFixture=f;
 // Optional frozen production source for the same-script state counterexample.
 const counterfactual=process.env.SERVICE_KEYS_COUNTERFACTUAL_SOURCE ? await readFile(process.env.SERVICE_KEYS_COUNTERFACTUAL_SOURCE,'utf8') : null;
 const api=await readFile(new URL('../src/lib/api.ts',import.meta.url),'utf8');const exports=[...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(m=>m[1]);
 const server=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),server:{middlewareMode:true},appType:'custom',logLevel:'silent',optimizeDeps:{noDiscovery:true,include:[]},ssr:{noExternal:['react-router-dom']},plugins:[{name:'key-issue-fixture',enforce:'pre',resolveId(id){if(id==='react-router-dom')return '\0key-router'},load(id){
  if(counterfactual && id.endsWith('/src/pages/ServiceKeysPage.tsx'))return counterfactual;
  if(id==='\0key-router')return Object.keys(globalThis.__keyRouter).filter(n=>n!=='default').map(n=>`export const ${n}=globalThis.__keyRouter.${n};`).join('\n');
  if(id.endsWith('/src/lib/auth.tsx'))return 'export function useAuth(){return globalThis.__keyFixture.auth}';
  if(id.endsWith('/src/components/ConfirmDialog.tsx'))return 'export function useDialogs(){return {confirm:async options=>{const f=globalThis.__keyFixture;f.confirmations.push(options);return f.confirm},alert:async()=>{}}}';
  if(id.endsWith('/src/lib/api.ts'))return exports.map(n=>{
   if(n==='getGatewayAppCallers')return 'export async function getGatewayAppCallers(){return {success:true,data:{items:globalThis.__keyFixture.callers,total:globalThis.__keyFixture.callers.length}}}';
   if(n==='getServiceKeys')return 'export async function getServiceKeys(){const f=globalThis.__keyFixture;if(f.read) return f.read();return {success:true,data:f.keys}}';
   if(n==='revokeServiceKey')return 'export async function revokeServiceKey(id){const f=globalThis.__keyFixture;f.revokes.push(id);return f.revokeResult??{success:true,data:{id,revoked:true}}}';
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
  const candidate={...key,...f.keyWrites[0],id:'candidate',keyPrefix:'gwk_candidate'};f.keys=[key,candidate];await click('核对本次步骤');assert.ok(document.body.textContent.includes('不能确认哪把属于本次签发'));assert.equal(document.querySelector('fieldset').disabled,true);assert.equal(f.keyWrites.length,1);assert.equal(document.body.textContent.includes('gwk_secret'),false);
  const candidateRevoke=()=>[...document.querySelectorAll('[data-creation-candidate-revoke]')].find(el=>el.getAttribute('data-creation-candidate-revoke')==='candidate');
  assert.ok(candidateRevoke(),'成功读取候选后须有精确ID的撤销恢复入口');assert.equal(candidateRevoke().disabled,false,'未知签发不能封死已核候选撤销');
  assert.deepEqual([...new Set([...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='撤销'&&!b.disabled).map(b=>b.getAttribute('data-creation-candidate-revoke')))],['candidate'],'不能将其他key当候选开放');
  f.confirm=false;const confirmationsBefore=f.confirmations.length;await act(async()=>{candidateRevoke().click();candidateRevoke().click()});assert.equal(f.confirmations.length,confirmationsBefore+1,'确认期间也防双触发');assert.equal(f.revokes.length,0,'取消确认不得写');f.confirm=true;
  f.read=async()=>({success:false,error:{code:'NETWORK_ERROR',message:'read lost'}});await click('核对本次步骤');assert.equal(candidateRevoke()?.disabled===false,false,'读取失败立即撤回候选授权');delete f.read;
  f.keys=[key,{...candidate,teamId:'other-team'},{...candidate,id:'wrong-scope',scopes:['admin']}];await click('核对本次步骤');assert.equal(candidateRevoke()?.disabled===false,false,'不同team/scope不是候选');
  f.keys=[key,candidate];await click('核对本次步骤');f.read=async()=>{throw new Error('candidate preflight read interrupted')};await act(async()=>candidateRevoke().click());assert.equal(f.revokes.length,0,'确认后只读复核失败不得DELETE');assert.ok(document.body.textContent.includes('候选读取中断，未撤销'));assert.equal(document.querySelector('[data-lifecycle-summary]'),null,'未发DELETE不能冒充撤销结果未知');delete f.read;
  f.keys=[key,candidate];await click('核对本次步骤');f.revokeResult={success:false,error:{code:'SERVICE_KEY_ISSUANCE_PENDING',message:'签发尚未完成，拒绝撤销'}};
  await act(async()=>candidateRevoke().click());assert.deepEqual(f.revokes,['candidate']);assert.ok(document.body.textContent.includes('签发尚未完成，拒绝撤销'));assert.equal(document.querySelector('fieldset').disabled,true);assert.equal(f.keyWrites.length,1);
  f.keys=[key,{...candidate,rotationState:'awaiting-client-cutover'}];await act(async()=>candidateRevoke().click());assert.equal(f.revokes.length,1);assert.ok(document.body.textContent.includes('候选状态已变化'));
  f.keys=[key,candidate];await click('核对本次步骤');f.revokeResult={success:false,error:{code:'NETWORK_ERROR',message:'delete response lost'}};
  await act(async()=>candidateRevoke().click());assert.deepEqual(f.revokes,['candidate','candidate']);assert.ok(document.body.textContent.includes('撤销结果未确认'));assert.equal(document.querySelector('fieldset').disabled,true);assert.equal(f.keyWrites.length,1);
  f.keys=[key,{...candidate,enabled:false,rotationState:'revoked'}];await click('读取相关密钥状态');assert.equal(document.querySelector('[data-lifecycle-summary]'),null);assert.ok(document.body.textContent.includes('密钥签发结果未确认'));assert.equal(document.querySelector('fieldset').disabled,true);assert.equal(f.keyWrites.length,1);assert.equal(document.body.textContent.includes('gwk_secret'),false);
  f.keys=[key,candidate];await click('核对本次步骤');f.revokeResult={success:true,data:{id:'candidate',revoked:true}};
  await act(async()=>candidateRevoke().click());assert.equal(f.revokes.length,3);assert.equal(document.querySelector('fieldset').disabled,true);assert.equal(f.keyWrites.length,1);assert.ok(f.confirmations.at(-1).description.includes('不能证明它属于本次签发'));assert.ok(f.confirmations.at(-1).description.includes('candidate'));
  f.confirm=false;await click('结束核对并重新准备');assert.equal(document.querySelector('fieldset').disabled,true,'未确认结束不解除原任务');
  f.confirm=true;await click('结束核对并重新准备');assert.equal(document.querySelector('fieldset').disabled,false);assert.equal(document.querySelector('input[placeholder="例如 cherry-studio"]').value,'');assert.equal(document.querySelector('input[aria-label="调用用途"]').value,'');assert.equal(f.keyWrites.length,1,'明确新意图只清空，不重放POST');assert.ok(document.body.textContent.includes('原签发仍可能有效'));assert.ok(f.confirmations.at(-1).description.includes('稍后出现有效密钥'));
  await input(document.querySelector('input[placeholder="例如 cherry-studio"]'),'second-client');await input(document.querySelector('input[aria-label="调用用途"]'),'summary');await click('生成 API Key');assert.equal(f.keyWrites.length,2);
  const writesBeforeAccountChange=f.keyWrites.length;
  let delayed;f.read=()=>new Promise(resolve=>{delayed=resolve});await act(async()=>button('核对本次步骤').click());
  delete f.read;f.keys=[];f.auth={...f.auth,user:{username:'owner-b'}};const {MemoryRouter}=globalThis.__keyRouter;const {ServiceKeysPage}=await server.ssrLoadModule('/src/pages/ServiceKeysPage.tsx');await act(async()=>root.render(React.createElement(MemoryRouter,{},React.createElement(ServiceKeysPage))));
  await act(async()=>delayed({success:true,data:[key,candidate]}));assert.equal(candidateRevoke()?.disabled===false,false,'换账号后旧读取不能授权撤销');assert.equal(f.keyWrites.length,writesBeforeAccountChange);assert.equal(f.revokes.length,3);assert.equal(document.body.textContent.includes('gwk_candidate'),false,'旧账号候选不得回填新账号清单');delete f.read;
  f.callerResult={success:true,data:caller};f.keyResult={success:true,data:{...key,id:'new-key',key:'gwk_secret_fixture_only',warning:'once'}};await mount();await click('新建密钥');await input(document.querySelector('input[placeholder="例如 cherry-studio"]'),'desktop-client');await input(document.querySelector('input[aria-label="调用用途"]'),'summary');await click('生成 API Key');assert.ok(document.body.textContent.includes('gwk_secret_fixture_only'));const help=[...document.querySelectorAll('a')].find(a=>a.textContent==='查看已有密钥接入说明');assert.equal(help.getAttribute('href'),'/learn#existing-key');
  const callerCount=f.callerWrites.length;await mount();await click('新建密钥');await input(document.querySelector('input[placeholder="例如 cherry-studio"]'),'legacy-client');await click('选择已有调用用途');await input(document.querySelector('input[list="llmgw-app-callers"]'),'Legacy/InternalGeneration');assert.equal(button('生成 API Key').disabled,false);await click('生成 API Key');assert.equal(f.callerWrites.length,callerCount,'既有历史身份不套自助新码格式，也不重新登记');assert.deepEqual(f.keyWrites.at(-1).appCallerCodes,['Legacy/InternalGeneration']);
 }finally{if(root)await act(async()=>root.unmount());await server.close();dom.window.close();for(const n of names)globalThis[n]=old[n];delete globalThis.__keyFixture;delete globalThis.__keyRouter;delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});
