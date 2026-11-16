import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('第二批请求→详情→调用链→返回保留筛选、已加载记录及选中身份，关闭不重置筛选', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/logs' });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'requestAnimationFrame', 'getComputedStyle', 'IntersectionObserver'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  globalThis.requestAnimationFrame = callback => callback();
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const router = await import('react-router-dom'); globalThis.__journeyRouter = { ...router.default, ...router };
  const base = { appCallerCode: 'shared-code', requestType: 'chat', platformId: 'upstream', status: 'failed', statusCode: 403, model: 'sample-model', provider: 'example-upstream', operation: 'invoke', startedAt: '2026-11-01T12:00:00Z', upstreamCallCount: 1, error: '账户额度不足', providerAttempts: [] };
  globalThis.__journey = { calls: [], rows: [1, 2, 3, 4].map(i => ({ ...base, id: `row-${i}`, requestId: `request-${i}` })) };
  const apiSource = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const apiNames = [...apiSource.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]);
  const server = await createServer({ root: process.env.W2_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] }, ssr: { noExternal: ['react-router-dom'] }, plugins: [{ name: 'journey-api', enforce: 'pre', resolveId(id) { if (id === 'react-router-dom') return '\0journey-router'; }, load(id) {
    if (id === '\0journey-router') return Object.keys(globalThis.__journeyRouter).filter(name => name !== 'default').map(name => `export const ${name}=globalThis.__journeyRouter.${name};`).join('\n');
    if (id.endsWith('/src/lib/api.ts')) return apiNames.map(name => {
      if (name === 'getLogs') return 'export async function getLogs(params){globalThis.__journey.calls.push(params);if(globalThis.__journey.delay && params.status==="succeeded")return new Promise(resolve=>{globalThis.__journey.resolve=resolve});const rows=globalThis.__journey.rows.filter(row=>!params.requestId||row.requestId===params.requestId||row.id===params.requestId);return {success:true,data:{items:rows.slice((params.page-1)*2,params.page*2),total:rows.length}}}';
      if (name === 'getLogDetail') return 'export async function getLogDetail(id){return {success:true,data:globalThis.__journey.rows.find(row=>row.id===id)}}';
      if (name === 'getLogTrace') return 'export async function getLogTrace(){return {success:true,data:{ambiguous:false,total:1,page:1,pageSize:50,items:[{log:globalThis.__journey.rows[3],recordKind:"request",sameReceiptRecords:0,attempts:[]}]}}}';
      return `export async function ${name}(){return {success:true,data:{items:[],statuses:['failed','succeeded'],models:['sample-model']}}}`;
    }).join('\n');
  } }] });
  let root;
  try {
    const { createRoot } = await import('react-dom/client');
    const { MemoryRouter, Routes, Route, useLocation, useNavigate } = globalThis.__journeyRouter;
    const { LogsView } = await server.ssrLoadModule('/src/components/LogsView.tsx');
    const { LogTracePage } = await server.ssrLoadModule('/src/pages/LogTracePage.tsx');
    const { buildLogRequestHref } = await server.ssrLoadModule('/src/lib/logNavigation.ts');
    const Location = () => { globalThis.__journey.navigate = useNavigate(); return React.createElement('output', { id: 'route' }, useLocation().pathname + useLocation().search); };
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: ['/logs?status=failed&model=sample-model'] }, React.createElement(React.Fragment, null, React.createElement(Location), React.createElement(Routes, null, React.createElement(Route, { path: '/usage', element: React.createElement('div', {id:'origin'}, '原账单') }), React.createElement(Route, { path: '/overview', element: React.createElement('div', {id:'origin'}, '原概览') }), React.createElement(Route, { path: '/logs', element: React.createElement(LogsView) }), React.createElement(Route, { path: '/logs/trace', element: React.createElement(LogTracePage) }))))));
    const click = async node => { assert.ok(node, 'expected action exists'); await act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))); };
    await click([...document.querySelectorAll('button')].find(node => node.textContent === '加载更多'));
    assert.equal(document.querySelectorAll('.lg-log-table-row').length, 4);
    const lastRow = document.querySelectorAll('.lg-log-table-row')[3];
    for (const path of ['/models/view', '/platforms/view', '/app-callers/view']) {
      const link = lastRow.querySelector(`a[href^="${path}"]`);assert.ok(link,`rendered ${path} entry`);const target=new URL(link.getAttribute('href'),'http://local');const context=new URLSearchParams(target.searchParams.get('context'));assert.equal(context.get('status'),'failed');assert.equal(context.get('model'),'sample-model');assert.equal(context.get('selectedLogId'),'row-4');assert.ok(context.get('from'));assert.ok(context.get('to'));if(path==='/app-callers/view')assert.equal(target.searchParams.get('requestType'),'chat');
    }
    const body = document.querySelector('.lg-log-table-body'); body.scrollTop = 350; body.dispatchEvent(new dom.window.Event('scroll'));
    await click(document.querySelectorAll('.lg-log-table-row')[3]);
    assert.match(document.querySelector('#route').textContent, /status=failed/);
    assert.equal(document.querySelectorAll('.lg-log-table-row').length, 4);
    assert.match(document.body.textContent, /账户额度不足/);
    const calls = globalThis.__journey.calls.length;
    await click([...document.querySelectorAll('a')].find(node => /核对上游尝试与失败依据|查看完整关联调用链/.test(node.textContent)));
    assert.match(document.querySelector('#route').textContent, /^\/logs\/trace/);
    await click([...document.querySelectorAll('a')].find(node => /返回原请求|返回调用记录/.test(node.textContent)));
    assert.equal(document.querySelectorAll('.lg-log-table-row').length, 4, 'restores both loaded batches');
    assert.equal(document.querySelectorAll('.lg-log-table-row')[3].getAttribute('aria-current'), 'true');
    assert.equal(document.querySelector('.lg-log-table-body').scrollTop, 350);
    assert.equal(globalThis.__journey.calls.length, calls, 'does not reset list to first batch');
    await click(document.querySelector('[aria-label="关闭详情"]'));
    const route = new URL(document.querySelector('#route').textContent, 'http://local');
    assert.equal(route.searchParams.get('status'), 'failed'); assert.equal(route.searchParams.get('model'), 'sample-model'); assert.equal(route.searchParams.has('transaction'), false);
    // A delayed response from another filter must never overwrite a restored request list.
    const originalRoute = document.querySelector('#route').textContent;
    globalThis.__journey.delay = true;
    await act(async () => { const status = document.querySelector('select[aria-label="状态"]'); status.value = 'succeeded'; status.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert.equal(document.querySelectorAll('.lg-log-table-row').length, 0, 'old records are cleared while new filter is pending');
    await act(async () => globalThis.__journey.navigate(originalRoute));
    assert.equal(document.querySelectorAll('.lg-log-table-row').length, 4, 'previous successful filter can resume while another read is pending');
    await act(async () => globalThis.__journey.resolve({ success: true, data: { items: [{ ...base, id: 'wrong-filter', status: 'succeeded' }], total: 1 } }));
    assert.equal(document.querySelectorAll('.lg-log-table-row').length, 4, 'late response cannot replace the resumed list');
    assert.equal(document.querySelector('[data-log-row-id="wrong-filter"]'), null);
    assert.equal(document.querySelector('select[aria-label="状态"]').value, 'failed');
    // An external receipt lookup is one browser entry. Manual drill-down still has its own Back step.
    for (const origin of ['/usage?from=2026-11-01T00%3A00%3A00Z#billing-original', '/overview?range=7d']) {
      await act(async () => globalThis.__journey.navigate(origin));
      await act(async () => globalThis.__journey.navigate(buildLogRequestHref('request-2')));
      assert.match(document.querySelector('#route').textContent, /transaction=row-2/);
      assert.doesNotMatch(document.querySelector('#route').textContent, /openRequest=/);
      await act(async () => globalThis.__journey.navigate(-1));
      assert.ok(document.querySelector('#origin'), 'one Back returns to the originating task');
    }
    await act(async () => globalThis.__journey.navigate('/logs?requestId=request-2&transaction=row-1&openRequest=1'));
    assert.match(document.querySelector('#route').textContent, /transaction=row-1/); assert.doesNotMatch(document.querySelector('#route').textContent, /openRequest=/, 'existing selected record has priority and consumes the intent');
    await act(async () => globalThis.__journey.navigate('/overview?range=7d'));
    await act(async () => globalThis.__journey.navigate('/logs?requestId=not-retained&openRequest=1'));
    assert.doesNotMatch(document.querySelector('#route').textContent, /transaction=/, 'no match does not open or push another entry');
    await act(async () => globalThis.__journey.navigate(-1)); assert.ok(document.querySelector('#origin'));
    await act(async () => globalThis.__journey.navigate('/logs?requestId=not-retained&openRequest=1'));
    await act(async () => { const range = document.querySelector('[aria-label="时间范围"]'); range.value = '7d'; range.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert.doesNotMatch(document.querySelector('#route').textContent, /openRequest=/, 'manual range changes end the prior external intent');
    await act(async () => globalThis.__journey.navigate('/logs?requestId=not-retained&openRequest=1'));
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => { const input = document.querySelector('[aria-label="按请求 ID 查找"]'); setter.call(input, 'request-2'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await act(async () => document.querySelector('form.lg-log-search').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.match(document.querySelector('#route').textContent, /transaction=row-2/);
    await act(async () => globalThis.__journey.navigate(-1));
    assert.match(document.querySelector('#route').textContent, /requestId=request-2/); assert.doesNotMatch(document.querySelector('#route').textContent, /transaction=/, 'a new manual request search must not inherit the unmatched external replace intent');
    await act(async () => globalThis.__journey.navigate('/logs'));
    await click(document.querySelector('.lg-log-table-row'));
    assert.match(document.querySelector('#route').textContent, /transaction=row-1/);
    await act(async () => globalThis.__journey.navigate(-1));
    assert.match(document.querySelector('#route').textContent, /^\/logs/); assert.doesNotMatch(document.querySelector('#route').textContent, /transaction=/, 'manual detail Back closes one list drill-down');


  } finally {
    if (root) await act(async () => root.unmount()); await server.close(); dom.window.close();
    for (const name of names) globalThis[name] = previous[name];
    delete globalThis.IS_REACT_ACT_ENVIRONMENT; delete globalThis.__journey; delete globalThis.__journeyRouter;
  }
});
