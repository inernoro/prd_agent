import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('列表连接标签直接保存代理，Provider保留其他字段，Exchange保留版本保护；接入模型可搜索批选', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/platforms' });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Event', 'MouseEvent'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const { createRoot } = await import('react-dom/client');
  const router = await import('react-router-dom');
  globalThis.__quickProxyRouter = { ...router.default, ...router };
  const fixture = {
    role: 'owner', calls: [], rejectExchange: true,
    provider: { id: 'provider', name: '官方上游', authority: 'llm_gateway', platformType: 'openai', apiUrl: 'https://official.test', hasKey: true, enabled: true, remark: '必须保留的备注', maxConcurrency: 8, proxy: { mode: 'inherit', hasPassword: false } },
    exchange: { id: 'exchange', name: '语音上游', authority: 'llm_gateway', targetUrl: 'https://official.test/tts', enabled: true, hasKey: true, version: 7, transformerType: 'doubao-tts', models: [], modelAliases: [], proxy: { mode: 'custom', address: 'http://proxy.test:3128', hasPassword: true } },
  };
  globalThis.__quickProxyFixture = fixture;
  const api = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const apiNames = [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]);
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] }, ssr: { noExternal: ['react-router-dom'] },
    plugins: [{ name: 'quick-proxy-fixture', enforce: 'pre',
      resolveId(id) { if (id === 'react-router-dom') return '\0quick-proxy-router'; },
      load(id) {
        if (id === '\0quick-proxy-router') return Object.keys(globalThis.__quickProxyRouter).filter(name => name !== 'default').map(name => `export const ${name}=globalThis.__quickProxyRouter.${name};`).join('\n');
        if (id.endsWith('/src/lib/auth.tsx')) return 'export function useAuth(){return {tenant:{id:"tenant",role:globalThis.__quickProxyFixture.role}}}';
        if (id.endsWith('/src/components/ConfirmDialog.tsx')) return 'export function useDialogs(){return {confirm:async()=>false,promptText:async()=>null}}';
        if (id.endsWith('/src/lib/api.ts')) return apiNames.map(name => {
          if (name === 'getPlatforms') return 'export async function getPlatforms(){return {success:true,data:{items:[globalThis.__quickProxyFixture.provider]}}}';
          if (name === 'getExchanges') return 'export async function getExchanges(){return {success:true,data:{items:[globalThis.__quickProxyFixture.exchange]}}}';
          if (name === 'getExchangeMeta') return 'export async function getExchangeMeta(){return {success:true,data:{transformerTypes:[],authSchemes:[],modelTypes:[]}}}';
          if (name === 'getImageLayeringCapability') return 'export async function getImageLayeringCapability(){return {success:true,data:{state:"not-installed"}}}';
          if (name === 'getUpstreamProxy') return 'export async function getUpstreamProxy(){return {success:true,data:{mode:"custom",address:"http://global.test:3128",hasPassword:false}}}';
          if (name === 'getCatalogEntries') return 'export async function getCatalogEntries(){return {success:true,data:{items:[],knownCapabilities:["chat"]}}}';
          if (name === 'setPlatformEnabled') return 'export async function setPlatformEnabled(id,enabled){const f=globalThis.__quickProxyFixture;f.calls.push({kind:"platform-enabled",id,enabled});if(f.rejectDisable)return {success:false,error:{message:"停用未完成，请重试"}};f.provider={...f.provider,enabled};return {success:true,data:f.provider,error:null}}';
          if (name === 'updatePlatform') return 'export async function updatePlatform(id,draft){const f=globalThis.__quickProxyFixture;f.calls.push({kind:"platform",id,draft});f.provider={...f.provider,...draft,updatedAt:"new"};return {success:true,data:f.provider,error:null}}';
          if (name === 'updateExchangeProxy') return 'export async function updateExchangeProxy(id,draft){const f=globalThis.__quickProxyFixture;f.calls.push({kind:"exchange",id,draft});if(f.rejectExchange)return {success:false,error:{message:"版本已变更，请刷新清单"}};f.exchange={...f.exchange,proxy:draft.proxy,version:8};return {success:true,data:f.exchange,error:null}}';
          return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
        }).join('\n');
      },
    }],
  });
  let root;
  const button = (text, scope = document) => [...scope.querySelectorAll('button')].find(element => element.textContent.trim() === text);
  const click = async element => { assert.ok(element, '缺少操作入口'); await act(async () => element.click()); };
  const fill = async (element, value) => {
    assert.ok(element, '缺少表单字段');
    await act(async () => {
      const prototype = element.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    });
  };
  try {
    const { UpstreamProxyProvider } = await server.ssrLoadModule('/src/components/UpstreamProxySettings.tsx');
    const { PlatformsPage } = await server.ssrLoadModule('/src/pages/PlatformsPage.tsx');
    const { ExchangesPage } = await server.ssrLoadModule('/src/pages/ExchangesPage.tsx');
    root = createRoot(document.getElementById('root'));
    const mount = async (Component, key) => act(async () => root.render(React.createElement(globalThis.__quickProxyRouter.MemoryRouter, {}, React.createElement(UpstreamProxyProvider, { key }, React.createElement(Component)))));
    await mount(PlatformsPage, 'provider');
    const trigger = document.querySelector('[aria-label="更改官方上游的连接方式"]');
    assert.match(trigger.textContent, /全局代理/);
    await click(trigger);
    assert.equal(document.querySelector('[aria-label="平台名称"]'), null, '快捷代理不能绕回整条上游编辑');
    assert.ok(document.querySelector('[role="dialog"] select'));
    await fill(document.querySelector('[role="dialog"] select'), 'direct');
    await click(button('保存连接方式'));
    assert.deepEqual(fixture.calls[0], { kind: 'platform', id: 'provider', draft: { proxy: { mode: 'direct', address: '', username: '' } } });
    assert.equal(fixture.provider.remark, '必须保留的备注');
    assert.equal(fixture.provider.apiUrl, 'https://official.test');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(document.querySelector('[aria-label="更改官方上游的连接方式"]').textContent, /强制直连/);
    await click(document.querySelector('[aria-label="更改官方上游的连接方式"]'));
    await fill(document.querySelector('[role="dialog"] select'), 'inherit');
    await click(button('取消', document.querySelector('[role="dialog"]')));
    assert.equal(fixture.calls.length, 1, '取消不发送请求');
    await click(document.querySelector('[aria-label="更多操作"]'));
    assert.equal(button('重新停用'), undefined, '启用中的上游不显示重复停用入口');
    await click(document.querySelector('[aria-label="更多操作"]'));
    fixture.role = 'viewer';
    await mount(PlatformsPage, 'viewer');
    assert.equal(document.querySelector('[aria-label="更改官方上游的连接方式"]'), null);
    fixture.role = 'owner';
    await mount(ExchangesPage, 'exchange');
    await click(document.querySelector('[aria-label="更改语音上游的连接方式"]'));
    const dialog = document.querySelector('[role="dialog"]');
    assert.equal(dialog.querySelector('input[aria-label="代理密码"]').value, '', '已保存代理密码不回显');
    await fill(dialog.querySelector('select'), 'inherit');
    await click(button('保存连接方式'));
    assert.match(document.querySelector('[role="dialog"]').textContent, /版本已变更/);
    assert.equal(fixture.exchange.version, 7, '失败不能更新列表或版本');
    assert.deepEqual(fixture.calls[1], { kind: 'exchange', id: 'exchange', draft: { version: 7, proxy: { mode: 'inherit', address: 'http://proxy.test:3128', username: '' } } });
    assert.equal('apiKey' in fixture.calls[1].draft, false);
    assert.equal('targetUrl' in fixture.calls[1].draft, false);
    fixture.rejectExchange = false;
    await click(button('保存连接方式'));
    assert.equal(fixture.exchange.version, 8);
    assert.equal(fixture.exchange.targetUrl, 'https://official.test/tts');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(document.querySelector('[aria-label="更改语音上游的连接方式"]').textContent, /全局代理/);

    fixture.provider = { ...fixture.provider, enabled: false };
    await mount(PlatformsPage, 'disabled-provider');
    await click(document.querySelector('[aria-label="更多操作"]'));
    assert.ok(button('启用'), '原有启用入口保留');
    await click(button('重新停用'));
    assert.deepEqual(fixture.calls.at(-1), { kind: 'platform-enabled', id: 'provider', enabled: false });
    assert.equal(fixture.provider.enabled, false);
    assert.match(document.body.textContent, /已停用平台「官方上游」/);
    fixture.rejectDisable = true;
    await click(document.querySelector('[aria-label="更多操作"]'));
    await click(button('重新停用'));
    assert.equal(fixture.provider.enabled, false, '重复停用失败保留原停用状态');
    assert.match(document.body.textContent, /停用未完成，请重试/);
    assert.deepEqual(fixture.calls.filter(call => call.kind === 'platform-enabled').map(call => call.enabled), [false, false], '重复停用不能先启用再停用');

    const { UpstreamModelPicker } = await server.ssrLoadModule('/src/components/ProviderSetup.tsx');
    let imported = [];
    const model = (id, inCatalog = true) => ({ modelId: id, displayName: id, inferredCapabilities: ['chat'], inCatalog, alreadyImported: false, alreadyPublished: false });
    const data = { total: 3, alreadyImportedCount: 0, pricingProvided: false, items: [model('claude-official'), model('openrouter/claude'), model('unknown', false)] };
    await act(async () => root.render(React.createElement(UpstreamModelPicker, { data, busy: false, onCancel() {}, onImport(items) { imported = items; } })));
    await click(button('清空选择'));
    await fill(document.querySelector('[aria-label="搜索上游模型"]'), 'openrouter');
    await click(button('选择当前结果'));
    await click(button('接入选中的 1 个模型'));
    assert.deepEqual(imported.map(item => item.modelId), ['openrouter/claude']);
    await fill(document.querySelector('[aria-label="搜索上游模型"]'), 'unknown');
    assert.equal(button('选择当前结果').disabled, true, '搜索不会放行用途未确认的模型');
    assert.match(document.body.textContent, /MAP 按调用方权限使用/);
  } finally {
    if (root) await act(async () => root.unmount());
    await server.close();
    dom.window.close();
    for (const name of names) globalThis[name] = previous[name];
    delete globalThis.__quickProxyFixture;
    delete globalThis.__quickProxyRouter;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
