import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('上游维护与调用方默认配置查看保留真实上下文、权限及恢复路径', async () => {
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
          if (name === 'getPlatforms') return 'export async function getPlatforms(){return {success:true,data:{items:globalThis.__providerEditFixture.providers}}}';
          if (name === 'getModels') return 'export async function getModels(){return globalThis.__providerEditFixture.modelsFailure?{success:false,error:{message:"离线"}}:{success:true,data:{items:globalThis.__providerEditFixture.models}}}';
          if (name === 'getLogicalModels') return 'export async function getLogicalModels(){if(globalThis.__providerEditFixture.logicalReadThrow)throw new Error("body interrupted");return {success:true,data:{items:globalThis.__providerEditFixture.logicalModels}}}';
          if (name === 'getGatewayAppCallers') return 'export async function getGatewayAppCallers(query){const f=globalThis.__providerEditFixture;(f.callerReads??=[]).push(query);if(f.callersThrow)throw new Error("body interrupted");return {success:true,data:{items:globalThis.__providerEditFixture.appCallers,total:1,page:1,pageSize:50,statuses:[],sourceSystems:[],ingressProtocols:[],requestTypes:[]}}}';
          if (name === 'getUpstreamModels') return 'export async function getUpstreamModels(id){globalThis.__providerEditFixture.calls.push({discovery:id});return {success:false,error:{message:"清单暂时不可用"}}}';
          if (name === 'getServiceKeys') return 'export async function getServiceKeys(){return {success:true,data:globalThis.__providerEditFixture.serviceKeys}}';
          if (name === 'getOrganization') return 'export async function getOrganization(){return {success:true,data:{tenant:{id:"tenant",slug:"sample"},teams:[{id:"team",name:"业务团队",status:"active"}],members:[]}}}';
          if (name === 'createServiceKey') return 'export async function createServiceKey(body){globalThis.__providerEditFixture.calls.push({createKey:body});return {success:false,error:{code:"NETWORK_ERROR",message:"响应丢失"}}}';
          if (name === 'draftAppCallerIntent') return 'export async function draftAppCallerIntent(){globalThis.__providerEditFixture.calls.push({paidIntent:true});throw new Error("不允许真实推导")}';
          if (name === 'createGatewayAppCaller') return 'export async function createGatewayAppCaller(body){globalThis.__providerEditFixture.calls.push({createCaller:body});return globalThis.__providerEditFixture.callerResult??{success:false,error:{code:"VALIDATION_ERROR",message:"登记暂时不可用"}}}';
          if (name === 'getExchangeMeta') return 'export async function getExchangeMeta(){return {success:false,error:{message:"目录未注入"}}}';
          if (name === 'getCallTrace') return 'export async function getCallTrace(){return {success:true,data:globalThis.__providerEditFixture.traceData}}';
          if (name === 'updatePlatform') return 'export async function updatePlatform(id,draft){const f=globalThis.__providerEditFixture;f.calls.push({id,draft});f.providers=f.providers.map(p=>p.id===id?{...p,...draft,platformType:draft.platformType??p.platformType}:p);return {success:true,data:f.providers.find(p=>p.id===id)}}';
          return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
        }).join('\n');
        if (id.endsWith('/src/lib/auth.tsx')) return 'export function useAuth(){return {tenant:{id:"tenant",role:globalThis.__providerEditFixture.role,teamIds:["team"]}}}';
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
    // 管理启用不代表实时健康；历史依据和下一步无需悬停。
    assert.ok(firstRow.querySelector('time'), '历史调用必须在页面直接显示时间依据');
    assert.equal(document.querySelector('.lg-collection-list [aria-label="清单数量"]').textContent, '共 12 项');
    assert.ok(firstRow.textContent.includes('管理：已启用'));
    assert.ok(firstRow.textContent.includes('余额或额度不足'));
    assert.ok(firstRow.querySelector('time'));
    assert.ok(firstRow.textContent.includes('配置更新前的记录'));
    assert.ok(firstRow.textContent.includes('历史结果，非实时余额'));
    assert.equal(firstRow.querySelector('a[href*="logs"]').textContent, '查看失败请求');
    assert.ok(firstRow.querySelector('a[href*="logs"]').href.includes('status=failed'));
    assert.ok(document.querySelectorAll('.lg-collection-provider-row')[1].textContent.includes('调用时间未知'));
    assert.ok(document.querySelectorAll('.lg-collection-provider-row')[2].textContent.includes('暂无近期调用'));
    assert.equal(button('查看模型', firstRow), undefined);
    assert.equal(fixture.calls.length, 0, '查看本地清单不能自动访问供应方');
    await click(button('发现并导入模型', firstRow));
    assert.deepEqual(fixture.calls.pop(), { discovery: 'p0' });
    assert.ok(document.body.textContent.includes('清单暂时不可用'));
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
    assert.equal(document.querySelector('.lg-collection-list [aria-label="清单数量"]').textContent, '0 / 12 项');
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
    fixture.models = [{id:'m0',platformId:'p0',modelName:'stopped-model',name:'stopped-model',enabled:false}];
    fixture.logicalModels = [{id:'lm0',publicId:'public-stopped',name:'public-stopped',modelType:'chat',enabled:false,defaultForAppCallerCodes:[],allowedAppCallerCodes:[],offerings:[{targetKind:'model',targetId:'m0',enabled:false}]}];
    await mount();
    await click(document.querySelector('.lg-collection-provider-row td:nth-child(2) button'));
    const associatedRow = document.querySelector('.lg-collection-owned-table tbody tr');
    assert.ok(associatedRow.textContent.includes('已停用'), '本地物理模型停用状态不能被关联成功掩盖');
    assert.ok(associatedRow.textContent.includes('已关联'));
    assert.equal(associatedRow.textContent.includes('可调用'), false, '关联不等于线路启用或当前可调用');
    await act(async () => root.unmount());
    root = null;
    fixture.models = [];
    fixture.logicalModels = [];
    fixture.providers = fixture.providers.slice(0, 2);
    fixture.modelsFailure = true;
    await mount();
    assert.equal(document.querySelector('.lg-collection-list [aria-label="清单数量"]').textContent, '共 2 项');
    assert.equal(document.querySelector('.lg-collection-list .lg-collection-pagination'), null, '两条数据不应提供无效翻页');
    assert.ok(document.querySelector('.lg-collection-list .lg-collection-short'));
    assert.ok(document.querySelector('.lg-collection-provider-row').textContent.includes('模型信息加载失败'));
    assert.equal(document.querySelector('.lg-collection-provider-row').textContent.includes('尚未接入模型'), false);
    await click(document.querySelector('.lg-collection-provider-row td:nth-child(2) button'));
    assert.ok(document.querySelector('.lg-collection-pane').textContent.includes('接入数量与关联状态未知'));
    fixture.modelsFailure = false;
    await click(button('重新加载'));
    assert.ok(document.querySelector('.lg-collection-pane').textContent.includes('尚未接入模型'));
    await act(async () => root.unmount());
    root = null;
    fixture.appCallers = [{id:'ac0',appCallerCode:'app.summary::chat',requestType:'chat',status:'discovered',title:'摘要',sourceSystem:'MAP',totalSeen:2,observedIngressProtocols:[],allowedModelPoolIds:[]}];
    const defaultModel = {id:'lm-chat',publicId:'public-chat',name:'摘要默认模型',capabilities:[],routingStrategy:'priority',modelType:'chat',enabled:true,displayOrder:0,isDefaultForType:true,defaultForAppCallerCodes:[],allowedAppCallerCodes:[],offerings:[]};
    fixture.logicalModels = [defaultModel, {...defaultModel,id:'lm-image',publicId:'public-image',name:'图片模型',modelType:'generation'}];
    fixture.callersThrow=true;
    const { AppCallersPage } = await server.ssrLoadModule('/src/pages/AppCallersPage.tsx');
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(MemoryRouter, {initialEntries:['/app-callers?search=summary&page=2']}, React.createElement(AppCallersPage))));
    assert.ok(document.body.textContent.includes('调用方读取未完成'));
    await click(button('重新读取'));
    assert.ok(button('重新读取'), '重读body reject后仍能恢复，不停在loading');
    fixture.callersThrow=false;
    await click(button('重新读取'));
    assert.ok(document.querySelector('.lg-app-caller-table-wrap, .lg-app-caller-page').textContent.includes('摘要默认模型'));
    assert.ok(document.body.textContent.includes('沿用用途默认'));
    assert.ok(document.querySelector('.lg-app-caller-table-wrap tbody tr td:nth-child(2)').textContent.includes('允许调用'));
    assert.equal(document.querySelector('.lg-app-caller-table-wrap tbody tr td:nth-child(2)').textContent.includes('待配置'),false,'自动发现不等于禁止调用');
    const handoff = [...document.querySelectorAll('a')].find(a => a.textContent === '查看默认模型');
    assert.ok(handoff);
    const destination = handoff.getAttribute('href');
    assert.ok(destination.startsWith('/logical-models?'));
    assert.equal(fixture.calls.length, 1, '默认配置查看不能自动写入');
    await act(async () => root.unmount());
    root = null;
    const { LogicalModelsPage } = await server.ssrLoadModule('/src/pages/LogicalModelsPage.tsx');
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(MemoryRouter, {initialEntries:[destination]}, React.createElement(LogicalModelsPage))));
    const context = document.querySelector('[aria-label="调用方模型上下文"]');
    assert.ok(context.textContent.includes('app.summary::chat'));
    assert.ok(context.textContent.includes('显式指定模型的请求不变'));
    assert.ok(document.querySelector('.lg-collection-pane').textContent.includes('摘要默认模型'));
    assert.equal(document.querySelector('.lg-logical-model-list').textContent.includes('图片模型'), false);
    const returnUrl = new URL(context.querySelector('a').href);
    assert.equal(returnUrl.searchParams.get('search'), 'summary');
    assert.equal(returnUrl.searchParams.get('page'), '2');
    assert.equal(returnUrl.searchParams.get('focus'), 'app.summary::chat');
    assert.equal(returnUrl.searchParams.get('focusType'), 'chat');
    assert.equal(button('指定调用方'), undefined, 'viewer 查看上下文不获得配置权限');
    await act(async () => root.unmount());
    root = null;
    fixture.role='owner';
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(MemoryRouter, {initialEntries:[destination]}, React.createElement(LogicalModelsPage))));
    assert.equal(button('选择已停用'),undefined,'调用方上下文不提供全目录批选');
    assert.equal(document.querySelector('.lg-logical-model-list input[type="checkbox"]'),null,'上下文不留无后续动作的批选控件');
    await act(async () => root.unmount());
    root = null;
    fixture.role='viewer';
    fixture.appCallers = [{...fixture.appCallers[0],id:'ac-vision',requestType:'vision',title:'同码图片理解'},fixture.appCallers[0]];
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(MemoryRouter, {initialEntries:[returnUrl.pathname+returnUrl.search]}, React.createElement(AppCallersPage))));
    const focusedRow = document.querySelector('.lg-app-caller-expanded-row').previousElementSibling;
    assert.ok(focusedRow.textContent.includes('文字对话'),'返回按同码+chat展开正确记录');
    assert.equal(focusedRow.textContent.includes('同码图片理解'),false);
    await act(async () => root.unmount());
    root = null;
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(MemoryRouter, {initialEntries:['/logical-models?publicId=public-image']}, React.createElement(LogicalModelsPage))));
    assert.ok(document.querySelector('.lg-collection-pane').textContent.includes('图片模型'), '上游模型创建后的公开标识深链必须真正定位配置');
    await act(async () => root.unmount());
    root = null;
    fixture.logicalReadThrow=true;
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(MemoryRouter, {initialEntries:['/logical-models']}, React.createElement(LogicalModelsPage))));
    assert.ok(document.body.textContent.includes('模型目录读取未完成'));
    assert.equal(document.body.textContent.includes('尚无逻辑模型'),false,'目录读取失败不能冒充空目录');
    fixture.logicalReadThrow=false;await click(button('重新读取'));
    assert.ok(document.querySelector('.lg-logical-model-list'));
    await act(async () => root.unmount());root=null;
    const originalCallers=fixture.appCallers;
    fixture.appCallers=[];
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(MemoryRouter, {initialEntries:[returnUrl.pathname+returnUrl.search]}, React.createElement(AppCallersPage))));
    assert.equal(document.querySelector('input[aria-label="搜索 appCaller"]').value,'summary','找不到原记录不自动清除原筛选');
    assert.ok(document.body.textContent.includes('当前未找到'));
    fixture.appCallers=originalCallers;
    await click(button('按此身份查找（切换筛选）'));
    assert.equal(fixture.callerReads.at(-1).search,'app.summary::chat');
    assert.equal(fixture.callerReads.at(-1).requestType,'chat');
    assert.ok(document.querySelector('.lg-app-caller-expanded-row').previousElementSibling.textContent.includes('文字对话'));
    await click(button('恢复原筛选'));
    assert.equal(document.querySelector('input[aria-label="搜索 appCaller"]').value,'summary');
    await act(async () => root.unmount());
    root = null;
    const { Card } = await server.ssrLoadModule('/src/components/ui.tsx');
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(Card, {'aria-labelledby':'test-card-heading',id:'test-card'},React.createElement('h2',{id:'test-card-heading'},'用量摘要'))));
    assert.equal(document.getElementById('test-card').getAttribute('aria-labelledby'),'test-card-heading','共享Card不能吞掉实际DOM可达性属性');
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
