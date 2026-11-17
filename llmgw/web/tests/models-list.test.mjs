import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('弱型号身份落到可核实搜索结果；无匹配不伪空目录，关键词范围不能触发全量批维护', async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/models'});const names=['window','document','HTMLElement','HTMLInputElement','Event','MouseEvent'];const old=Object.fromEntries(names.map(n=>[n,globalThis[n]]));for(const n of names)globalThis[n]=dom.window[n];globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const router=await import('react-router-dom');globalThis.__modelListRouter={...router.default,...router};const f={queries:[],fail:false,role:'owner',writes:0};globalThis.__modelListFixture=f;
 const api=await readFile(new URL('../src/lib/api.ts',import.meta.url),'utf8');const exports=[...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(m=>m[1]);
 const server=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),server:{middlewareMode:true},appType:'custom',logLevel:'silent',optimizeDeps:{noDiscovery:true,include:[]},ssr:{noExternal:['react-router-dom']},plugins:[{name:'model-list-fixture',enforce:'pre',resolveId(id){if(id==='react-router-dom')return '\0model-list-router'},load(id){
  if(id==='\0model-list-router')return Object.keys(globalThis.__modelListRouter).filter(n=>n!=='default').map(n=>`export const ${n}=globalThis.__modelListRouter.${n};`).join('\n');
  if(id.endsWith('/src/lib/auth.tsx'))return 'export function useAuth(){return {tenant:{id:"tenant",role:globalThis.__modelListFixture.role}}}';
  if(id.endsWith('/src/components/ConfirmDialog.tsx'))return 'export function useDialogs(){return {confirm:async()=>true,promptText:async()=>null}}';
  if(id.endsWith('/src/lib/api.ts'))return exports.map(n=>{
   if(n==='getModels')return `export async function getModels(query){const f=globalThis.__modelListFixture;f.queries.push(query);if(f.fail)throw new Error('body interrupted');return {success:true,data:{items:query.enabled?[]:[{id:'m0',name:'对话业务',modelName:'shared-wire-id',platformId:'p0',enabled:true,authority:'llm_gateway',capabilities:[]},{id:'m1',name:'另一个型号',modelName:'other-wire',platformId:'p0',enabled:false,authority:'llm_gateway',capabilities:[]}]}}}`;
   if(n==='getPlatforms')return `export async function getPlatforms(){return {success:true,data:{items:[{id:'p0',name:'供应方甲',enabled:true,authority:'llm_gateway'}]}}}`;
   if(n==='getParameterCapabilitiesMeta')return `export async function getParameterCapabilitiesMeta(){return {success:true,data:{templates:[]}}}`;
   if(n==='bulkRotateApiKeys'||n==='bulkUpdateModelCapabilities')return `export async function ${n}(){globalThis.__modelListFixture.writes++;return {success:true,data:{}}}`;
   return `export async function ${n}(){return {success:true,data:{items:[]}}}`;
  }).join('\n');
 }}]});let root;
 try{const {createRoot}=await import('react-dom/client');const {ModelsPage}=await server.ssrLoadModule('/src/pages/ModelsPage.tsx');const mount=async(url)=>{if(root)await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(globalThis.__modelListRouter.MemoryRouter,{initialEntries:[url]},React.createElement(ModelsPage))))};const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);const type=async(value)=>act(async()=>{const input=document.querySelector('input[aria-label="搜索上游模型"]');Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}))});
 await mount('/models?search=shared-wire-id');assert.equal(document.querySelector('h1').textContent,'上游模型');assert.equal(document.querySelectorAll('.lg-upstream-model-row').length,1);assert.ok(document.querySelector('.lg-upstream-model-row').textContent.includes('对话业务'));assert.ok(document.body.textContent.includes('1 / 2 个模型'));assert.equal(document.querySelector('[role="dialog"]'),null,'弱wire名称只搜索候选，不自动打开可能同名的公开模型');assert.equal(f.queries[0].search,undefined);
 assert.equal(button('批量轮换密钥').disabled,true);assert.equal(button('批量维护能力').disabled,true);await act(async()=>button('批量轮换密钥').click());assert.equal(f.writes,0);await type('没有匹配');assert.ok(document.body.textContent.includes('没有匹配的上游模型。'));assert.equal(document.body.textContent.includes('当前租户还没有模型'),false);await act(async()=>button('清除搜索与筛选').click());assert.equal(document.querySelectorAll('.lg-upstream-model-row').length,2);assert.equal(button('批量轮换密钥').disabled,false);
 const enabled=[...document.querySelectorAll('label')].find(x=>x.textContent.trim()==='仅启用').querySelector('input');await act(async()=>enabled.click());assert.ok(document.body.textContent.includes('没有匹配的上游模型。'));assert.equal(document.body.textContent.includes('还没有模型。'),false);await act(async()=>button('清除搜索与筛选').click());assert.equal(document.querySelectorAll('.lg-upstream-model-row').length,2);
 f.fail=true;await mount('/models?search=shared-wire-id');assert.ok(document.body.textContent.includes('读取中断'));f.fail=false;await act(async()=>button('重新读取型号').click());assert.equal(document.querySelector('input[aria-label="搜索上游模型"]').value,'shared-wire-id');assert.equal(document.querySelectorAll('.lg-upstream-model-row').length,1);
 }finally{if(root)await act(async()=>root.unmount());await server.close();dom.window.close();for(const n of names)globalThis[n]=old[n];delete globalThis.__modelListFixture;delete globalThis.__modelListRouter;delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});
