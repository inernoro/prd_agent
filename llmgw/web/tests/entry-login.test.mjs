import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('电影式网关登录保持失败恢复、首登改密和静音偏好', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/login' });
  const previous = Object.fromEntries(['window','document','Image','localStorage','requestAnimationFrame','cancelAnimationFrame','IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Image: dom.window.Image, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()),16);
  globalThis.cancelAnimationFrame = clearTimeout;
  window.matchMedia = () => ({ matches: true });
  globalThis.__gatewayLogin = { success: false, error: { message: '账号或密码不正确，请重试' } };
  globalThis.__gatewayRoutes = [];
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), cacheDir: '/tmp/llmgw-entry-test-cache', ssr: { noExternal: ['react-router-dom'] }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{ name: 'entry-auth-fixture', enforce: 'pre', resolveId(id) { if (id === 'react-router-dom') return '\0entry-router'; }, load(id) {
      if (id === '\0entry-router') return 'export const useNavigate=()=>((...args)=>globalThis.__gatewayRoutes.push(args));export const useLocation=()=>({state:null})';
      if (id.endsWith('/src/lib/auth.tsx')) return 'export function useAuth(){return { login:async()=>globalThis.__gatewayLogin, sessionExpiredReason:null }}';
      if (id.endsWith('/src/lib/api.ts')) return 'export async function getHealth(){return {success:true,data:{status:"ok"}}}';
      if (id.endsWith('/src/lib/mapNavigation.ts')) return 'export function usePlatformMapHome(){}; export function resolveMapHomeHref(){return "/map"}';
    } }],
  });
  let root;
  let finishEntryArrival;
  try {
    const { createRoot } = await import('react-dom/client');
    const { entryAsset } = await server.ssrLoadModule('/src/components/entry/entryAsset.ts');
    assert.equal(entryAsset('companion.webp'), '/media/entry/companion.webp');
    dom.reconfigure({ url: 'http://localhost/llmgw/login' });
    assert.equal(entryAsset('companion.webp'), '/llmgw/media/entry/companion.webp');
    assert.equal(entryAsset('verified.wav'), '/llmgw/media/entry/verified.wav');
    dom.reconfigure({ url: 'http://localhost/login' });
    const { gatewayLoginDestination, hasQuickstartArrival } = await server.ssrLoadModule('/src/components/entry/quickstartArrival.ts');
    for (const path of [null, '/', '//outside', 'https://outside', '/login']) assert.equal(gatewayLoginDestination(path), '/quickstart');
    assert.equal(gatewayLoginDestination('/logs?requestId=sample'), '/logs?requestId=sample');
    ({ finishEntryArrival } = await server.ssrLoadModule('/src/components/entry/entryArrival.ts'));
    const { GatewayQuickstartStage } = await server.ssrLoadModule('/src/components/entry/GatewayQuickstartStage.tsx');
    const { LoginPage } = await server.ssrLoadModule('/src/pages/LoginPage.tsx');
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(LoginPage)));
    assert.match(document.body.textContent, /登录模型网关/);
    const sound = document.querySelector('.gateway-sound');
    await act(async () => sound.click());
    assert.equal(localStorage.getItem('llmgw-entry-sound'), 'off');
    const fill = async (selector, value) => act(async () => {
      const input = document.querySelector(selector);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await fill('#llmgw-username','tenant-user'); await fill('#llmgw-password','fixture-only');
    await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.match(document.querySelector('[role="alert"]').textContent,/账号或密码不正确/);
    assert.equal(document.querySelector('.gateway-login-submit').disabled,false);
    assert.equal(document.querySelector('.gateway-entry').dataset.phase,'idle');
    globalThis.__gatewayLogin = { success: true, data: { mustChangePassword: true } };
    await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.deepEqual(globalThis.__gatewayRoutes, [['/change-password', { replace: true }]]);
    assert.equal(document.querySelector('.gateway-arrival-copy'),null);
    await act(async () => root.unmount());
    root = createRoot(document.getElementById('root'));
    window.matchMedia = () => ({ matches: false });
    globalThis.__gatewayRoutes.length = 0;
    globalThis.__gatewayLogin = { success: true, data: { mustChangePassword: false } };
    await act(async () => root.render(React.createElement(LoginPage)));
    assert.equal(document.querySelector('.gateway-entry').dataset.sound,'off');
    await fill('#llmgw-username','tenant-user'); await fill('#llmgw-password','fixture-only');
    await act(async () => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(document.querySelector('.gateway-entry').dataset.phase,'authorized');
    assert.equal(globalThis.__gatewayRoutes.length,0);
    await act(async () => { await new Promise(resolve => setTimeout(resolve,800)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve,850)); });
    assert.equal(document.querySelector('.gateway-arrival-copy'),null);
    assert.deepEqual(globalThis.__gatewayRoutes,[['/quickstart',{replace:true}]]);
    assert.equal(hasQuickstartArrival(),true);
    assert.ok(document.documentElement.hasAttribute('data-entry-arriving'));
    await act(async () => root.unmount());
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(GatewayQuickstartStage,null,React.createElement('textarea',{'aria-label':'真实接入输入',defaultValue:'我想做客服问答'}))));
    assert.equal(hasQuickstartArrival(),false);
    assert.ok(document.querySelector('.gateway-quickstart-stage.is-arriving'));
    assert.equal(document.querySelector('textarea').disabled,false);
    assert.equal(document.querySelector('textarea').value,'我想做客服问答');
    assert.equal(document.querySelector('.gateway-arrival-copy'),null);
    await act(async () => root.unmount());
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(GatewayQuickstartStage,null,'真实接入表单')));
    assert.equal(document.querySelector('.is-arriving'),null);


  } finally {
    if (root) await act(async () => root.unmount());
    finishEntryArrival?.();
    await server.close(); dom.window.close(); Object.assign(globalThis, previous);
    delete globalThis.__gatewayLogin; delete globalThis.__gatewayRoutes;
  }
});
