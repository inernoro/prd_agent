import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/request-identity.json', import.meta.url), 'utf8'));

test('弱请求编号多记录保留候选；精确身份、唯一回执及嵌套尝试保持原历史契约', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/logs' });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'requestAnimationFrame', 'getComputedStyle', 'IntersectionObserver'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  globalThis.requestAnimationFrame = callback => callback(); globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const router = await import('react-router-dom'); globalThis.__candidateRouter = { ...router.default, ...router };
  globalThis.__candidate = { rows: [], detailCalls: [], listCalls: [] };
  const api = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const server = await createServer({ root: process.env.W2_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] }, ssr: { noExternal: ['react-router-dom'] }, plugins: [{ name: 'request-candidate-api', enforce: 'pre', resolveId(id) { if (id === 'react-router-dom') return '\0candidate-router'; }, load(id) {
    if (id === '\0candidate-router') return Object.keys(globalThis.__candidateRouter).filter(name => name !== 'default').map(name => `export const ${name}=globalThis.__candidateRouter.${name};`).join('\n');
    if (id.endsWith('/src/lib/api.ts')) return [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(([, name]) => {
      if (name === 'getLogs') return 'export async function getLogs(params){const f=globalThis.__candidate;f.listCalls.push(params);if(f.delayRequest&&params.requestId)return new Promise(resolve=>{f.resolve=resolve});const rows=f.rows.filter(row=>!params.requestId||row.requestId===params.requestId||row.id===params.requestId);return {success:true,data:{items:f.partial?rows.slice(0,1):rows,total:rows.length}}}';
      if (name === 'getLogDetail') return 'export async function getLogDetail(id){const f=globalThis.__candidate;f.detailCalls.push(id);return {success:true,data:f.detail?.id===id?f.detail:f.rows.find(row=>row.id===id)}}';
      return `export async function ${name}(){return {success:true,data:{items:[],statuses:['failed','succeeded'],models:['business-chat']}}}`;
    }).join('\n');
  } }] });
  let root;
  try {
    const { createRoot } = await import('react-dom/client');
    const { LogsView } = await server.ssrLoadModule('/src/components/LogsView.tsx');
    const { buildLogRequestHref } = await server.ssrLoadModule('/src/lib/logNavigation.ts');
    const { clearLogListResume } = await server.ssrLoadModule('/src/lib/logListResume.ts');
    const { MemoryRouter, Routes, Route, useLocation, useNavigate } = globalThis.__candidateRouter;
    const Location = () => { globalThis.__candidate.navigate = useNavigate(); const l = useLocation(); return React.createElement('output', { id: 'route' }, l.pathname + l.search); };
    const route = () => new URL(document.querySelector('#route').textContent, 'http://local');
    let serial = 0;
    const mount = async (data, entry) => {
      if (root) await act(async () => root.unmount()); clearLogListResume();
      globalThis.__candidate = { ...data, rows: data.rows.map(row => ({ providerAttempts: [], ...row })), detailCalls: [], listCalls: [] };
      root = createRoot(document.getElementById('root'));
      await act(async () => root.render(React.createElement(MemoryRouter, { key: ++serial, initialEntries: ['/origin', entry], initialIndex: 1 }, React.createElement(React.Fragment, null, React.createElement(Location), React.createElement(Routes, null, React.createElement(Route, { path: '/origin', element: React.createElement('div', { id: 'origin' }, '来源任务') }), React.createElement(Route, { path: '/logs', element: React.createElement(LogsView) }))))));
    };
    const click = async node => { assert.ok(node); await act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))); };
    for (const rows of [fixtures.sameIdMultiplePhysical.rows, [...fixtures.sameIdMultiplePhysical.rows].reverse()]) {
      await mount({ rows }, buildLogRequestHref('shared-retry-01', { view: 'physical' }));
      assert.equal(route().searchParams.has('transaction'), false, 'matching the weak id must not pick the first physical record');
      assert.deepEqual(globalThis.__candidate.detailCalls, [], 'no hidden arbitrary detail fetch');
      assert.match(document.body.textContent, /匹配多条记录.*选择具体记录/);
      assert.equal(document.querySelectorAll('.lg-log-table-row').length, 3);
      await click(document.querySelector('[data-log-row-id="retry-second-429"]'));
      assert.equal(route().searchParams.get('transaction'), 'retry-second-429');
      assert.equal(route().searchParams.has('openRequest'), false); assert.equal(globalThis.__candidate.detailCalls.at(-1), 'retry-second-429');
      await act(async () => globalThis.__candidate.navigate(-1));
      assert.equal(route().pathname, '/logs'); assert.equal(route().searchParams.has('transaction'), false, 'manual selection Back returns to the candidates');
      await act(async () => globalThis.__candidate.navigate(buildLogRequestHref('shared-retry-01', { view: 'physical' }) + '&transaction=fallback-final-200'));
      assert.equal(route().searchParams.get('transaction'), 'fallback-final-200'); assert.equal(route().searchParams.has('openRequest'), false, 'explicit identity also consumes an intent when the same request was already opened in this instance');
    }
    for (const data of [fixtures.ordinaryUnique, fixtures.safeUnique, fixtures.nestedAttemptsSinglePhysical]) {
      await mount(data, buildLogRequestHref(data.rows[0].requestId, { view: 'physical' }));
      assert.equal(route().searchParams.get('transaction'), data.expectedTransaction); assert.equal(route().searchParams.has('openRequest'), false);
      assert.equal(globalThis.__candidate.detailCalls.at(-1), data.expectedTransaction);
      await act(async () => globalThis.__candidate.navigate(-1)); assert.equal(route().pathname, '/origin', 'unique external lookup keeps one history entry');
    }
    const explicit = fixtures.explicitExistingTransaction;
    await mount(explicit, buildLogRequestHref('shared-retry-01', { view: 'physical' }) + '&transaction=' + explicit.selectedTransaction);
    assert.equal(route().searchParams.get('transaction'), explicit.selectedTransaction); assert.equal(route().searchParams.has('openRequest'), false);
    assert.equal(globalThis.__candidate.detailCalls.at(-1), explicit.selectedTransaction);
    await mount({ rows: fixtures.sameIdMultiplePhysical.rows, partial: true }, buildLogRequestHref('shared-retry-01', { view: 'physical' }));
    assert.equal(document.querySelectorAll('.lg-log-table-row').length, 1);
    assert.equal(route().searchParams.has('transaction'), false, 'one returned row with a larger filtered total does not establish uniqueness');
    assert.match(document.body.textContent, /匹配多条记录/);
    // A newly submitted query cannot use the previous query's only row while its own result is pending.
    await mount(fixtures.ordinaryUnique, '/logs?view=physical');
    globalThis.__candidate.delayRequest = true;
    await act(async () => globalThis.__candidate.navigate(buildLogRequestHref('ordinary-01', { view: 'physical' })));
    assert.equal(route().searchParams.has('transaction'), false); assert.deepEqual(globalThis.__candidate.detailCalls, []);
    await act(async () => globalThis.__candidate.resolve({ success: true, data: { items: [fixtures.ordinaryUnique.rows[0], { ...fixtures.ordinaryUnique.rows[0], id: 'another-physical' }], total: 2 } }));
    assert.equal(route().searchParams.has('transaction'), false); assert.match(document.body.textContent, /匹配多条记录/);
  } finally {
    if (root) await act(async () => root.unmount()); await server.close(); dom.window.close();
    for (const name of names) globalThis[name] = previous[name]; delete globalThis.IS_REACT_ACT_ENVIRONMENT; delete globalThis.__candidate; delete globalThis.__candidateRouter;
  }
});
