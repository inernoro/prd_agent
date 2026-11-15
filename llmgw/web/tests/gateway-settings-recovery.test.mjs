import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('系统模型选择可预测影响，旧测试失效；未知保存先核对，保存途中编辑保留草稿', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/gateway-settings' });
  const names = ['window','document','HTMLElement','HTMLInputElement','Event','MouseEvent']; const previous=Object.fromEntries(names.map(name=>[name,globalThis[name]])); for(const name of names)globalThis[name]=dom.window[name]; globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const router=await import('react-router-dom'); globalThis.__systemRouter={...router.default,...router};
  globalThis.__systemSettings={writes:[],tests:0,lose:false,defer:false,data:{modelSource:'model',modelName:'public-chat',modelGroupId:null,pools:[{id:'pool-a',name:'对话池',isDefault:true}],models:[{id:'model',publicId:'public-chat',name:'公开对话模型'}],consumers:[{feature:'调用用途推导',appCallerCode:'system'}],servingReachable:true,servingBaseUrl:'http://serving:8080',credentialState:'ready',appCallerCode:'system',teamIsSystemOwned:true,teamName:'系统内部'}};
  const api=await readFile(new URL('../src/lib/api.ts',import.meta.url),'utf8');
  const server=await createServer({root:process.env.W2_TEST_ROOT||fileURLToPath(new URL('../',import.meta.url)),server:{middlewareMode:true},appType:'custom',logLevel:'silent',optimizeDeps:{noDiscovery:true},ssr:{noExternal:['react-router-dom']},plugins:[{name:'system-settings-fixture',enforce:'pre',resolveId(id){if(id==='react-router-dom')return '\0system-router';},load(id){
    if(id==='\0system-router')return Object.keys(globalThis.__systemRouter).filter(name=>name!=='default').map(name=>`export const ${name}=globalThis.__systemRouter.${name};`).join('\n');
    if(id.endsWith('/src/lib/api.ts'))return [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(([,name])=>{
      if(name==='getSystemSettings')return 'export async function getSystemSettings(){return {success:true,data:globalThis.__systemSettings.data}}';
      if(name==='saveSystemSettings')return 'export async function saveSystemSettings(payload){const f=globalThis.__systemSettings;f.writes.push(payload);f.data={...f.data,...payload};if(f.defer)await new Promise(resolve=>{f.resolve=resolve});return f.lose?{success:false,error:{code:"NETWORK_ERROR",message:"Failed to fetch"}}:{success:true,data:f.data}}';
      if(name==='testSystemSettings')return 'export async function testSystemSettings(){globalThis.__systemSettings.tests++;return {success:true,data:{ok:true,message:"本次配置连接成功"}}}';
      return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
    }).join('\n');
  }}]}); let root;
  try{
    const {createRoot}=await import('react-dom/client'); const {GatewaySettingsPage}=await server.ssrLoadModule('/src/pages/GatewaySettingsPage.tsx');root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(globalThis.__systemRouter.MemoryRouter,{},React.createElement(GatewaySettingsPage))));
    const button=name=>[...document.querySelectorAll('button')].find(node=>node.textContent===name||(name==='测试连接'&&node.textContent==='测试模型调用'));
    const click=async node=>{assert.ok(node);await act(async()=>node.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true})));};
    const select=async value=>click(document.querySelector(`input[type="radio"][value="${value}"]`)||[...document.querySelectorAll('[role="radio"]')].find(node=>node.textContent.includes(value==='pool'?'钉一个模型池':value==='auto'?'交给网关挑':'钉一个模型')));
    await select('auto'); assert.equal(button('测试连接').disabled,true); await click(button('保存设置'));assert.equal(button('测试连接').disabled,false);
    await click(button('测试连接'));assert.match(document.body.textContent,/本次配置连接成功/);assert.equal(globalThis.__systemSettings.tests,1);
    await select('model');assert.doesNotMatch(document.body.textContent,/本次配置连接成功/);assert.equal(button('测试连接').disabled,true);
    globalThis.__systemSettings.lose=true;await click(button('保存设置'));assert.match(document.body.textContent,/保存结果未确认/);assert.equal(button('保存设置').disabled,true);assert.equal(button('测试连接').disabled,true);
    await click(button('重新读取配置'));assert.equal(document.querySelector('input[value="model"]').checked,true);assert.equal(button('测试连接').disabled,false);assert.equal(globalThis.__systemSettings.tests,1,'read reconciliation never calls a paid test');
    globalThis.__systemSettings.lose=false;globalThis.__systemSettings.defer=true;await select('auto');await click(button('保存设置'));await select('model');await act(async()=>globalThis.__systemSettings.resolve());
    assert.equal(document.querySelector('input[value="model"]').checked,true,'draft changed during saving remains selected');assert.equal(button('保存设置').disabled,false);assert.equal(button('测试连接').disabled,true);assert.match(document.body.textContent,/当前修改尚未保存/);
    assert.equal(document.querySelectorAll('input[type="radio"][name="system-model-source"]').length,2);assert.match(document.body.textContent,/影响功能：调用用途推导/);assert.match(document.body.textContent,/明文只在服务端/);assert.match(document.body.textContent,/不进任何业务团队的预算/);
  }finally{if(root)await act(async()=>root.unmount());await server.close();dom.window.close();for(const name of names)globalThis[name]=previous[name];delete globalThis.IS_REACT_ACT_ENVIRONMENT;delete globalThis.__systemSettings;delete globalThis.__systemRouter;}
});
