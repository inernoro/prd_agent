import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React,{act} from 'react';

test('账号与首登改密都保留未确认结果并由用户主动核实，明确成功语义不退化',async t=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/account'});const names=['window','document','HTMLElement','HTMLInputElement','Event','MouseEvent'];const previous=Object.fromEntries(names.map(name=>[name,globalThis[name]]));for(const name of names)globalThis[name]=dom.window[name];globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const router=await import('react-router-dom');globalThis.__passwordRouter={...router.default,...router};globalThis.__passwordOutcome={mode:'network',calls:0,logouts:0};
 const api=await readFile(new URL('../src/lib/api.ts',import.meta.url),'utf8');
 const server=await createServer({root:process.env.W2_TEST_ROOT||fileURLToPath(new URL('../',import.meta.url)),server:{middlewareMode:true},appType:'custom',logLevel:'silent',optimizeDeps:{noDiscovery:true},ssr:{noExternal:['react-router-dom']},plugins:[{name:'password-outcome',enforce:'pre',resolveId(id){if(id==='react-router-dom')return '\0password-router';},load(id){
  if(id==='\0password-router')return Object.keys(globalThis.__passwordRouter).filter(name=>name!=='default').map(name=>`export const ${name}=globalThis.__passwordRouter.${name};`).join('\n');
  if(id.endsWith('/src/lib/auth.tsx'))return 'export function useAuth(){return {user:{username:"fixture-user"},tenant:{role:"owner"},logout(){globalThis.__passwordOutcome.logouts++},async changePassword(payload){const f=globalThis.__passwordOutcome;f.calls++;f.submitted=payload;if(f.defer)await new Promise(resolve=>{f.resolve=resolve});if(f.mode==="throw")throw new Error("response body interrupted");if(f.mode==="relogin")return {success:true,data:{requiresRelogin:true}};if(f.mode==="rejected")return {success:false,error:{code:"INVALID_CREDENTIALS",message:"旧口令错误"}};return {success:false,error:{code:"NETWORK_ERROR",message:"Failed to fetch"}}}}}';
  if(id.endsWith('/src/lib/api.ts'))return [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(([,name])=>name==='getAccountProfile'?'export async function getAccountProfile(){return {success:true,data:{username:"fixture-user",identityProvider:"map",hasLocalPassword:false,requiresOldPassword:false,usernameIsGenerated:false,suggestedUsername:"fixture-user",minPasswordLength:12,tenant:{role:"owner",name:"产品团队"}}}}':`export async function ${name}(){return {success:true,data:{items:[]}}}`).join('\n');
 }}]});let root;
 try{const {createRoot}=await import('react-dom/client');const {AccountSecurityPage}=await server.ssrLoadModule('/src/pages/AccountSecurityPage.tsx');const {ChangePasswordPage}=await server.ssrLoadModule('/src/pages/ChangePasswordPage.tsx');
  for(const [name,Component] of [['账号',AccountSecurityPage],['首登',ChangePasswordPage]])for(const mode of ['network','throw','relogin','rejected'])await t.test(`${name} ${mode}`,async()=>{
   globalThis.__passwordOutcome={mode,calls:0,logouts:0};root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(globalThis.__passwordRouter.MemoryRouter,{},React.createElement(Component))));
   const inputs=[...document.querySelectorAll('input[type="password"]')];assert.equal(inputs.length,name==='账号'?2:3,'MAP账号无需拿MAP口令充当GW旧口令');
   const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;
   await act(async()=>{for(const [index,input] of inputs.entries()){setter.call(input,name==='首登'&&index===0?'old-fixture-54321':'fixture-only-12345');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}});
   const submit=()=>document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
   if(mode==='network')globalThis.__passwordOutcome.defer=true;
   await act(async()=>submit());
   if(mode==='network'){for(const input of inputs)assert.equal(input.matches(':disabled'),true,'submitted credentials are locked while request is pending');assert.equal(globalThis.__passwordOutcome.submitted.newPassword,'fixture-only-12345');await act(async()=>globalThis.__passwordOutcome.resolve());}
   if(mode==='rejected'){assert.match(document.body.textContent,/旧口令错误/);assert.doesNotMatch(document.body.textContent,/修改结果未确认/);}
   else if(mode==='relogin'){assert.match(document.body.textContent,/口令已修改成功/);if(name==='账号')assert.doesNotMatch(document.body.textContent,/现在只能从 MAP 进入/);assert.doesNotMatch(document.body.textContent,/修改结果未确认/);assert.equal(document.querySelector('button[type="submit"]').disabled,true);}
   else{assert.match(document.body.textContent,/修改结果未确认/);if(name==='账号'){assert.match(document.body.textContent,/更新待核实/);assert.doesNotMatch(document.body.textContent,/现在只能从 MAP 进入/);}assert.equal(document.querySelector('button[type="submit"]').disabled,true);await act(async()=>submit());assert.equal(globalThis.__passwordOutcome.calls,1,'unknown outcome never resubmits');assert.equal(globalThis.__passwordOutcome.logouts,0,'must not navigate away before user reads outcome');assert.equal(inputs.at(-1).value,'fixture-only-12345');const action=[...document.querySelectorAll('button')].find(node=>node.textContent==='重新登录核实');assert.ok(action);await act(async()=>action.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true})));assert.equal(globalThis.__passwordOutcome.logouts,1);}
   assert.equal(dom.window.location.search,'');assert.equal(dom.window.localStorage.length,0);assert.equal(dom.window.sessionStorage.length,0);await act(async()=>root.unmount());root=null;
  });
 }finally{if(root)await act(async()=>root.unmount());await server.close();dom.window.close();for(const name of names)globalThis[name]=previous[name];delete globalThis.IS_REACT_ACT_ENVIRONMENT;delete globalThis.__passwordOutcome;delete globalThis.__passwordRouter;}
});
