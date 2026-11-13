import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('逐线路测试只在确认后收费发送一次，刷新不重发，未知结果保持阻断', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/logical-models' });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Event', 'MouseEvent'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const f = { confirmed: false, calls: [], reads: 0, reject: false, view: { requestId: '', status: 'not-run', message: '未执行' } };
  globalThis.__bindingProbeFixture = f;
  const router = await import('react-router-dom'); globalThis.__bindingProbeRouter = {...router.default,...router};
  const api = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const apiNames = [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]);
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', ssr: {noExternal:['react-router-dom']}, optimizeDeps: { noDiscovery: true, include: [] }, plugins: [{ name: 'binding-probe-fixture', enforce: 'pre', resolveId(id){if(id==='react-router-dom')return '\0binding-probe-router';}, load(id) {
    if(id==='\0binding-probe-router')return Object.keys(globalThis.__bindingProbeRouter).filter(name=>name!=='default').map(name=>`export const ${name}=globalThis.__bindingProbeRouter.${name};`).join('\n');
    if (id.endsWith('/src/components/ConfirmDialog.tsx')) return 'export function useDialogs(){return {confirm:async()=>globalThis.__bindingProbeFixture.confirmed}}';
    if (id.endsWith('/src/lib/api.ts')) return apiNames.map(name => {
      if (name === 'getGatewayAppCallers') return 'export async function getGatewayAppCallers(){return {success:true,data:{items:[{id:"caller",appCallerCode:"visual.image::generation",title:"视觉配图",status:"configured"},{id:"disabled",appCallerCode:"disabled.image::generation",title:"已停用",status:"disabled"},{id:"archived",appCallerCode:"archived.image::generation",title:"已归档",status:"archived"}],total:3}}}';
      if (name === 'getModelBindingProbe') return 'export async function getModelBindingProbe(){const f=globalThis.__bindingProbeFixture;f.reads++;return {success:true,data:structuredClone(f.view)}}';
      if (name === 'startModelBindingProbe') return 'export async function startModelBindingProbe(logicalId,offeringId,body){const f=globalThis.__bindingProbeFixture;f.calls.push({logicalId,offeringId,body});if(f.reject)throw new Error("transport");f.view={requestId:"exact-test",status:"pending",message:"排队",offeringId,upstreamModelId:"future-image"};return {success:true,data:structuredClone(f.view)}}';
      return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
    }).join('\n');
  } }] });
  let root;
  const button = label => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === label);
  const click = async label => { assert.ok(button(label), label); await act(async () => button(label).click()); };
  try {
    const { createRoot } = await import('react-dom/client');
    const { ModelOfferingTestPanel } = await server.ssrLoadModule('/src/components/ModelOfferingTestPanel.tsx');
    root = createRoot(document.getElementById('root'));
    const mount = key => act(async () => root.render(React.createElement(globalThis.__bindingProbeRouter.MemoryRouter, {}, React.createElement(ModelOfferingTestPanel, { key, logical: { id:'logical',name:'我的画师',modelType:'generation' }, offering: { id:'chosen-offering',targetKind:'model',targetId:'physical',targetName:'官方',enabled:true }, providerId:'official' }))));
    await mount('initial'); assert.equal(f.calls.length, 0, '挂载与读记录不能发推理');
    assert.equal(document.querySelector('[aria-label="服务测试调用用途"]').options.length, 1, '已配置调用方可测试，停用和归档调用方不可选');
    assert.equal(button('测试真实产物').disabled, false);
    await click('测试真实产物'); assert.equal(f.calls.length, 0, '取消确认不发送');
    f.confirmed = true; await click('测试真实产物');
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].offeringId, 'chosen-offering'); assert.equal(f.calls[0].body.maxCostUsd, .1);
    assert.equal(button('测试真实产物').disabled, true, 'pending阻止第二次付费调用');
    f.view = { ...f.view,status:'failed',message:'余额或额度不足，请补充对应账户额度。',httpStatus:429 };
    await click('刷新测试记录'); assert.match(document.body.textContent, /余额或额度不足/); assert.match(document.body.textContent, /HTTP 429/); assert.equal(f.calls.length, 1);
    f.view = { ...f.view,status:'unknown',message:'结果待核对' }; await click('刷新测试记录');
    assert.equal(button('测试真实产物').disabled, true); await mount('reloaded'); assert.equal(button('测试真实产物').disabled, true, '重新挂载仍读回未知状态，不能悄悄重试'); assert.equal(f.calls.length, 1);
    f.view = { requestId:'',status:'not-run',message:'未执行' }; f.reject = true; await mount('uncertain');
    await click('测试真实产物'); assert.equal(f.calls.length, 2); assert.equal(button('测试真实产物').disabled, true);
    await click('刷新测试记录'); assert.equal(f.calls.length, 2); assert.equal(button('测试真实产物').disabled, true, '提交结果不明且没有读到队列身份时继续阻断');
  } finally {
    if (root) await act(async () => root.unmount()); await server.close(); dom.window.close();
    for (const name of names) globalThis[name] = previous[name];
    delete globalThis.__bindingProbeFixture; delete globalThis.__bindingProbeRouter; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
