import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('供应方编辑保持可见及权限；调用全貌区分线路缺失与搜索空态', async () => {
  const rootDir = fileURLToPath(new URL('../', import.meta.url));
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/platforms' });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  const { createRoot } = await import('react-dom/client');
  const routerModule = await import('react-router-dom');
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const fixture = {
    role: 'owner', calls: [],
    providers: Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`, name: `上游 ${i}`, authority: 'llm_gateway', platformType: 'openrouter',
      apiUrl: 'https://example.test/v1', hasKey: true, enabled: true, remark: '原备注', maxConcurrency: 20,
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
          if (name === 'getPlatforms') return 'export async function getPlatforms(){return {success:true,data:{items:globalThis.__providerEditFixture.providers}}}';
          if (name === 'getCallTrace') return 'export async function getCallTrace(){return {success:true,data:globalThis.__providerEditFixture.traceData}}';
          if (name === 'updatePlatform') return 'export async function updatePlatform(id,draft){const f=globalThis.__providerEditFixture;f.calls.push({id,draft});f.providers=f.providers.map(p=>p.id===id?{...p,...draft,platformType:draft.platformType??p.platformType}:p);return {success:true,data:f.providers.find(p=>p.id===id)}}';
          return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
        }).join('\n');
        if (id.endsWith('/src/lib/auth.tsx')) return 'export function useAuth(){return {tenant:{role:globalThis.__providerEditFixture.role}}}';
        if (id.endsWith('/src/components/ConfirmDialog.tsx')) return 'export function useDialogs(){return {confirm:async()=>false,promptText:async()=>null}}';
      },
    }],
  });
  let root;
  const click = async button => { assert.ok(button, '预期按钮存在'); await act(async () => button.click()); };
  const button = (text, scope = document) => [...scope.querySelectorAll('button')].find(b => b.textContent.trim() === text);
  const input = async (element, value) => {
    assert.ok(element);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(element, value);
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  try {
    const { PlatformsPage } = await server.ssrLoadModule('/src/pages/PlatformsPage.tsx');
    const { MemoryRouter } = globalThis.__providerRouterModule;
    const mount = async () => {
      root = createRoot(document.getElementById('root'));
      await act(async () => root.render(React.createElement(MemoryRouter, {}, React.createElement(PlatformsPage))));
    };
    await mount();
    const firstRow = document.querySelector('.lg-collection-provider-row');
    await click(firstRow.querySelector('td:nth-child(2) button'));
    await click(button('连接配置'));
    // 详情独立于分页：选中项不在当前父列表页，也能编辑。
    await click(button('下一页', document.querySelector('.lg-collection-list')));
    assert.equal(document.querySelector('.lg-collection-list').textContent.includes('上游 0'), false);
    await click(button('编辑连接'));
    assert.ok(document.querySelector('.lg-collection-pane input[aria-label="平台名称"]'));
    assert.equal(document.querySelector('.lg-collection-list input[aria-label="平台名称"]'), null);
    await click(button('取消', document.querySelector('.lg-collection-pane')));
    assert.equal(fixture.calls.length, 0);
    // 搜索将父列表清空，仍可在窄屏保留的详情节点编辑、保存。
    await input(document.querySelector('input[aria-label="搜索供应方名称或接口"]'), '不存在的供应方');
    assert.equal(document.querySelectorAll('.lg-collection-provider-row').length, 0);
    await click(button('编辑连接'));
    await input(document.querySelector('.lg-collection-pane input[aria-label="备注"]'), '更新备注');
    await click(button('保存', document.querySelector('.lg-collection-pane')));
    assert.deepEqual(fixture.calls, [{ id: 'p0', draft: { name: '上游 0', platformType: undefined, apiUrl: 'https://example.test/v1', maxConcurrency: 20, remark: '更新备注' } }]);
    assert.ok(document.body.textContent.includes('已保存「上游 0」'));
    await click(button('编辑连接'));
    assert.equal(document.querySelector('.lg-collection-pane input[aria-label="备注"]').value, '更新备注');
    await act(async () => root.unmount());
    root = null;
    fixture.role = 'viewer';
    await mount();
    await click(document.querySelector('.lg-collection-provider-row td:nth-child(2) button'));
    await click(button('连接配置'));
    assert.equal(button('编辑连接'), undefined);
    assert.equal(document.querySelector('[aria-label="平台名称"]'), null);
    assert.equal(fixture.calls.length, 1);
    await act(async () => root.unmount());
    root = null;
    const { CallTracePanel } = await server.ssrLoadModule('/src/components/CallTracePanel.tsx');
    fixture.traceData = {
      publicId: 'missing-route', conclusion: '当前没有可用线路', routingStrategy: 'priority',
      routes: [], routeExtras: [], flow: [],
      gate: { enabled: true, allowedAppCallerCodes: [], summary: '已启用' },
      unnamed: { reachingCallerCount: 0, callerCount: 0, callers: [], summary: '没有调用方' },
      ledger: { windowDays: 7, calls: 0, costUsd: 0, unpricedCalls: 0 },
    };
    const mountTrace = async () => {
      root = createRoot(document.getElementById('root'));
      await act(async () => root.render(React.createElement(CallTracePanel, { logicalModelId: 'empty' })));
    };
    await mountTrace();
    const routeSection = document.querySelector('[data-testid="call-trace-routes"]');
    assert.equal(routeSection.querySelector('[role="alert"]').textContent, '一条线路都没有，现在调它一定失败。');
    assert.equal(routeSection.textContent.includes('没有匹配结果'), false);
    await act(async () => root.unmount());
    root = null;
    fixture.traceData.routes = [{ id: 'r1', providerName: '上游', upstreamModelId: 'chat', queuePosition: 1, priority: 0, enabled: true, healthStatus: 0 }];
    await mountTrace();
    await input(document.querySelector('input[aria-label="搜索线路模型、供应方或状态"]'), '不存在的线路');
    assert.ok(document.querySelector('[data-testid="call-trace-routes"]').textContent.includes('没有匹配结果'));
    assert.equal(document.querySelector('[data-testid="call-trace-routes"] [role="alert"]'), null);
  } finally {
    if (root) await act(async () => root.unmount());
    await server.close();
    dom.window.close();
    for (const name of names) globalThis[name] = previous[name];
    delete globalThis.__providerEditFixture;
    delete globalThis.__providerRouterModule;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
