import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('真实表单从网关用途目录创建TTS、绑定已有Exchange并编辑读回，目录失败时阻止新建', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/logical-models' });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Event', 'MouseEvent'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const { createRoot } = await import('react-dom/client');
  const router = await import('react-router-dom');
  globalThis.__logicalSpeechRouter = { ...router.default, ...router };
  const fixture = { metadataAvailable: true, items: [], calls: [], reads: 0, models: [], platforms: [{id:"provider-official",name:"官方上游",authority:"llm_gateway",enabled:true}], platformsAvailable:true,
    modelTypes: ['generation', 'vision', 'chat', 'code', 'video-gen', 'asr', 'tts', 'embedding', 'audio-gen', 'long-context'],
    exchange: { id: 'existing-speech-exchange', name: '已有豆包TTS', authority: 'llm_gateway', enabled: true,
      models: [{ modelId: 'doubao-tts-1.0', modelType: 'tts', enabled: true }] },
  };
  globalThis.__logicalSpeechFixture = fixture;
  const api = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const apiNames = [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]);
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] }, ssr: { noExternal: ['react-router-dom'] },
    plugins: [{ name: 'logical-speech-fixture', enforce: 'pre',
      resolveId(id) { if (id === 'react-router-dom') return '\0logical-speech-router'; },
      load(id) {
        if (id === '\0logical-speech-router') return Object.keys(globalThis.__logicalSpeechRouter).filter(name => name !== 'default').map(name => `export const ${name}=globalThis.__logicalSpeechRouter.${name};`).join('\n');
        if (id.endsWith('/src/lib/auth.tsx')) return 'export function useAuth(){return {tenant:{role:"admin"}}}';
        if (id.endsWith('/src/components/ConfirmDialog.tsx')) return 'export function useDialogs(){return {confirm:async()=>false,promptText:async options=>options.requireExact??null}}';
        if (id.endsWith('/src/lib/api.ts')) return apiNames.map(name => {
          if (name === 'getLogicalModels') return 'export async function getLogicalModels(){const f=globalThis.__logicalSpeechFixture;f.reads++;if(f.failNextRead){f.failNextRead=false;return {success:false,error:{message:"队列读取失败"}}}return {success:true,data:{items:f.requeue?f.requeue():f.items}}}';
          if (name === 'getExchanges') return 'export async function getExchanges(){return {success:true,data:{items:[globalThis.__logicalSpeechFixture.exchange]}}}';
          if (name === 'getExchangeMeta') return 'export async function getExchangeMeta(){const f=globalThis.__logicalSpeechFixture;return f.metadataAvailable?{success:true,data:{modelTypes:f.modelTypes.map(value=>({value,label:value==="tts"?"语音合成":value}))}}:{success:false,error:{message:"unavailable"}}}';
          if (name === 'getPlatforms') return 'export async function getPlatforms(){const f=globalThis.__logicalSpeechFixture;return f.platformsAvailable?{success:true,data:{items:f.platforms}}:{success:false,error:{message:"平台清单不可用"}}}';
          if (name === 'getModels') return 'export async function getModels(){return {success:true,data:{items:globalThis.__logicalSpeechFixture.models}}}';
          if (name === 'getUpstreamModels') return 'export async function getUpstreamModels(){return {success:true,data:{items:[{modelId:"future-text-v9",inCatalog:true,priceCurrency:"USD"}]}}}';
          if (name === 'importUpstreamModels') return 'export async function importUpstreamModels(id,models,options){const f=globalThis.__logicalSpeechFixture;f.calls.push({operation:"import",id,models,options});f.models=[{id:"future-physical",modelName:models[0].modelId,platformId:id,authority:"llm_gateway",enabled:true}];return {success:true,data:{createdModelIds:["future-physical"]}}}';
          if (name === 'createLogicalModel') return 'export async function createLogicalModel(draft){const f=globalThis.__logicalSpeechFixture;f.calls.push({operation:"create",draft});const item={...draft,id:"logical-tts",enabled:true,isDefaultForType:false,defaultForAppCallerCodes:[],offerings:[]};f.items=[item];return {success:true,data:item}}';
          if (name === 'createModelOffering') return 'export async function createModelOffering(id,draft){const f=globalThis.__logicalSpeechFixture;f.calls.push({operation:"offering",id,draft});const item={...draft,id:f.nextOfferingId||"offering-tts",enabled:true,targetUsable:true,targetName:f.exchange.name,providerName:f.platforms.find(p=>p.id===f.models.find(m=>m.id===draft.targetId)?.platformId)?.name,healthStatus:0};f.offering=item;f.items=f.items.map(x=>x.id===id?{...x,offerings:[...x.offerings,item]}:x);return {success:true,data:item}}';
          if (name === 'updateModelOffering') return 'export async function updateModelOffering(id,offeringId,draft){const f=globalThis.__logicalSpeechFixture;f.calls.push({operation:"edit",id,offeringId,draft});const item={...f.items.find(x=>x.id===id).offerings.find(o=>o.id===offeringId),...draft,id:offeringId,targetUsable:true,targetName:f.exchange.name};f.offering=item;f.items=f.items.map(x=>x.id===id?{...x,offerings:x.offerings.map(o=>o.id===offeringId?item:o)}:x);return {success:true,data:item}}';
          if (name === 'setModelOfferingEnabled') return 'export async function setModelOfferingEnabled(id,offeringId,enabled){const f=globalThis.__logicalSpeechFixture;f.calls.push({operation:"toggle",id,offeringId,enabled});f.offering={...f.items.find(x=>x.id===id).offerings.find(o=>o.id===offeringId),enabled,queuePosition:null,skipReason:enabled?null:"手动停用"};f.items=f.items.map(x=>x.id===id?{...x,offerings:x.offerings.map(o=>o.id===offeringId?f.offering:o)}:x);return {success:true,data:f.offering}}';
          if (name === 'recoverModelOffering') return 'export async function recoverModelOffering(id,offeringId){const f=globalThis.__logicalSpeechFixture;f.calls.push({operation:"recover",id,offeringId});f.items=f.items.map(x=>x.id===id?{...x,offerings:x.offerings.map(o=>o.id===offeringId?{...o,healthStatus:0,skipReason:null}:o)}:x);return {success:true,data:{offeringId,halfOpenPending:true}}}';
          if (name === 'deleteModelOffering') return 'export async function deleteModelOffering(id,offeringId){const f=globalThis.__logicalSpeechFixture;f.calls.push({operation:"remove",id,offeringId});if(f.rejectRemove)return {success:false,error:{message:"替代线路未验证，拒绝移除"}};f.items=f.items.map(x=>x.id===id?{...x,offerings:x.offerings.filter(o=>o.id!==offeringId)}:x);return {success:true,data:{offeringId}}}';
          return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
        }).join('\n');
      },
    }],
  });
  let root;
  const button = text => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text);
  const click = async text => { assert.ok(button(text), `缺少按钮 ${text}`); await act(async () => button(text).click()); };
  const field = (label, selector = 'input') => [...document.querySelectorAll('label')].find(item => item.textContent.trim().startsWith(label))?.querySelector(selector);
  const fill = async (element, value) => {
    assert.ok(element, '缺少表单字段');
    await act(async () => {
      const prototype = element.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    });
  };
  try {
    const { LogicalModelsPage } = await server.ssrLoadModule('/src/pages/LogicalModelsPage.tsx');
    root = createRoot(document.getElementById('root'));
    const render = async key => act(async () => root.render(React.createElement(globalThis.__logicalSpeechRouter.MemoryRouter, {}, React.createElement(LogicalModelsPage, { key }))));
    await render('create');
    await click('新建模型');
    const types = field('模型用途', 'select');
    assert.deepEqual([...types.options].map(option => option.value), fixture.modelTypes);
    await fill(types, 'tts');
    assert.equal(field('能力，逗号分隔').value, '', 'TTS不能继承默认生图能力');
    await fill(field('能力，逗号分隔'), 'custom_capability');
    await fill(types, 'asr');
    assert.equal(field('能力，逗号分隔').value, 'custom_capability', '切换用途应保留用户自定义能力');
    await fill(types, 'tts');
    await fill(field('能力，逗号分隔'), 'tts');
    await fill(field('公开标识'), 'doubao-tts-1.0');
    await fill(field('模型名称'), '豆包语音');
    await fill(field('允许的 appCaller'), 'mcp-speech.synthesize::tts');
    await click('创建并绑定上游');
    assert.equal(fixture.calls[0].draft.modelType, 'tts');
    assert.deepEqual(fixture.calls[0].draft.capabilities, ['tts']);
    assert.deepEqual(fixture.calls[0].draft.allowedAppCallerCodes, ['mcp-speech.synthesize::tts']);
    assert.equal(fixture.calls[0].draft.isDefaultForType, undefined);
    await fill(field('上游类型', 'select'), 'exchange');
    assert.ok([...field('上游及实际型号', 'select').options].some(option => option.value === fixture.exchange.id));
    await fill(field('上游及实际型号', 'select'), fixture.exchange.id);
    await fill(field('上游模型标识'), 'doubao-tts-1.0');
    await click('保存绑定');
    assert.equal(fixture.calls[1].draft.targetId, fixture.exchange.id);
    assert.equal(fixture.calls[1].draft.targetKind, 'exchange');
    assert.equal(fixture.calls[1].draft.upstreamModelId, 'doubao-tts-1.0');
    await click('编辑');
    assert.equal(field('上游模型标识').value, 'doubao-tts-1.0');
    assert.equal(field('上游及实际型号', 'select').value, fixture.exchange.id);
    await click('保存修改');
    assert.equal(fixture.calls[2].draft.upstreamModelId, 'doubao-tts-1.0');
    assert.equal(fixture.items[0].modelType, 'tts');
    fixture.metadataAvailable = false;
    await render('unavailable');
    assert.match(document.body.textContent, /豆包语音/);
    await click('新建模型');
    assert.equal(field('模型用途', 'select').disabled, true);
    assert.equal(button('创建并绑定上游').disabled, true);
    assert.match(document.body.textContent, /用途目录暂不可用/);
    assert.equal(fixture.calls.length, 3, '元数据失败不能回退为旧用途表或发起创建');
    fixture.metadataAvailable = true;
    await render('from-provider'); await click('新建模型'); await click('从上游登记');
    await fill(field('选择上游', 'select'), 'platform:provider-official');
    await click('读取上游型号');
    await fill(field('模型名称'), '我命名的未来模型'); await fill(field('公开标识'), 'my-future-model');
    await fill(field('上游实际型号'), 'future-text-v9'); await fill(field('模型用途', 'select'), 'chat');
    await click('登记并绑定上游');
    const imported = fixture.calls.find(call => call.operation === 'import');
    assert.deepEqual(imported.options, { publishToWhitelist: false }, '登记物理型号不能额外自动创建同名公开模型');
    const created = fixture.calls.filter(call => call.operation === 'create').at(-1);
    assert.equal(created.draft.name, '我命名的未来模型'); assert.equal(created.draft.publicId, 'my-future-model');
    const bound = fixture.calls.filter(call => call.operation === 'offering').at(-1);
    assert.equal(bound.draft.targetId, 'future-physical'); assert.equal(bound.draft.upstreamModelId, 'future-text-v9');
    assert.ok(document.body.textContent.includes('我命名的未来模型'), '同一入口创建并回到模型列表');
    const sample = fixture.items[0];
    fixture.items = Array.from({ length: 43 }, (_, index) => ({ ...sample, id: `continuous-${index}`, name: `连续模型${index}`, publicId: `continuous-model-${index}`, offerings: [] }));
    await render('continuous');
    assert.equal(document.querySelectorAll('.lg-logical-model-grid:not(.lg-logical-model-heading)').length, 20);
    await click('继续加载 · 已显示 20 / 43'); await click('继续加载 · 已显示 40 / 43');
    assert.equal(document.querySelectorAll('.lg-logical-model-grid:not(.lg-logical-model-heading)').length, 43);
    assert.equal(button('下一页'), undefined, '模型主列表不应保留翻页栏');
    await fill(document.querySelector('[aria-label="搜索模型名称或公开标识"]'), 'continuous-model-42');
    assert.equal(document.querySelectorAll('.lg-logical-model-grid:not(.lg-logical-model-heading)').length, 1);
    assert.match(document.body.textContent, /连续模型42/);


    // 真实回归：写接口只返回改动线路，GET 返回完整的权威排队结果。
    fixture.metadataAvailable = true;
    fixture.platforms = [{ id: 'apiyi-provider', name: 'APIyi', authority:'llm_gateway',enabled:true }, { id: 'openai-provider', name: 'OpenAI', authority:'llm_gateway',enabled:true }, { id: 'third-provider', name: '第三官网', authority:'llm_gateway',enabled:true }];
    fixture.models = fixture.platforms.map((platform, index) => ({ id: `physical-${index}`, name: 'gpt-5.6-sol', modelName: 'gpt-5.6-sol', platformId: platform.id, authority: 'llm_gateway', enabled: true }));
    const route = (id, index, priority) => ({ id, targetKind: 'model', targetId: `physical-${index}`, providerName: fixture.platforms[index].name, upstreamModelId: 'gpt-5.6-sol', protocol: 'openai', priority, weight: 100, enabled: true, targetUsable: true, healthStatus: 0, queuePosition: index + 1, skipReason: null });
    fixture.items = [{ ...fixture.items[0], name: '日光', publicId: 'gpt-5.6-sol', modelType: 'chat', capabilities: ['chat'], routingStrategy: 'priority', offerings: [route('primary', 0, 100), route('backup', 1, 200)] }];
    fixture.requeue = () => fixture.items.map(item => {
      const queued = item.offerings.filter(offering => offering.enabled && offering.healthStatus !== 2).sort((a, b) => a.priority - b.priority);
      return { ...item, offerings: item.offerings.map(offering => ({ ...offering, queuePosition: queued.findIndex(candidate => candidate.id === offering.id) >= 0 ? queued.findIndex(candidate => candidate.id === offering.id) + 1 : null, skipReason: !offering.enabled ? '手动停用' : offering.healthStatus === 2 ? '熔断' : null })) };
    });
    const routeCard = provider => [...document.querySelectorAll('.lg-logical-model-route-detail')].find(element => element.textContent.includes(provider));
    const routeAction = (provider, text) => [...routeCard(provider).querySelectorAll('button')].find(element => element.textContent.trim() === text);
    const clickRoute = async (provider, text) => { const element = routeAction(provider, text); assert.ok(element); await act(async () => element.click()); };
    const roleLabel = provider => routeCard(provider).querySelector('.lg-collection-route-heading').textContent;
    await render('queue');
    await click('查看');
    assert.match(roleLabel('APIyi'), /主$/);
    assert.match(roleLabel('OpenAI'), /备$/);
    await click('添加上游');
    const options = [...field('上游及实际型号', 'select').options];
    assert.ok(options.some(option => option.value === 'physical-0' && option.textContent.includes('APIyi')));
    assert.ok(options.some(option => option.value === 'physical-1' && option.textContent.includes('OpenAI')));
    await click('添加上游');
    let reads = fixture.reads;
    await clickRoute('APIyi', '停用');
    assert.equal(fixture.reads, ++reads);
    assert.match(roleLabel('OpenAI'), /主$/, '主线停用后备线立即显示为主，不需手动刷新');
    assert.equal(document.body.textContent.includes('无可用线路'), false);
    await clickRoute('APIyi', '启用');
    assert.equal(fixture.reads, ++reads);
    assert.match(roleLabel('APIyi'), /主$/);
    await clickRoute('OpenAI', '编辑');
    await fill(field('优先级'), '50');
    await click('保存修改');
    assert.equal(fixture.reads, ++reads);
    assert.match(roleLabel('OpenAI'), /主$/, '编辑优先级后所有兄弟线路角色同步更新');
    fixture.nextOfferingId = 'third';
    await click('添加上游');
    await fill(field('上游及实际型号', 'select'), 'physical-2');
    await fill(field('优先级'), '25');
    await click('保存绑定');
    assert.equal(fixture.reads, ++reads);
    assert.match(roleLabel('第三官网'), /主$/, '新增优先级更高的线路后服务端排队生效');
    await clickRoute('APIyi', '停用');
    assert.equal(fixture.reads, ++reads);
    await clickRoute('APIyi', '删除线路');
    assert.equal(fixture.reads, ++reads);
    assert.equal(routeCard('APIyi'), undefined);
    assert.match(roleLabel('第三官网'), /主$/);
    fixture.items[0].offerings = fixture.items[0].offerings.map(offering => offering.id === 'backup' ? { ...offering, healthStatus: 2 } : offering);
    await render('recover');
    await click('查看');
    reads = fixture.reads;
    await clickRoute('OpenAI', '手动恢复');
    assert.equal(fixture.reads, ++reads);
    assert.match(roleLabel('OpenAI'), /备$/);
    fixture.failNextRead = true;
    await clickRoute('第三官网', '停用');
    assert.equal(document.querySelector('.lg-logical-model-route-detail'), null, '权威读取失败时不继续显示旧主备判断');
    assert.match(document.body.textContent, /上游变更已保存，但最新线路状态未读取成功/);
    await click('刷新线路状态');
    assert.match(roleLabel('OpenAI'), /主$/);
    assert.equal(document.body.textContent.includes('最新线路状态未读取成功'), false);
    fixture.platformsAvailable = false;
    await render('platform-name-unavailable');
    await click('查看');
    await click('添加上游');
    const fallbackOptions = [...field('上游及实际型号', 'select').options];
    assert.ok(fallbackOptions.some(option => option.value === 'physical-0' && option.textContent.includes('apiyi-pr')));
    assert.ok(fallbackOptions.some(option => option.value === 'physical-1' && option.textContent.includes('openai-p')));
    assert.equal(field('上游及实际型号', 'select').disabled, false, '平台名称读取失败不能阻断选择模型');
  } finally {
    if (root) await act(async () => root.unmount());
    await server.close();
    dom.window.close();
    for (const name of names) globalThis[name] = previous[name];
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
    delete globalThis.__logicalSpeechFixture;
    delete globalThis.__logicalSpeechRouter;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
