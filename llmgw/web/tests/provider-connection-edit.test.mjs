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
          if (name === 'getPlatforms') return 'export async function getPlatforms(){return {success:true,data:{items:globalThis.__providerEditFixture.providers}}}';
          if (name === 'getModels') return 'export async function getModels(){return globalThis.__providerEditFixture.modelsFailure?{success:false,error:{message:"离线"}}:{success:true,data:{items:globalThis.__providerEditFixture.models}}}';
          if (name === 'getLogicalModels') return 'export async function getLogicalModels(){if(globalThis.__providerEditFixture.logicalReadThrow)throw new Error("body interrupted");return {success:true,data:{items:globalThis.__providerEditFixture.logicalModels}}}';
          if (name === 'getGatewayAppCallers') return 'export async function getGatewayAppCallers(query){const f=globalThis.__providerEditFixture;(f.callerReads??=[]).push(query);if(f.callersThrow)throw new Error("body interrupted");return {success:true,data:{items:globalThis.__providerEditFixture.appCallers,total:1,page:1,pageSize:50,statuses:[],sourceSystems:[],ingressProtocols:[],requestTypes:[]}}}';
          if (name === 'getUpstreamModels') return 'export async function getUpstreamModels(id){globalThis.__providerEditFixture.calls.push({discovery:id});return {success:false,error:{message:"清单暂时不可用"}}}';
          if (name === 'getServiceKeys') return 'export async function getServiceKeys(){if(globalThis.__providerEditFixture.keysThrow)throw new Error("body interrupted");return {success:true,data:globalThis.__providerEditFixture.serviceKeys}}';
          if (name === 'getOrganization') return 'export async function getOrganization(){return {success:true,data:{tenant:{id:"tenant",slug:"sample"},teams:[{id:"team",name:"业务团队",status:"active"}],members:[]}}}';
          if (name === 'updateGatewayAppCaller') return 'export async function updateGatewayAppCaller(id,body){const f=globalThis.__providerEditFixture;f.calls.push({governance:{id,body}});return f.governanceResult??{success:true,data:{id,...body}}}';
          if (name === 'createServiceKey') return 'export async function createServiceKey(body){globalThis.__providerEditFixture.calls.push({createKey:body});return globalThis.__providerEditFixture.keyResult??{success:false,error:{code:"UNEXPECTED_ISSUANCE_FAILURE",message:"响应丢失"}}}';
          if (name === 'draftAppCallerIntent') return 'export async function draftAppCallerIntent(){globalThis.__providerEditFixture.calls.push({paidIntent:true});throw new Error("不允许真实推导")}';
          if (name === 'createGatewayAppCaller') return 'export async function createGatewayAppCaller(body){globalThis.__providerEditFixture.calls.push({createCaller:body});return globalThis.__providerEditFixture.callerResult??{success:false,error:{code:"INVALID_INPUT",message:"登记请求不符合要求"}}}';
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
    assert.equal(firstRow.querySelector('[aria-label="管理状态：已启用"]').textContent, '已启用');
    assert.ok(firstRow.textContent.includes('余额或额度不足'));
    assert.ok(firstRow.querySelector('time'));
    assert.ok(firstRow.textContent.includes('配置更新前的记录'));
    assert.ok(firstRow.textContent.includes('历史结果，非实时余额'));
    assert.equal(firstRow.querySelector('a[href*="logs"]').textContent, '查看失败请求');
    assert.ok(firstRow.querySelector('a[href*="logs"]').href.includes('status=failed'));
    assert.ok(document.querySelectorAll('.lg-collection-provider-row')[1].textContent.includes('调用时间未知'));
    assert.ok(document.querySelectorAll('.lg-collection-provider-row')[2].textContent.includes('当前配置近 7 天无调用'));
    assert.equal(button('查看模型', firstRow), undefined);
    assert.equal(fixture.calls.length, 0, '查看本地清单不能自动访问供应方');
    await click(button('导入模型', firstRow));
    assert.deepEqual(fixture.calls.pop(), { discovery: 'p0' });
    assert.ok(document.body.textContent.includes('清单暂时不可用'));
    await click(firstRow.querySelector('td:nth-child(2) button'));
    await click(button('连接配置'));
    // 详情独立于分页：选中项不在当前父列表页，也能编辑。
    await click(button('下一页', document.querySelector('.lg-collection-list')));
    assert.equal(document.querySelector('.lg-collection-list').textContent.includes('上游 0'), false);
    await click(button('编辑连接'));
    assert.ok(document.querySelector('.lg-collection-pane input[aria-label="平台名称"]'));
    assert.equal(document.querySelector('.lg-collection-pane .lg-collection-facts'), null, '编辑态替换只读事实，不将表单追加在十项事实之后');
    assert.equal(document.activeElement.getAttribute('aria-label'), '平台名称', '编辑从首字段开始键盘操作');

    assert.equal(document.querySelector('.lg-collection-list input[aria-label="平台名称"]'), null);
    await click(button('取消', document.querySelector('.lg-collection-pane')));
    assert.equal(document.activeElement.textContent.trim(), '编辑连接', '取消后回原维护入口');
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
    const key = {name:'有效钥',id:'k0',keyPrefix:'gwk_x',enabled:true,sourceSystem:'external',clientCode:'app',environment:'test',purpose:'external-platform',appCallerCodes:['app.summary::chat'],ingressProtocols:['openai-compatible'],scopes:['invoke'],allowedCidrs:[],rotationState:'active'};
    fixture.serviceKeys = [key,{...key,id:'k1',name:'已过期钥',expiresAt:'2001-01-01T00:00:00Z'},{...key,id:'k2',name:'已撤销钥',enabled:false}];
    fixture.keysThrow=true;
    const { ServiceKeysPage } = await server.ssrLoadModule('/src/pages/ServiceKeysPage.tsx');
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(MemoryRouter, {}, React.createElement(ServiceKeysPage))));
    assert.ok(document.body.textContent.includes('密钥配置读取未完成'));assert.equal(document.body.textContent.includes('正在加载接入密钥'),false,'读取中断不能一直宣称加载中');fixture.keysThrow=false;await click(button('重新读取'));
    assert.equal(document.querySelector('.lg-key-coverage'),null,'外部租户不应看到内部MAP生产用途覆盖');
    const keyFilter = document.querySelector('[aria-label="清单状态筛选"]');
    assert.equal(keyFilter.value,'active','优先维护有效密钥，历史仍可查');
    await act(async () => { keyFilter.value=''; keyFilter.dispatchEvent(new dom.window.Event('change',{bubbles:true})); });
    const expiredRow = [...document.querySelectorAll('tr')].find(row => row.textContent.includes('已过期钥'));
    assert.ok(expiredRow.textContent.includes('已过期'));
    assert.equal(expiredRow.querySelector('.lg-collection-key-status').textContent.includes('有效'), false);
    await act(async () => { keyFilter.value='active'; keyFilter.dispatchEvent(new dom.window.Event('change',{bubbles:true})); });
    assert.equal(document.querySelector('.lg-collection-list').textContent.includes('已过期钥'), false);
    assert.equal(document.querySelector('.lg-collection-list').textContent.includes('已撤销钥'), false);
    await act(async () => root.unmount());
    root = null;
    fixture.role='owner';
    const { QuickstartPage } = await server.ssrLoadModule('/src/pages/QuickstartPage.tsx');
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(MemoryRouter, {}, React.createElement(QuickstartPage))));
    assert.equal(document.querySelector('textarea[aria-label="我想做什么"]'), null, '拿密钥默认不经过意图推导');
    assert.equal(button('创建密钥').disabled, true);assert.ok(document.body.textContent.includes('留空保留已登记用途的预算；新用途不设限额。'));
    await input(document.querySelector('input[placeholder="例如 my-application"]'),'my_application');assert.ok(document.body.textContent.includes('使用字母开头的英文段'));assert.equal(button('创建密钥').disabled,true);await input(document.querySelector('input[placeholder="例如 my-application"]'),'my.application');
    const purpose = document.querySelector('select[aria-label="调用用途"]');
    await act(async () => { purpose.value=purpose.options[1].value; purpose.dispatchEvent(new dom.window.Event('change',{bubbles:true})); });
    assert.equal(button('创建密钥').disabled, false);
    const beforeCreate=fixture.calls.length;
    await act(async () => { button('创建密钥').click(); button('创建密钥')?.click(); });
    assert.equal(fixture.calls.length,beforeCreate+1,'快速重复点击只能登记一次');
    assert.ok(fixture.calls.at(-1).createCaller.appCallerCode.startsWith('my.application.'));
    assert.ok(document.body.textContent.includes('登记请求不符合要求'));
    assert.equal(fixture.calls.some(call=>call.paidIntent),false,'表单填写与签发路径不能自动触发计费推导');
    assert.ok(document.body.textContent.includes('费用由平台承担'));
    fixture.callerResult={success:false,error:{code:'NETWORK_ERROR',message:'响应丢失'}};
    await click(button('创建密钥'));
    const unknownCallerCalls=fixture.calls.length;
    assert.equal(button('创建密钥').disabled,true,'NETWORK_ERROR信封也必须阻断重复登记');
    await click(button('创建密钥'));
    assert.equal(fixture.calls.length,unknownCallerCalls);
    const attemptedCaller=fixture.calls.at(-1).createCaller;
    fixture.appCallers=[{...attemptedCaller,id:'confirmed-caller',status:'active'}];
    await click(button('重新核对'));
    assert.equal(button('创建密钥').disabled,false,'仅在服务端确认调用方身份和团队后恢复下一步');
    fixture.callerResult={success:true,data:fixture.appCallers[0]};
    await click(button('创建密钥'));
    const unknownKeyCalls=fixture.calls.length;
    assert.ok(fixture.calls.at(-1).createKey);
    assert.equal(button('创建密钥').disabled,true,'签发响应丢失不能重复签发');
    await click(button('创建密钥'));
    assert.equal(fixture.calls.length,unknownKeyCalls);
    fixture.serviceKeys=[{...key,clientCode:'my.application',appCallerCodes:[attemptedCaller.appCallerCode]}];
    await click(button('重新核对'));
    assert.ok(document.body.textContent.includes('找到 1 把同用途密钥'));
    assert.equal(button('创建密钥').disabled,true,'读到密钥也不能伪造明文或自动重新签发');
    assert.equal(fixture.calls.length,unknownKeyCalls);
    const recoveryLink=[...document.querySelectorAll('a')].find(a=>a.textContent==='查看同用途接入密钥');
    assert.equal(new URL(recoveryLink.href).searchParams.get('appCaller'),attemptedCaller.appCallerCode);
    const recoveryHref=recoveryLink.getAttribute('href');
    await act(async () => root.unmount());root=null;
    fixture.serviceKeys=[{...key,id:'maybe-new',name:'待核对密钥',clientCode:'my.application',appCallerCodes:[attemptedCaller.appCallerCode]},{...key,id:'unrelated',name:'其它用途密钥'}];
    root=createRoot(document.getElementById('root'));
    await act(async()=>root.render(React.createElement(MemoryRouter,{initialEntries:[recoveryHref]},React.createElement(ServiceKeysPage))));
    assert.equal(document.querySelector('[aria-label="清单状态筛选"]').value,'context');
    assert.ok(document.querySelector('.lg-collection-list').textContent.includes('待核对密钥'));
    assert.equal(document.querySelector('.lg-collection-list').textContent.includes('其它用途密钥'),false,'未知签发核对承接调用方上下文，不要求重新记码找一遍');
    await act(async () => root.unmount());
    root = null;
    fixture.keyResult={success:true,data:{id:'happy-key',keyPrefix:'gwk_fixture',key:'gwk_fixture_only_not_a_real_credential'}};
    fixture.callerResult={success:true,data:{id:'happy-caller'}};
    const safeRequests=[];
    globalThis.fetch=async(url,options)=>{
      const path=new URL(url).pathname;safeRequests.push({path,headers:options.headers});
      if(path==='/gw/v1/resolve')return new Response(JSON.stringify({success:false,error:{code:'MODEL_NOT_AVAILABLE',message:'夹具不提供真实上游'}}),{status:409,headers:{'Content-Type':'application/json'}});
      assert.equal(options.headers['X-Gateway-Dry-Run'],'quickstart','创建后的自动路径仅允许安全验证，不能发真实模型请求');
      return new Response(JSON.stringify({gateway:{upstreamCalled:false,requestId:'fixture-safe-record'}}),{status:200,headers:{'Content-Type':'application/json'}});
    };
    root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(MemoryRouter,{},React.createElement(QuickstartPage))));
    await input(document.querySelector('input[placeholder="例如 my-application"]'),'new-app');
    const happyPurpose=document.querySelector('select[aria-label="调用用途"]');await act(async()=>{happyPurpose.value=happyPurpose.options[1].value;happyPurpose.dispatchEvent(new dom.window.Event('change',{bubbles:true}))});
    await input(document.querySelector('[aria-label="月预算（美元）"]'),'20');
    fixture.governanceResult={success:false,error:{code:'POST_WRITE_FAILURE',message:'保存响应未确认'}};
    const priorKeys=fixture.calls.filter(call=>call.createKey).length;
    await click(button('创建密钥'));
    assert.equal(fixture.calls.filter(call=>call.createKey).length,priorKeys,'预算未知期间不能签发密钥');assert.equal(button('创建密钥').disabled,true);assert.equal(document.querySelector('[aria-label="月预算（美元）"]').disabled,true);
    const pendingCaller=fixture.calls.filter(call=>call.createCaller).at(-1).createCaller;const pendingBudget=fixture.calls.at(-1).governance.body;
    fixture.appCallers=[{...pendingCaller,id:'happy-caller',monthlyBudgetUsd:0,budgetReservationUsd:0}];
    await click(button('重新核对'));assert.equal(button('创建密钥').disabled,true,'预算不一致不能声称已保存');
    fixture.appCallers=[{...pendingCaller,id:'happy-caller',...pendingBudget}];
    await click(button('重新核对'));assert.equal(button('创建密钥').disabled,false);
    const priorGovernance=fixture.calls.filter(call=>call.governance).length;await click(button('创建密钥'));assert.equal(fixture.calls.filter(call=>call.governance).length,priorGovernance,'已确认预算后继续不盲重写预算');
    assert.equal(document.querySelector('.lg-qs-key-value').textContent,'gwk_fixture_only_not_a_real_credential');
    assert.ok(document.body.textContent.includes('未访问上游'));
    assert.ok(button('复制密钥'));
    await click(button('cURL'));
    assert.ok(document.querySelector('pre').textContent.includes('gwk_fixture_only_not_a_real_credential'),'产物中可直接运行的接入片段使用此次签发密钥');
    assert.ok([...document.querySelectorAll('a')].some(a=>a.href.includes('fixture-safe-record')&&a.href.includes('view=physical')&&a.href.includes('openRequest=1')),'安全记录承接到物理视图，不能误导为模型结果');
    assert.ok(safeRequests.length>=2);assert.equal(fixture.calls.some(call=>call.paidIntent),false);
    await act(async()=>root.unmount());root=null;globalThis.fetch=originalFetch;
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
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const name of names) globalThis[name] = previous[name];
    delete globalThis.__providerEditFixture;
    delete globalThis.__providerRouterModule;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
