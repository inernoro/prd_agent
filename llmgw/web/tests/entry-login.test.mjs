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
  // JSDOM has no media decoder. This unit case verifies routing/recovery; real playback is recorded in cloud browsers.
  dom.window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.load = () => {};
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
    assert.equal(entryAsset('scan.wav'), '/media/entry/scan.wav');
    dom.reconfigure({ url: 'http://localhost/llmgw/login' });
    assert.equal(entryAsset('scan.wav'), '/llmgw/media/entry/scan.wav');
    assert.equal(entryAsset('verified.wav'), '/llmgw/media/entry/verified.wav');
    dom.reconfigure({ url: 'http://localhost/login' });
    const { gatewayLoginDestination, hasQuickstartArrival } = await server.ssrLoadModule('/src/components/entry/quickstartArrival.ts');
    for (const path of [null, '/', '//outside', 'https://outside', '/login']) assert.equal(gatewayLoginDestination(path, {role:'admin'}), '/quickstart');
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
    globalThis.__gatewayLogin = { success: true, data: { mustChangePassword: false, tenant: { role: "admin" } } };
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
    assert.equal(gatewayLoginDestination(null), '/');
    for (const role of ['owner','admin','developer','viewer']) assert.equal(gatewayLoginDestination(null, {role}), '/quickstart');
    for (const candidate of [null, '/', '//outside.test', '/login']) assert.equal(gatewayLoginDestination(candidate, {role:'billing'}), '/');
    assert.equal(gatewayLoginDestination('/usage', {role:'billing'}), '/usage');
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

test('MAP 单点进入受阻时先显示试听，点击真实激活后才声称音效开启', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/quickstart' });
  const keys = ['window','document','localStorage','AudioContext','fetch','IS_REACT_ACT_ENVIRONMENT'];
  const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  let permitted = false, started = 0, stopped = 0, root, finish, acknowledgeResume;
  class Context {
    state = 'suspended'; destination = {};
    resume() {
      if (!permitted || this.state === 'running') return Promise.resolve();
      return new Promise(resolve => { acknowledgeResume = () => { this.state = 'running'; resolve(); }; });
    }
    decodeAudioData() { return Promise.resolve({}); }
    createBufferSource() { return { connect() {}, disconnect() {}, start() { started++; }, stop() { stopped++; }, onended: null }; }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, AudioContext: Context, IS_REACT_ACT_ENVIRONMENT: true });
  window.AudioContext = Context; window.matchMedia = () => ({ matches: false });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) });
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), cacheDir: '/tmp/llmgw-sound-test-cache', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { createRoot } = await import('react-dom/client');
    const { markQuickstartArrival } = await server.ssrLoadModule('/src/components/entry/quickstartArrival.ts');
    ({ finishEntryArrival: finish } = await server.ssrLoadModule('/src/components/entry/entryArrival.ts'));
    const { GatewaySoundToggle } = await server.ssrLoadModule('/src/components/entry/GatewaySoundToggle.tsx');
    const { GATEWAY_SOUND_EVENT } = await server.ssrLoadModule('/src/components/entry/gatewaySound.ts');
    markQuickstartArrival();
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(GatewaySoundToggle)));
    const button = document.querySelector('button');
    assert.equal(started, 0);
    assert.equal(button.getAttribute('aria-label'), '播放进入音效');
    assert.equal(button.dataset.audioStatus, 'pending');
    permitted = true;
    await act(async () => button.click());
    assert.equal(started, 0, 'resume 尚未完成不能声称已播放');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1400)); });
    assert.equal(button.dataset.audioStatus, 'pending');
    await act(async () => acknowledgeResume());
    assert.equal(started, 1);
    assert.equal(button.dataset.audioStatus, 'ready');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    await act(async () => window.dispatchEvent(new window.CustomEvent(GATEWAY_SOUND_EVENT, { detail: 'scan' })));
    assert.equal(started, 2);
    await act(async () => button.click());
    assert.equal(localStorage.getItem('llmgw-entry-sound'), 'off');
    assert.equal(button.dataset.audioStatus, 'muted');
    assert.ok(stopped >= 1);
    await act(async () => window.dispatchEvent(new window.CustomEvent(GATEWAY_SOUND_EVENT, { detail: 'reveal' })));
    assert.equal(started, 2);
    const { EntryAudio } = await server.ssrLoadModule('/src/components/entry/entryAudio.ts');
    const cancelled = new EntryAudio();
    cancelled.unlock();
    const waiting = cancelled.play('scan');
    cancelled.stop();
    acknowledgeResume();
    assert.equal(await waiting, false, '等待恢复期间被取消的旧音效不能迟到播放');
    assert.equal(started, 2);
    cancelled.dispose();
    let fetches = 0;
    globalThis.fetch = async () => ({ ok: ++fetches > 3, arrayBuffer: async () => new ArrayBuffer(2) });
    const retry = new EntryAudio();
    retry.unlock();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    acknowledgeResume();
    assert.equal(await retry.play('reveal'), false, '首次资源错误不能声称已播放');
    assert.equal(fetches, 3, '错误不能触发后台重试风暴');
    retry.unlock();
    assert.equal(await retry.play('reveal'), true, '下次用户激活可重新加载并播放');
    assert.equal(fetches, 6);
    retry.dispose();

    // Password login transfers the existing device while resume may still be pending.
    await act(async () => root.unmount());
    localStorage.removeItem('llmgw-entry-sound');
    const transferred = new EntryAudio();
    transferred.unlock();
    markQuickstartArrival(transferred);
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(GatewaySoundToggle)));
    const transferredButton = document.querySelector('button');
    assert.equal(transferredButton.dataset.audioStatus, 'pending');
    const beforeTransfer = started;
    await act(async () => acknowledgeResume());
    assert.equal(started, beforeTransfer + 1, '转移音频在设备恢复后真实启动');
    assert.equal(transferredButton.dataset.audioStatus, 'ready', '迟到的播放结果必须同步按钮');
    assert.equal(transferredButton.getAttribute('aria-label'), '关闭进入音效');
    await act(async () => transferredButton.click());
    assert.equal(transferredButton.dataset.audioStatus, 'muted');
    assert.equal(localStorage.getItem('llmgw-entry-sound'), 'off');
  } finally {
    if (root) await act(async () => root.unmount());
    finish?.(); await server.close(); dom.window.close(); Object.assign(globalThis, previous);
  }
});
