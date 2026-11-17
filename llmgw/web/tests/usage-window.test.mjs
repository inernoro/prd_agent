import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('导入后的账单时间推进统一统计窗口，估算与账单读同一范围并保留新账单', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/usage' });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const router = await import('react-router-dom'); globalThis.__windowRouter = { ...router.default, ...router };
  globalThis.__windowUsage = { now: Date.parse('2026-11-15T10:00:00Z'), summaries: [], bills: [], writes: 0, item: null };
  const api = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const server = await createServer({ root: process.env.W2_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true }, ssr: { noExternal: ['react-router-dom'] }, plugins: [{ name: 'usage-window', enforce: 'pre', resolveId(id) { if (id === 'react-router-dom') return '\0window-router'; }, load(id) {
    if (id === '\0window-router') return Object.keys(globalThis.__windowRouter).filter(name => name !== 'default').map(name => `export const ${name}=globalThis.__windowRouter.${name};`).join('\n');
    if (id.endsWith('/src/lib/auth.tsx')) return 'export function useAuth(){return {tenant:{id:"t",role:"owner"}}}';
    if (id.endsWith('/src/lib/api.ts')) return [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(([, name]) => {
      if (name === 'getLogsSummary') return 'export async function getLogsSummary(params){globalThis.__windowUsage.summaries.push(params);return {success:true,data:{total:2,totalTokens:600,priceCoveragePercent:100,pricedRequests:2,unknownCostRequests:0,estimatedCosts:[{currency:"USD",amount:0.008,requests:2}]}}}';
      if (name === 'getTenantGovernance') return 'export async function getTenantGovernance(){return {success:true,data:{}}}';
      if (name === 'getCostReconciliations') return 'export async function getCostReconciliations(params){const f=globalThis.__windowUsage;f.bills.push(params);const item=f.item;const items=item&&Date.parse(item.billedAt)>=Date.parse(params.from)&&Date.parse(item.billedAt)<Date.parse(params.to)?[item]:[];return {success:true,data:{items,totalRecords:items.length,requestRecords:items.length,windowRecords:0,providerActualCosts:items.length?[{currency:"USD",amount:1.25,requests:1}]:[],statusDistribution:[]}}}';
      if (name === 'importCostReconciliation') return 'export async function importCostReconciliation(payload){const f=globalThis.__windowUsage;f.writes++;f.item={...payload,id:"new-t2",billedAt:new Date(f.now).toISOString(),requestId:"req",granularity:"request",reconciliationStatus:"estimated-unavailable"};f.now+=1000;return {success:true,data:f.item}}';
      return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
    }).join('\n');
  } }] });
  let root; const realNow = Date.now;
  try {
    const { createRoot } = await import('react-dom/client'); const { UsagePage } = await server.ssrLoadModule('/src/pages/UsagePage.tsx');
    Date.now = () => globalThis.__windowUsage.now;
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(globalThis.__windowRouter.MemoryRouter, {}, React.createElement(UsagePage))));
    const initialTo = globalThis.__windowUsage.bills[0].to;
    globalThis.__windowUsage.now += 5 * 60_000;
    const click = async node => { assert.ok(node); await act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))); };
    const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
    await click(button('导入供应商账单'));
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    for (const [label, value] of [['供应商名称', 'Example'], ['供应商账单唯一流水号', 'bill-t2'], ['供应商请求编号', 'provider-t2'], ['供应商实际金额', '1.25']]) await act(async () => {
      const input = [...document.querySelectorAll('[role="dialog"] label')].find(node => node.textContent.startsWith(label)).querySelector('input');
      setter.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await click(button('确认导入'));
    const f = globalThis.__windowUsage; const summary = f.summaries.at(-1); const bills = f.bills.at(-1);
    assert.deepEqual({ from: summary.from, to: summary.to }, bills, 'the visible estimates and bills must use the same window');
    assert.notEqual(bills.to, initialTo); assert.ok(Date.parse(bills.to) > Date.parse(f.item.billedAt));
    assert.ok(document.querySelector('#billing-new-t2'), 'BilledAt filtering must retain the newly imported receipt');
    assert.equal(document.querySelectorAll('.lg-page-heading time').length, 2, 'show actual start and cutoff');
    assert.equal(document.querySelectorAll('.lg-page-heading time')[1].getAttribute('dateTime'), bills.to);
    assert.equal(f.writes, 1, 'refreshing both slices must not repeat the import');
  } finally {
    Date.now = realNow; if (root) await act(async () => root.unmount()); await server.close(); dom.window.close();
    for (const name of names) globalThis[name] = previous[name]; delete globalThis.IS_REACT_ACT_ENVIRONMENT; delete globalThis.__windowRouter; delete globalThis.__windowUsage;
  }
});
