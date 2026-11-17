import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act, useState } from 'react';

test('分类Tab使用方向键游走、Home/End定位且Enter手动激活，保持单一Tab停靠',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});const old={window:globalThis.window,document:globalThis.document,HTMLElement:globalThis.HTMLElement};Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
 const server=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),server:{middlewareMode:true},appType:'custom',logLevel:'silent',optimizeDeps:{noDiscovery:true,include:[]}});let root;
 try{const {createRoot}=await import('react-dom/client');const {TabBar}=await server.ssrLoadModule('/src/components/ui.tsx');const calls=[];function Screen(){const [active,setActive]=useState('a');return React.createElement(TabBar,{items:[{key:'a',label:'Provider'},{key:'b',label:'转接上游'},{key:'c',label:'生图契约'}],activeKey:active,onChange:key=>{calls.push(key);setActive(key)}})}
 root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Screen)));const tabs=[...document.querySelectorAll('[role="tab"]')];const key=async value=>act(async()=>document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true})));
 await act(async()=>tabs[0].focus());await key('ArrowRight');assert.equal(document.activeElement.textContent,tabs[1].textContent,'右方向键必须游走焦点而不是无反应');assert.equal(calls.length,0,'方向键不触发取数/页面切换');assert.equal(tabs[0].getAttribute('aria-selected'),'true');assert.equal(tabs.filter(t=>t.tabIndex===0).length,1);
 await key('End');assert.equal(document.activeElement.textContent,tabs[2].textContent);await key('ArrowRight');assert.equal(document.activeElement.textContent,tabs[0].textContent);await key('ArrowLeft');assert.equal(document.activeElement.textContent,tabs[2].textContent);await key('Home');assert.equal(document.activeElement.textContent,tabs[0].textContent);await key('ArrowRight');await key('Enter');assert.deepEqual(calls,['b']);assert.equal(tabs[1].getAttribute('aria-selected'),'true');assert.equal(tabs.filter(t=>t.tabIndex===0).length,1);
 }finally{if(root)await act(async()=>root.unmount());await server.close();dom.window.close();Object.assign(globalThis,old);delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});
