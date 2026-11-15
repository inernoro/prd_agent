import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('提示词草稿预览、读取恢复、冲突与网络未知结果保留同一调用方上下文', async () => {
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/app-callers/a0/prompt-policy'});
 const names=['window','document','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Event','MouseEvent'];
 const old=Object.fromEntries(names.map(name=>[name,globalThis[name]]));for(const name of names)globalThis[name]=dom.window[name];
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const router=await import('react-router-dom');globalThis.__promptRouter={...router.default,...router};
 const {createRoot}=await import('react-dom/client');
 const current={id:'p1',appCallerCode:'app.summary::chat',requestType:'chat',version:1,systemPromptPrefix:'固定前缀',systemPromptSuffix:'',enabled:true,allowedVariables:[],maxChars:8000,policyHash:'hash-v1',policyChars:4};
 const f={readFailure:true,saveMode:'conflict',saved:[],deferred:false,data:{appCallerId:'a0',appCallerCode:current.appCallerCode,requestType:'chat',current,versions:[current]}};globalThis.__promptFixture=f;
 const api=await readFile(new URL('../src/lib/api.ts',import.meta.url),'utf8');const apiNames=[...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(m=>m[1]);
 const server=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),server:{middlewareMode:true},appType:'custom',logLevel:'silent',optimizeDeps:{noDiscovery:true,include:[]},ssr:{noExternal:['react-router-dom']},plugins:[{name:'prompt-state-fixture',enforce:'pre',resolveId(id){if(id==='react-router-dom')return '\0prompt-router'},load(id){
  if(id==='\0prompt-router')return Object.keys(globalThis.__promptRouter).filter(name=>name!=='default').map(name=>`export const ${name}=globalThis.__promptRouter.${name};`).join('\n');
  if(id.endsWith('/src/lib/auth.tsx'))return 'export function useAuth(){return {tenant:{id:"tenant",role:"owner",teamIds:["team"]}}}';
  if(id.endsWith('/src/components/ConfirmDialog.tsx'))return 'export function useDialogs(){return {confirm:async()=>false}}';
  if(id.endsWith('/src/lib/api.ts'))return apiNames.map(name=>{
   if(name==='getPromptPolicy')return 'export async function getPromptPolicy(){const f=globalThis.__promptFixture;if(f.readFailure)throw new Error("body interrupted");return {success:true,data:structuredClone(f.data)}}';
   if(name==='previewPromptPolicy')return 'export async function previewPromptPolicy(id,body){const f=globalThis.__promptFixture;const result={success:true,data:{mergedSystemPrompt:"预览："+body.systemPromptPrefix+body.sampleSystemPrompt,policyChars:body.systemPromptPrefix.length,mergedChars:20,policyHash:"preview-hash",appliedVariables:[]}};if(f.deferred)return new Promise(resolve=>f.resolvePreview=()=>resolve(result));return result}';
   if(name==='savePromptPolicy')return 'export async function savePromptPolicy(id,body){const f=globalThis.__promptFixture;f.saved.push({id,body});if(f.saveMode==="conflict")return {success:false,error:{code:"PROMPT_POLICY_VERSION_CONFLICT",message:"当前版本为 2"}};if(f.saveMode==="unknown")return {success:false,error:{code:f.unknownCode||"NETWORK_ERROR",message:"保存响应丢失"}};f.data.current={...f.data.current,...body,id:"p"+(f.data.current.version+1),version:f.data.current.version+1,policyHash:"saved-hash"};f.data.versions.push(f.data.current);return {success:true,data:structuredClone(f.data.current)}}';
   return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
  }).join('\n');
 }}]});
 let root;const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
 const click=async text=>{assert.ok(button(text),text);await act(async()=>button(text).click());};
 const field=text=>[...document.querySelectorAll('label')].find(label=>label.textContent.startsWith(text)).querySelector('textarea');
 const type=async(element,value)=>act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set.call(element,value);element.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
 try{
  const {PromptPolicyPage}=await server.ssrLoadModule('/src/pages/PromptPolicyPage.tsx');const {MemoryRouter,Routes,Route}=globalThis.__promptRouter;
  root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(MemoryRouter,{initialEntries:['/app-callers/a0/prompt-policy?callerReturn=search%3Dsummary%26page%3D2']},React.createElement(Routes,{},React.createElement(Route,{path:'/app-callers/:id/prompt-policy',element:React.createElement(PromptPolicyPage)})))));
  assert.ok(document.body.textContent.includes('读取失败'));f.readFailure=false;await click('重新读取');
  assert.equal(field('固定开场要求').value,'固定前缀');
  await click('预览');assert.ok(document.querySelector('pre').textContent.includes('预览：固定前缀'));
  await type(field('固定开场要求'),'新草稿');assert.equal(document.querySelector('pre'),null,'编辑草稿后旧预览不可继续冒充当前输入');
  f.deferred=true;await click('预览');await type(field('示例请求'),'新示例');await act(async()=>f.resolvePreview());assert.equal(document.querySelector('pre'),null,'在途旧响应也不能恢复陈旧预览');
  await click('保存新版本');assert.equal(f.saved[0].body.expectedVersion,1);assert.equal(field('固定开场要求').value,'新草稿');assert.equal(button('保存新版本').disabled,true);assert.ok(button('丢弃本地草稿并读取最新'));
  f.deferred=false;await click('预览');assert.ok(button('丢弃本地草稿并读取最新'),'预览不能隐藏冲突恢复动作');
  f.data.current={...f.data.current,version:2,systemPromptPrefix:'其他管理员版本'};await click('丢弃本地草稿并读取最新');assert.equal(field('固定开场要求').value,'其他管理员版本');
  await type(field('固定开场要求'),'网络未知草稿');f.saveMode='unknown';f.unknownCode='GATEWAY_TIMEOUT';await click('保存新版本');assert.equal(field('固定开场要求').value,'网络未知草稿');assert.ok(document.body.textContent.includes('可能已生效；本地草稿已保留'),'未知Envelope必须直接解释未确认结果');assert.ok(document.body.textContent.includes('上次读取'));assert.ok(document.body.textContent.includes('当前待核'));assert.equal(button('保存新版本').disabled,true);const count=f.saved.length;await click('预览');assert.ok(button('核对服务端版本（保留草稿）'),'预览不能让未知保存状态失去核对入口');await act(async()=>{button('保存新版本').disabled=false;button('保存新版本').click()});assert.equal(f.saved.length,count,'即使DOM disabled被绕过，handler仍不可重复未知写入');
  await click('核对服务端版本（保留草稿）');assert.equal(field('固定开场要求').value,'网络未知草稿');assert.equal(button('保存新版本').disabled,false,'同版本核对后仍由原expectedVersion CAS保护下一次保存');
  f.saveMode='ok';await click('保存新版本');assert.ok(document.body.textContent.includes('已保存版本 v3'));assert.equal(field('固定开场要求').value,'网络未知草稿');assert.equal(document.body.textContent.includes('有未保存更改'),false);
  const back=[...document.querySelectorAll('a')].find(a=>a.textContent.includes('返回调用方'));const url=new URL(back.href);assert.equal(url.searchParams.get('focusType'),'chat');assert.equal(url.searchParams.get('search'),'summary');assert.equal(url.searchParams.get('page'),'2');
  await act(async()=>root.unmount());f.data.current=null;f.data.versions=[];f.saveMode='conflict';root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(MemoryRouter,{initialEntries:['/app-callers/a0/prompt-policy']},React.createElement(Routes,{},React.createElement(Route,{path:'/app-callers/:id/prompt-policy',element:React.createElement(PromptPolicyPage)})))));await type(field('固定开场要求'),'首次本地草稿');await click('保存新版本');assert.equal(f.saved.at(-1).body.expectedVersion,0);assert.ok(document.body.textContent.includes('上次读取：尚未创建 · 当前待核'),'首次创建409不能仍断言尚未创建');assert.equal(field('固定开场要求').value,'首次本地草稿');
 }finally{if(root)await act(async()=>root.unmount());await server.close();dom.window.close();for(const name of names)globalThis[name]=old[name];delete globalThis.__promptFixture;delete globalThis.__promptRouter;delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});
