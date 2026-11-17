import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('限制读取失败不可保存空值；重读已知配置后可编辑保存，用量失败保持未知', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/usage' });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]])); for (const name of names) globalThis[name] = dom.window[name];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const router = await import('react-router-dom'); globalThis.__usageRouter = { ...router.default, ...router };
  globalThis.__usageRecovery = { fail: true, writes: [], governance: { monthlyBudgetUsd: 100, budgetReservationUsd: 2, rateLimitPerMinute: 60, spentUsd: 20, reservedUsd: 2, remainingBudgetUsd: 78, currentMinuteCount: 3 } };
  const api = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const server = await createServer({ root: process.env.W2_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true }, ssr: { noExternal: ['react-router-dom'] }, plugins: [{ name: 'usage-recovery', enforce: 'pre', resolveId(id) { if (id === 'react-router-dom') return '\0usage-router'; }, load(id) {
    if (id === '\0usage-router') return Object.keys(globalThis.__usageRouter).filter(name => name !== 'default').map(name => `export const ${name}=globalThis.__usageRouter.${name};`).join('\n');
    if (id.endsWith('/src/lib/auth.tsx')) return 'export function useAuth(){return {tenant:{role:"owner"}}}';
    if (id.endsWith('/src/lib/api.ts')) return [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(([, name]) => {
      if (name === 'getTenantGovernance') return 'export async function getTenantGovernance(){return globalThis.__usageRecovery.fail?{success:false,error:{message:"读取超时"}}:{success:true,data:globalThis.__usageRecovery.governance}}';
      if (name === 'updateTenantGovernance') return 'export async function updateTenantGovernance(payload){globalThis.__usageRecovery.writes.push(payload);globalThis.__usageRecovery.governance={...globalThis.__usageRecovery.governance,...payload};if(globalThis.__usageRecovery.throwResponse)throw new Error("response body interrupted");if(globalThis.__usageRecovery.loseResponse)return {success:false,error:{code:"NETWORK_ERROR",message:"Failed to fetch"}};return {success:true,data:globalThis.__usageRecovery.governance}}';
      if (name === 'getLogsSummary') return 'export async function getLogsSummary(){return {success:false,error:{message:"聚合用量暂不可用"}}}';
      if (name === 'getCostReconciliations') return 'export async function getCostReconciliations(){return {success:true,data:{items:[],totalRecords:0,requestRecords:0,windowRecords:0,providerActualCosts:[]}}}';
      return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
    }).join('\n');
  } }] });
  let root;
  try {
    const { createRoot } = await import('react-dom/client'); const { UsagePage } = await server.ssrLoadModule('/src/pages/UsagePage.tsx'); root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(globalThis.__usageRouter.MemoryRouter, {}, React.createElement(UsagePage))));
    const save = [...document.querySelectorAll('button')].find(button => button.textContent === '保存硬限制');
    assert.ok(save); assert.equal(save.disabled, true, 'unknown configuration cannot be overwritten by three nulls');
    await act(async () => save.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
    assert.equal(globalThis.__usageRecovery.writes.length, 0);
    assert.doesNotMatch(document.querySelector('#tenant-governance-title').parentElement.parentElement.textContent, /正在读取/);
    assert.doesNotMatch(document.body.textContent, /暂无请求/);
    globalThis.__usageRecovery.fail = false;
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '重新读取限制').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
    const inputs = document.querySelectorAll('fieldset input'); assert.equal(inputs[0].value, '100'); assert.equal(inputs[1].value, '2'); assert.equal(inputs[2].value, '60');
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => { setter.call(inputs[0], '200'); inputs[0].dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await act(async () => save.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
    assert.deepEqual(globalThis.__usageRecovery.writes, [{ monthlyBudgetUsd: 200, budgetReservationUsd: 2, rateLimitPerMinute: 60 }]);
    globalThis.__usageRecovery.loseResponse = true;
    await act(async () => { setter.call(inputs[0], '300'); inputs[0].dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await act(async () => save.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
    assert.match(document.body.textContent, /保存结果未确认/);
    assert.equal(save.disabled, true); assert.equal(inputs[0].value, '300', 'keeps the submitted draft after lost response');
    await act(async () => save.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
    assert.equal(globalThis.__usageRecovery.writes.length, 2, 'unknown outcome cannot be blindly resubmitted');
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '重新读取限制').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
    assert.equal(inputs[0].value, '300'); assert.equal(save.disabled, false);
    assert.match(document.body.textContent, /本次草稿仍保留/);
    assert.equal(globalThis.__usageRecovery.writes.length, 2, 'read reconciliation makes no new writes');
    globalThis.__usageRecovery.loseResponse = false; globalThis.__usageRecovery.throwResponse = true;
    await act(async () => { setter.call(inputs[0], '400'); inputs[0].dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await act(async () => save.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
    assert.match(document.body.textContent, /保存结果未确认/); assert.equal(inputs[0].value, '400');
    const retryRead = [...document.querySelectorAll('button')].find(button => button.textContent === '重新读取限制');
    assert.equal(retryRead.disabled, false, 'response-body rejection exits saving and allows read reconciliation');
    await act(async () => retryRead.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
    assert.equal(inputs[0].value, '400'); assert.equal(globalThis.__usageRecovery.writes.length, 3);


  } finally { if (root) await act(async () => root.unmount()); await server.close(); dom.window.close(); for (const name of names) globalThis[name] = previous[name]; delete globalThis.IS_REACT_ACT_ENVIRONMENT; delete globalThis.__usageRecovery; delete globalThis.__usageRouter; }
});
