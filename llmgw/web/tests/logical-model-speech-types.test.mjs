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
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const { createRoot } = await import('react-dom/client');
  const router = await import('react-router-dom');
  globalThis.__logicalSpeechRouter = { ...router.default, ...router };
  const fixture = { metadataAvailable: true, items: [], calls: [],
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
        if (id.endsWith('/src/components/ConfirmDialog.tsx')) return 'export function useDialogs(){return {confirm:async()=>false,promptText:async()=>null}}';
        if (id.endsWith('/src/lib/api.ts')) return apiNames.map(name => {
          if (name === 'getLogicalModels') return 'export async function getLogicalModels(){return {success:true,data:{items:globalThis.__logicalSpeechFixture.items}}}';
          if (name === 'getExchanges') return 'export async function getExchanges(){return {success:true,data:{items:[globalThis.__logicalSpeechFixture.exchange]}}}';
          if (name === 'getExchangeMeta') return 'export async function getExchangeMeta(){const f=globalThis.__logicalSpeechFixture;return f.metadataAvailable?{success:true,data:{modelTypes:f.modelTypes.map(value=>({value,label:value==="tts"?"语音合成":value}))}}:{success:false,error:{message:"unavailable"}}}';
          if (name === 'createLogicalModel') return 'export async function createLogicalModel(draft){const f=globalThis.__logicalSpeechFixture;f.calls.push({operation:"create",draft});const item={...draft,id:"logical-tts",enabled:true,isDefaultForType:false,defaultForAppCallerCodes:[],offerings:[]};f.items=[item];return {success:true,data:item}}';
          if (name === 'createModelOffering') return 'export async function createModelOffering(id,draft){const f=globalThis.__logicalSpeechFixture;f.calls.push({operation:"offering",id,draft});const item={...draft,id:"offering-tts",enabled:true,targetUsable:true,targetName:f.exchange.name,healthStatus:0};return {success:true,data:item}}';
          if (name === 'updateModelOffering') return 'export async function updateModelOffering(id,offeringId,draft){const f=globalThis.__logicalSpeechFixture;f.calls.push({operation:"edit",id,offeringId,draft});return {success:true,data:{...draft,id:offeringId,enabled:true,targetUsable:true,targetName:f.exchange.name,healthStatus:0}}}';
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
    await click('手动新建');
    const types = field('模型类型', 'select');
    assert.deepEqual([...types.options].map(option => option.value), fixture.modelTypes);
    await fill(types, 'tts');
    assert.equal(field('能力，逗号分隔').value, '', 'TTS不能继承默认生图能力');
    await fill(field('能力，逗号分隔'), 'custom_capability');
    await fill(types, 'asr');
    assert.equal(field('能力，逗号分隔').value, 'custom_capability', '切换用途应保留用户自定义能力');
    await fill(types, 'tts');
    await fill(field('能力，逗号分隔'), 'tts');
    await fill(field('公开模型标识'), 'doubao-tts-1.0');
    await fill(field('显示名称'), '豆包语音');
    await fill(field('允许的 appCaller'), 'mcp-speech.synthesize::tts');
    await click('保存逻辑模型');
    assert.equal(fixture.calls[0].draft.modelType, 'tts');
    assert.deepEqual(fixture.calls[0].draft.capabilities, ['tts']);
    assert.deepEqual(fixture.calls[0].draft.allowedAppCallerCodes, ['mcp-speech.synthesize::tts']);
    assert.equal(fixture.calls[0].draft.isDefaultForType, undefined);
    await click('展开');
    await click('添加上游');
    await fill(field('目标类型', 'select'), 'exchange');
    assert.ok([...field('上游目标', 'select').options].some(option => option.value === fixture.exchange.id));
    await fill(field('上游目标', 'select'), fixture.exchange.id);
    await fill(field('上游模型标识'), 'doubao-tts-1.0');
    await click('保存 Offering');
    assert.equal(fixture.calls[1].draft.targetId, fixture.exchange.id);
    assert.equal(fixture.calls[1].draft.targetKind, 'exchange');
    assert.equal(fixture.calls[1].draft.upstreamModelId, 'doubao-tts-1.0');
    await click('编辑');
    assert.equal(field('上游模型标识').value, 'doubao-tts-1.0');
    assert.equal(field('上游目标', 'select').value, fixture.exchange.id);
    await click('保存修改');
    assert.equal(fixture.calls[2].draft.upstreamModelId, 'doubao-tts-1.0');
    assert.equal(fixture.items[0].modelType, 'tts');
    fixture.metadataAvailable = false;
    await render('unavailable');
    assert.match(document.body.textContent, /豆包语音/);
    await click('手动新建');
    assert.equal(field('模型类型', 'select').disabled, true);
    assert.equal(button('保存逻辑模型').disabled, true);
    assert.match(document.body.textContent, /用途目录暂不可用/);
    assert.equal(fixture.calls.length, 3, '元数据失败不能回退为旧用途表或发起创建');
  } finally {
    if (root) await act(async () => root.unmount());
    await server.close();
    dom.window.close();
    for (const name of names) globalThis[name] = previous[name];
    delete globalThis.__logicalSpeechFixture;
    delete globalThis.__logicalSpeechRouter;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
