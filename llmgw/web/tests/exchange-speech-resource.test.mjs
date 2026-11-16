import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('豆包语音资源可编辑读回，并发冲突保留输入且不回传通讯密钥或完整协议配置', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/exchanges' });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const { createRoot } = await import('react-dom/client');
  const router = await import('react-router-dom');
  globalThis.__speechExchangeRouter = { ...router.default, ...router };
  const fixture = {
    conflict: true, calls: [],
    item: { id: 'speech-exchange', name: '语音资源', models: [{ modelId: 'configured-model', modelType: 'tts', enabled: true }],
      modelAliases: [], modelAlias: '', targetUrl: 'https://speech.example/tts', transformerType: 'doubao-tts',
      targetAuthScheme: 'XApiKey', resourceId: 'seed-tts-2.0', enabled: true, hasKey: true, authority: 'llm_gateway', version: 7 },
  };
  globalThis.__speechExchangeFixture = fixture;
  const api = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const apiNames = [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]);
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] }, ssr: { noExternal: ['react-router-dom'] },
    plugins: [{ name: 'speech-exchange-fixture', enforce: 'pre',
      resolveId(id) { if (id === 'react-router-dom') return '\0speech-exchange-router'; },
      load(id) {
        if (id === '\0speech-exchange-router') return Object.keys(globalThis.__speechExchangeRouter).filter(name => name !== 'default').map(name => `export const ${name}=globalThis.__speechExchangeRouter.${name};`).join('\n');
        if (id.endsWith('/src/lib/auth.tsx')) return 'export function useAuth(){return {tenant:{role:"owner"}}}';
        if (id.endsWith('/src/components/ConfirmDialog.tsx')) return 'export function useDialogs(){return {confirm:async()=>false,promptText:async()=>null}}';
        if (id.endsWith('/src/lib/api.ts')) return apiNames.map(name => {
          if (name === 'getExchanges') return 'export async function getExchanges(){return {success:true,data:{items:[globalThis.__speechExchangeFixture.item]}}}';
          if (name === 'getExchangeMeta') return 'export async function getExchangeMeta(){return {success:true,data:{transformerTypes:[{value:"doubao-tts",label:"豆包语音合成"}],authSchemes:[{value:"XApiKey",label:"x-api-key"}],modelTypes:[{value:"tts",label:"语音合成"}]}}}';
          if (name === 'getImageLayeringCapability') return 'export async function getImageLayeringCapability(){return {success:true,data:{state:"not-installed"}}}';
          if (name === 'updateExchange') return 'export async function updateExchange(id,draft){const f=globalThis.__speechExchangeFixture;f.calls.push({id,draft});if(f.conflict)return {success:false,error:{code:"EXCHANGE_CONCURRENTLY_MODIFIED"}};f.item={...f.item,...draft,version:draft.version+1};return {success:true,data:f.item}}';
          return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
        }).join('\n');
      },
    }],
  });
  let root;
  const click = async text => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text);
    assert.ok(button, `缺少按钮 ${text}`);
    await act(async () => button.click());
  };
  const resource = () => document.querySelector('input[placeholder="填写账号实际开通的语音资源"]');
  try {
    const { ExchangesPage } = await server.ssrLoadModule('/src/pages/ExchangesPage.tsx');
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(globalThis.__speechExchangeRouter.MemoryRouter, {}, React.createElement(ExchangesPage))));
    await click('编辑映射');
    assert.equal(resource().value, 'seed-tts-2.0');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(resource(), 'seed-tts-1.0');
      resource().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await click('保存并读回');
    assert.equal(resource().value, 'seed-tts-1.0');
    assert.match(document.body.textContent, /已被其他人修改/);
    assert.equal(fixture.calls[0].draft.version, 7);
    assert.equal(fixture.calls[0].draft.resourceId, 'seed-tts-1.0');
    assert.equal(Object.hasOwn(fixture.calls[0].draft, 'transformerConfig'), false);
    assert.equal(Object.hasOwn(fixture.calls[0].draft, 'apiKey'), false);
    fixture.conflict = false;
    await click('保存并读回');
    await click('编辑映射');
    assert.equal(resource().value, 'seed-tts-1.0');
    assert.match(document.body.textContent, /正在编辑版本 8/);
  } finally {
    if (root) await act(async () => root.unmount());
    await server.close();
    dom.window.close();
    for (const name of names) globalThis[name] = previous[name];
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
    delete globalThis.__speechExchangeFixture;
    delete globalThis.__speechExchangeRouter;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
