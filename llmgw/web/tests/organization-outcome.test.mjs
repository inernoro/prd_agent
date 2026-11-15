import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
import React,{act} from 'react';

test('团队提交锁住原输入；陌生错误/成员移出响应中断先核对，未知时不重复写',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/organization'});const names=['window','document','HTMLElement','HTMLInputElement','Event','MouseEvent'];const previous=Object.fromEntries(names.map(name=>[name,globalThis[name]]));for(const name of names)globalThis[name]=dom.window[name];globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const router=await import('react-router-dom');globalThis.__organizationRouter={...router.default,...router};globalThis.__organizationOutcome={calls:[],data:{tenant:{id:'t',name:'产品团队',slug:'product'},teams:[],members:[{id:'target',version:1,userId:'target-user',username:'developer',displayName:'应用开发者',role:'developer',teamIds:[],status:'active'}]}};
 const api=await readFile(new URL('../src/lib/api.ts',import.meta.url),'utf8');const server=await createServer({root:process.env.W2_TEST_ROOT||fileURLToPath(new URL('../',import.meta.url)),server:{middlewareMode:true},appType:'custom',logLevel:'silent',optimizeDeps:{noDiscovery:true},ssr:{noExternal:['react-router-dom']},plugins:[{name:'organization-outcome',enforce:'pre',resolveId(id){if(id==='react-router-dom')return '\0org-router';},load(id){
 if(id==='\0org-router')return Object.keys(globalThis.__organizationRouter).filter(name=>name!=='default').map(name=>`export const ${name}=globalThis.__organizationRouter.${name};`).join('\n');
 if(id.endsWith('/src/lib/auth.tsx'))return 'export function useAuth(){return {tenant:{id:"t",role:"owner"},user:{username:"owner"},logout(){}}}';
 if(id.endsWith('/src/components/ConfirmDialog.tsx'))return 'export function useDialogs(){return {confirm:async()=>true,promptText:async()=>"developer"}}';
 if(id.endsWith('/src/lib/api.ts'))return [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(([,name])=>{
  if(name==='getOrganization')return 'export async function getOrganization(){return {success:true,data:JSON.parse(JSON.stringify(globalThis.__organizationOutcome.data))}}';
  if(name==='createTeam')return 'export async function createTeam(payload){const f=globalThis.__organizationOutcome;f.calls.push({op:"createTeam",payload});f.data.teams.push({id:"new-team",name:payload.name,status:"active"});await new Promise(resolve=>{f.resolve=resolve});return {success:false,error:{code:"UNRECOGNIZED_NEW_ERROR",message:"response unconfirmed"}}}';
  if(name==='deleteMember')return 'export async function deleteMember(id){const f=globalThis.__organizationOutcome;f.calls.push({op:"deleteMember",id});f.data.members=f.data.members.filter(member=>member.id!==id);throw new Error("response body interrupted")}';
  return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
 }).join('\n');
 }}]});let root;
 try{const {createRoot}=await import('react-dom/client');const {OrganizationPage}=await server.ssrLoadModule('/src/pages/OrganizationPage.tsx');root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(globalThis.__organizationRouter.MemoryRouter,{},React.createElement(OrganizationPage))));
 const click=async node=>{assert.ok(node);await act(async()=>node.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true})));};const button=name=>[...document.querySelectorAll('button')].find(node=>node.textContent===name);
 const input=document.querySelector('input[placeholder="客服组"]');const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;await act(async()=>{setter.call(input,'团队A');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});await click(button('创建团队'));
 assert.equal(input.matches(':disabled'),true,'submitted A cannot turn into another draft while request is pending');assert.equal(input.value,'团队A');await act(async()=>globalThis.__organizationOutcome.resolve());
 assert.match(document.body.textContent,/创建团队结果未确认/);assert.equal(button('创建团队').disabled,true);await click(button('创建团队'));assert.equal(globalThis.__organizationOutcome.calls.length,1,'unfamiliar errors remain unknown rather than definite rejection');assert.equal(input.value,'团队A');
 await click(button('刷新'));assert.ok(document.querySelector('[aria-label="重命名团队 团队A"]'),'read reconciliation shows the actual created record');assert.equal(button('创建团队').disabled,false);
 await click([...document.querySelector('[data-testid="member-row-target"]').querySelectorAll('button')].find(node=>node.textContent==='移出'));
 assert.match(document.body.textContent,/移出成员结果未确认/);assert.equal(document.querySelector('[data-member-primary]').disabled,true);assert.ok(document.querySelector('[data-testid="member-row-target"]'),'last-read snapshot remains explicitly identified until reconciliation');await click(button('刷新'));assert.equal(document.querySelector('[data-testid="member-row-target"]'),null);assert.equal(globalThis.__organizationOutcome.calls.length,2,'reconciliation does not repeat either write');
 }finally{if(root)await act(async()=>root.unmount());await server.close();dom.window.close();for(const name of names)globalThis[name]=previous[name];delete globalThis.IS_REACT_ACT_ENVIRONMENT;delete globalThis.__organizationOutcome;delete globalThis.__organizationRouter;}
});
