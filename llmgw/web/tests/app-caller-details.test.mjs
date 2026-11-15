import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('同码不同用途从实体到治理保持身份；缺失id和读取失败不回退或伪装未登记', async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/app-callers/view'});
 const names=['window','document','HTMLElement','HTMLInputElement','Event','MouseEvent'];const old=Object.fromEntries(names.map(n=>[n,globalThis[n]]));for(const n of names)globalThis[n]=dom.window[n];globalThis.IS_REACT_ACT_ENVIRONMENT=true;dom.window.HTMLElement.prototype.scrollTo=()=>{};
 const router=await import('react-router-dom');globalThis.__identityRouter={...router.default,...router};const {createRoot}=await import('react-dom/client');
 const caller={id:'chat',title:'文字摘要',appCallerCode:'same.identity',requestType:'chat',sourceSystem:'external',status:'discovered',totalSeen:62,observedIngressProtocols:[],allowedModelPoolIds:[]};
 const f={items:[{...caller,id:'vision',title:'图片摘要',requestType:'vision'},caller],queries:[],logQueries:[],fail:false};globalThis.__identityFixture=f;
 const api=await readFile(new URL('../src/lib/api.ts',import.meta.url),'utf8');const exports=[...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(m=>m[1]);
 const server=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),server:{middlewareMode:true},appType:'custom',logLevel:'silent',optimizeDeps:{noDiscovery:true,include:[]},ssr:{noExternal:['react-router-dom']},plugins:[{name:'caller-identity-fixture',enforce:'pre',resolveId(id){if(id==='react-router-dom')return '\0identity-router'},load(id){
  if(id==='\0identity-router')return Object.keys(globalThis.__identityRouter).filter(n=>n!=='default').map(n=>`export const ${n}=globalThis.__identityRouter.${n};`).join('\n');
  if(id.endsWith('/src/lib/auth.tsx'))return 'export function useAuth(){return {tenant:{id:"tenant",role:"viewer",teamIds:["team"]}}}';
  if(id.endsWith('/src/components/ConfirmDialog.tsx'))return 'export function useDialogs(){return {confirm:async()=>false,alert:async()=>{}}}';
  if(id.endsWith('/src/lib/api.ts'))return exports.map(n=>{
   if(n==='getGatewayAppCallers')return 'export async function getGatewayAppCallers(query){const f=globalThis.__identityFixture;f.queries.push(query);if(f.fail)throw new Error("body interrupted");const items=query.id?f.items.filter(x=>x.id===query.id):f.items;return {success:true,data:{items,total:items.length,page:1,pageSize:200,statuses:[],sourceSystems:[],ingressProtocols:[],requestTypes:[]}}}';
   if(n==='getModels')return 'export async function getModels(){return {success:true,data:{items:[{id:"m0",modelName:"upstream-chat",name:"业务对话型号",platformId:"p0",enabled:true,authority:"llm_gateway",capabilities:[]}]}}}';
   if(n==='getPlatforms')return 'export async function getPlatforms(){return {success:true,data:{items:[{id:"p1",name:"另一供应方",platformType:"openai",enabled:true,hasKey:true,authority:"llm_gateway"},{id:"p0",name:"原供应方",platformType:"openai",enabled:true,hasKey:true,authority:"llm_gateway"}]}}}';
   if(n==='getLogs')return 'export async function getLogs(query){globalThis.__identityFixture.logQueries.push(query);if(globalThis.__identityFixture.logsFail)throw new Error("logs interrupted");return {success:true,data:{items:[{id:"log-vision",appCallerCode:"same.identity",requestType:"vision",status:"succeeded",startedAt:"2026-11-15T10:00:00Z",model:"图片请求"},{id:"log-chat",appCallerCode:"same.identity",requestType:"chat",status:"succeeded",startedAt:"2026-11-15T10:00:00Z",model:"文字请求"}],total:2}}}';
   return `export async function ${n}(){return {success:true,data:{items:[]}}}`;
  }).join('\n');
 }}]});
 let root;const {MemoryRouter}=globalThis.__identityRouter;
 const mount=async(Component,url)=>{if(root)await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(MemoryRouter,{initialEntries:[url]},React.createElement(Component))))};
 const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
 try{
  const {AppCallerDetailsPage}=await server.ssrLoadModule('/src/pages/EntityDetailsPages.tsx');
  await mount(AppCallerDetailsPage,'/app-callers/view?code=same.identity&requestType=chat');
  assert.equal(document.querySelector('h1').textContent,'文字摘要');assert.ok(document.body.textContent.includes('允许调用'));assert.equal(document.body.textContent.includes('待配置'),false);
  assert.equal(f.logQueries.at(-1).requestType,'chat');assert.equal(document.querySelector('#activity').textContent.includes('图片请求'),false);assert.ok(document.querySelector('#activity').textContent.includes('文字请求'));
  const govern=[...document.querySelectorAll('a')].find(a=>a.textContent==='查看调用方治理');const href=govern.getAttribute('href');assert.equal(new URL(govern.href).searchParams.get('focusType'),'chat');
  const originalContext=new URLSearchParams({source:'logs',range:'7d',from:'2026-11-08T00:00:00Z',to:'2026-11-15T00:00:00Z',status:'failed',clientCode:'business-client',selectedLogId:'record-chat',untrusted:'https://example.invalid'});
  await mount(AppCallerDetailsPage,'/app-callers/view?code=same.identity&requestType=chat&context='+encodeURIComponent(originalContext.toString()));
  const logBack=[...document.querySelectorAll('a')].find(a=>a.textContent==='返回请求记录');const restored=new URL(logBack.href);assert.equal(restored.searchParams.get('status'),'failed');assert.equal(restored.searchParams.get('anchor'),'record-chat');assert.equal(restored.searchParams.get('from'),'2026-11-08T00:00:00Z');assert.equal(restored.searchParams.get('clientCode'),'business-client');assert.equal(restored.searchParams.has('requestType'),false,'实体chat用途不能冒充原Logs筛选');assert.equal(restored.searchParams.has('untrusted'),false);
  const {AppCallersPage}=await server.ssrLoadModule('/src/pages/AppCallersPage.tsx');await mount(AppCallersPage,href);const row=document.querySelector('.lg-app-caller-expanded-row').previousElementSibling;assert.ok(row.textContent.includes('文字摘要'));assert.equal(row.textContent.includes('图片摘要'),false);
  const reads=f.logQueries.length;await mount(AppCallerDetailsPage,'/app-callers/view?id=missing&code=same.identity&requestType=chat');assert.ok(document.body.textContent.includes('未改用同名对象'));assert.equal(f.logQueries.length,reads,'id没找到不能拿同code日志拼另一个对象');assert.equal(f.queries.at(-1).id,'missing');
  await mount(AppCallerDetailsPage,'/app-callers/view?id=chat&code=same.identity&requestType=vision');assert.equal(document.querySelector('h1').textContent,'文字摘要','id权威，不被先返回的同code vision抢先');
  await mount(AppCallerDetailsPage,'/app-callers/view?code=same.identity');assert.equal(document.querySelector('h1').textContent,'选择要查看的调用方用途');assert.ok(document.body.textContent.includes('文字摘要'));assert.ok(document.body.textContent.includes('图片摘要'));assert.ok([...document.querySelectorAll('a')].some(a=>a.href.includes('id=chat')&&a.href.includes('requestType=chat')));
  f.fail=true;await mount(AppCallerDetailsPage,'/app-callers/view?code=same.identity&requestType=chat');assert.ok(document.body.textContent.includes('读取中断'));assert.equal(document.body.textContent.includes('仅日志观测'),false);f.fail=false;await act(async()=>button('重新读取').click());assert.equal(document.querySelector('h1').textContent,'文字摘要');
  f.logsFail=true;await mount(AppCallerDetailsPage,'/app-callers/view?code=same.identity&requestType=chat');assert.ok(document.body.textContent.includes('最近请求读取中断'));assert.equal(document.body.textContent.includes('最近30天没有'),false);f.logsFail=false;await act(async()=>button('重新读取').click());assert.ok(document.querySelector('#activity').textContent.includes('文字请求'));
  f.items=[];await mount(AppCallerDetailsPage,'/app-callers/view?code=same.identity&requestType=chat');assert.ok(document.body.textContent.includes('仅日志观测'));const observedCount=[...document.querySelectorAll('.lg-entity-detail-metrics article')].find(x=>x.textContent.includes('已载入记录'));assert.equal(observedCount.querySelector('strong').textContent,'1');assert.ok(observedCount.textContent.includes('最多8条'),'载入样本不能冒充窗口总数');assert.equal(document.querySelector('#identity').textContent.includes('runtime'),false,'不能从请求日志猜内部凭据用途');
  const {PlatformsPage}=await server.ssrLoadModule('/src/pages/PlatformsPage.tsx');await mount(PlatformsPage,'/platforms?view=provider&providerId=p0');const providerPane=document.querySelector('.lg-collection-pane');assert.ok(providerPane.textContent.includes('原供应方'));const modelHref=document.querySelector('.lg-collection-owned-table a').getAttribute('href');assert.equal(new URL(modelHref,'https://preview.test').searchParams.get('returnKind'),'upstream-provider');
  const {ModelDetailsPage}=await server.ssrLoadModule('/src/pages/EntityDetailsPages.tsx');await mount(ModelDetailsPage,modelHref);const providerBack=[...document.querySelectorAll('a')].find(a=>a.textContent.includes('返回已接入模型'));assert.ok(providerBack);assert.equal(new URL(providerBack.href).searchParams.get('providerId'),'p0');await mount(PlatformsPage,providerBack.getAttribute('href'));assert.ok(document.querySelector('.lg-collection-pane').textContent.includes('原供应方'));assert.ok(document.querySelector('.lg-collection-owned-table'),'返回后承接同一个供应方的已接入模型面板');
 }finally{if(root)await act(async()=>root.unmount());await server.close();dom.window.close();for(const n of names)globalThis[n]=old[n];delete globalThis.__identityFixture;delete globalThis.__identityRouter;delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});
