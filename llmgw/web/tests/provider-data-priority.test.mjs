import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('Provider先呈现对象、低频全局维护在数据后且空态仍可配置', async () => {
  const rootDir = fileURLToPath(new URL('../', import.meta.url));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/platforms' });
  const originalFetch = globalThis.fetch;
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  const { createRoot } = await import('react-dom/client');
  const routerModule = await import('react-router-dom');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollTo = () => {};dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const fixture = {
    role: 'owner', calls: [], models: [], logicalModels: [], appCallers: [], serviceKeys: [],
    providers: Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`, name: `上游 ${i}`, authority: 'llm_gateway', platformType: 'openrouter',
      apiUrl: 'https://example.test/v1', hasKey: true, enabled: true, remark: '原备注', maxConcurrency: 20,
      ...(i === 0 ? { recentCallStatus: 'quota_exhausted', recentCallAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z' } : i === 1 ? { recentCallStatus: 'succeeded' } : {}),
    })),
  };
  globalThis.__providerEditFixture = fixture;
  globalThis.__providerRouterModule = { ...routerModule.default, ...routerModule };
  const apiSource = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const apiNames = [...apiSource.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]);
  const server = await createServer({
    root: rootDir, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: ['react-router-dom'] },
    plugins: [{
      name: 'provider-editor-api-fixture', enforce: 'pre',
      resolveId(id) { if (id === 'react-router-dom') return '\0provider-test-router'; },
      load(id) {
        if (id === '\0provider-test-router') return Object.keys(globalThis.__providerRouterModule).filter(name => name !== 'default').map(name => `export const ${name}=globalThis.__providerRouterModule.${name};`).join('\n');
        if (id.endsWith('/src/lib/api.ts')) return apiNames.map(name => {
          if (name === 'getUpstreamProxy') return 'export async function getUpstreamProxy(){return {success:true,data:{mode:"inherit",address:null,hasPassword:false}}}';
          if (name === 'getPlatforms') return 'export async function getPlatforms(){return globalThis.__providerEditFixture.providersFailure?{success:false,error:{message:"Provider读取失败（受控）"}}:{success:true,data:{items:globalThis.__providerEditFixture.providers}}}';
          if (name === 'getModels') return 'export async function getModels(){return globalThis.__providerEditFixture.modelsFailure?{success:false,error:{message:"离线"}}:{success:true,data:{items:globalThis.__providerEditFixture.models}}}';
          if (name === 'getLogicalModels') return 'export async function getLogicalModels(){if(globalThis.__providerEditFixture.logicalReadThrow)throw new Error("body interrupted");return {success:true,data:{items:globalThis.__providerEditFixture.logicalModels}}}';
          if (name === 'getExchangeMeta') return 'export async function getExchangeMeta(){return {success:false,error:{message:"目录未注入"}}}';
          return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
        }).join('\n');
        if (id.endsWith('/src/lib/auth.tsx')) return 'export function useAuth(){return {tenant:{id:"tenant",role:globalThis.__providerEditFixture.role,teamIds:["team"]}}}';
        if (id.endsWith('/src/components/ConfirmDialog.tsx')) return 'export function useDialogs(){return {confirm:async()=>false,promptText:async()=>null}}';
      },
    }],
  });

  let root;
  try {
    const { UpstreamsPage } = await server.ssrLoadModule('/src/pages/UpstreamsPage.tsx');
    const { MemoryRouter } = globalThis.__providerRouterModule;
    const mount = async () => {root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(MemoryRouter,{initialEntries:['/platforms']},React.createElement(UpstreamsPage))));};
    await mount();
    const workspace=document.querySelector('.lg-collection-workspace');
    const global=document.querySelector('.lg-upstream-global-control');
    const bulk=document.querySelector('.lg-provider-bulk-control');
    assert.equal(document.querySelectorAll('.lg-upstream-global-control').length,1);
    assert.ok(workspace.compareDocumentPosition(global)&dom.window.Node.DOCUMENT_POSITION_FOLLOWING,'全局连接应在Provider数据后，不能挤占导航/首对象之前');
    assert.ok(workspace.compareDocumentPosition(bulk)&dom.window.Node.DOCUMENT_POSITION_FOLLOWING,'全部Provider批量轮换应在数据后');
    assert.equal(document.querySelector('.lg-collection-toolbar .lg-provider-bulk-control'),null);
    assert.ok(bulk.textContent.includes('确认应用全部供应方（不随清单筛选）'));
    assert.ok(document.querySelector('.lg-collection-provider-row').textContent.includes('跟随全局'));
    assert.ok([...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='添加 Provider'));
    await act(async()=>root.unmount());root=null;fixture.providers=[];
    await mount();
    assert.ok(document.querySelector('.lg-upstream-global-control'),'没有Provider仍可配置全局连接');
    assert.equal(document.querySelector('.lg-provider-bulk-control'),null,'空集合不提供批量轮换');
    assert.ok([...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='收起配置'),'空态保留自动展开的创建表单');
    await act(async()=>root.unmount());root=null;fixture.providersFailure=true;await mount();
    assert.ok(document.body.textContent.includes('Provider读取失败（受控）'));
    assert.ok(document.querySelector('.lg-upstream-global-control'),'Provider目录读取失败不能隐藏独立的全局连接配置');
  } finally {
    if(root)await act(async()=>root.unmount());await server.close();globalThis.fetch=originalFetch;dom.window.close();for(const name of names)globalThis[name]=previous[name];delete globalThis.__providerEditFixture;delete globalThis.__providerRouterModule;delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
