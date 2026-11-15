import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('调用链区分未知费用、明确零费用、重复回执、汇总和逐次尝试', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/logs/trace?reference=run' });
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__traceQueries = [];
  globalThis.__traceFixture = { ambiguous: false, total: 3, page: 1, pageSize: 50, items: [
    { log: { id: 'submit', requestId: 'req-1', status: 'failed', operation: 'submit', userId: 'user-1' }, recordKind: 'request', sameReceiptRecords: 0,
      attempts: [{ order: 1, stage: 'send', provider: 'A', status: 'failed', reachedProvider: true, statusCode: 403, error: '账户欠费' }, { order: 2, stage: 'send', provider: 'B', status: 'failed', reachedProvider: true, statusCode: 403, error: '额度耗尽' }] },
    { log: { id: 'poll', requestId: 'req-2', status: 'succeeded', operation: 'status', providerReportedCost: 0, providerCostCurrency: 'USD' }, recordKind: 'request', sameReceiptRecords: 2, attempts: [] },
    { log: { id: 'summary', requestId: 'run', status: 'succeeded' }, recordKind: 'legacy-summary', sameReceiptRecords: 0, attempts: [], evidenceGap: '历史记录缺少写入实例租约' },
  ] };
  const routerModule = await import('react-router-dom');
  globalThis.__traceRouter = { ...routerModule.default, ...routerModule };
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: ['react-router-dom'] },
    plugins: [{ name: 'trace-api', enforce: 'pre', resolveId(id) { if (id === 'react-router-dom') return '\0trace-router'; }, load(id) { if (id === '\0trace-router') return Object.keys(globalThis.__traceRouter).filter(name => name !== 'default').map(name => `export const ${name}=globalThis.__traceRouter.${name};`).join('\n'); if (id.endsWith('/src/lib/api.ts')) return 'export async function getLogTrace(...args){globalThis.__traceQueries.push(args);return {success:true,data:globalThis.__traceFixture}}'; } }] });
  let root;
  try {
    const { createRoot } = await import('react-dom/client');
    const { MemoryRouter } = globalThis.__traceRouter;
    const { LogTracePage } = await server.ssrLoadModule('/src/pages/LogTracePage.tsx');
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: ['/logs/trace?reference=run'] }, React.createElement(LogTracePage))));
    const text = document.body.textContent;
    assert.match(text, /实际费用：未知/); assert.match(text, /实际费用：\$0/);
    assert.match(text, /第 1 次尝试/); assert.match(text, /第 2 次尝试/);
    assert.match(text, /账户欠费/); assert.match(text, /额度耗尽/);
    assert.match(text, /同一上游回执出现在 2 条/); assert.match(text, /历史业务汇总/);
    assert.match(text, /历史记录缺少写入实例租约/);
    assert.equal(document.querySelectorAll('li').length, 2);
    globalThis.__traceFixture = { ambiguous: true, candidates: [{ id: 'explicit-a', runId: 'run-a' }] };
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '刷新')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent.includes('explicit-a'))
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    assert.deepEqual(globalThis.__traceQueries.at(-1), ['run-a', 'explicit-a', 1]);
  } finally {
    if (root) await act(async () => root.unmount());
    await server.close(); dom.window.close();
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    delete globalThis.__traceFixture; delete globalThis.__traceRouter; delete globalThis.__traceQueries;
  }
});

test('模型解析回退展示三态且不以线路备用尝试反推，详情与列表一致', async (t) => {
  const { readFile } = await import('node:fs/promises');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/logs' });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const fixture = { detail: null, rows: [] }; globalThis.__fallbackDisplayFixture = fixture;
  const routerModule = await import('react-router-dom'); globalThis.__fallbackDisplayRouter = { ...routerModule.default, ...routerModule };
  const apiSource = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const apiNames = [...apiSource.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]);
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] }, ssr: { noExternal: ['react-router-dom'] },
    plugins: [{ name: 'fallback-display-api', enforce: 'pre', resolveId(id) { if (id === 'react-router-dom') return '\0fallback-display-router'; }, load(id) {
      if (id === '\0fallback-display-router') return Object.keys(globalThis.__fallbackDisplayRouter).filter(name => name !== 'default').map(name => `export const ${name}=globalThis.__fallbackDisplayRouter.${name};`).join('\n');
      if (id.endsWith('/src/lib/api.ts')) return apiNames.map(name => {
        if (name === 'getLogDetail') return 'export async function getLogDetail(){return {success:true,data:globalThis.__fallbackDisplayFixture.detail}}';
        if (name === 'getLogs') return 'export async function getLogs(){return {success:true,data:{items:globalThis.__fallbackDisplayFixture.rows,total:globalThis.__fallbackDisplayFixture.rows.length}}}';
        return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
      }).join('\n');
    } }] });
  const { createRoot } = await import('react-dom/client'); const { MemoryRouter } = globalThis.__fallbackDisplayRouter;
  const { GenerationDetailsDrawer } = await server.ssrLoadModule('/src/components/GenerationDetailsDrawer.tsx');
  const { LogsView } = await server.ssrLoadModule('/src/components/LogsView.tsx');
  let root;
  const mount = async element => { root = createRoot(document.getElementById('root')); await act(async () => root.render(React.createElement(MemoryRouter, null, element))); };
  const unmount = async () => { if (root) { await act(async () => root.unmount()); root = null; } };
  // Sanitized actual-preview ad89e7 shape: null model-fallback flag, primary402 -> backup200.
  const attempts = [{ order: 1, stage: 'send', platformName: 'primary', status: 'failed', statusCode: 402, reachedProvider: true }, { order: 2, stage: 'send', platformName: 'backup', status: 'succeeded', statusCode: 200, reachedProvider: true }];
  const base = { id: 'existing-request', requestId: 'req-recorded', provider: 'backup', model: 'notification-model', status: 'succeeded', statusCode: 200, upstreamCallCount: 2, statusQueryCount: 0, operation: 'invoke', startedAt: '2026-11-14T00:57:29Z', providerAttempts: attempts };
  const card = () => [...document.querySelectorAll('div')].find(node => ['回退', '模型/模型池回退'].includes(node.textContent))?.parentElement;
  try {
    for (const [name, value, expected] of [['null', null, '未记录'], ['missing', undefined, '未记录'], ['false', false, '否'], ['true', true, '是']]) {
      await t.test(`详情 ${name}`, async () => {
        fixture.detail = { ...base, ...(value === undefined ? {} : { isFallback: value }), fallbackReason: value === true ? '原模型池不可用，已按授权降级' : null };
        try {
          await mount(React.createElement(GenerationDetailsDrawer, { logId: name, onClose() {} }));
          assert.ok(card(), '实际详情渲染回退卡片');
          assert.equal(card().querySelector('.tabular').textContent, expected);
          assert.match(card().textContent, /模型\/模型池回退/);
          assert.match(card().textContent, /模型解析回退/); assert.match(card().textContent, /线路备用.*路由尝试/);
          if (value === true) assert.match(card().textContent, /原模型池不可用/);
          assert.match(document.body.textContent, /2 次上游调用/);
        } finally { await unmount(); }
      });
    }
    await t.test('同一未记录字段不受不同尝试结果影响', async () => {
      for (const chain of [attempts, [attempts[1]], [attempts[0]], [{ ...attempts[0], status: 'unknown', error: 'UPSTREAM_OUTCOME_UNKNOWN' }]]) {
        fixture.detail = { ...base, isFallback: null, providerAttempts: chain };
        try { await mount(React.createElement(GenerationDetailsDrawer, { logId: 'same-field', onClose() {} })); assert.equal(card().querySelector('.tabular').textContent, '未记录'); }
        finally { await unmount(); }
      }
    });
    await t.test('实际列表回退列同一范围与三态', async () => {
      fixture.rows = [null, undefined, false, true].map((value, i) => ({ ...base, id: `row-${i}`, requestId: `request-${i}`, ...(value === undefined ? {} : { isFallback: value }) }));
      try {
        await mount(React.createElement(LogsView)); const upstream = [...document.querySelectorAll('button')].find(button => button.textContent === '上游调用');
        assert.ok(upstream); await act(async () => upstream.click()); const rows = [...document.querySelectorAll('.lg-log-table-row')]; assert.equal(rows.length, 4);
        const columnIndex = [...document.querySelector('.lg-log-table-head').children].findIndex(node => /是否回退|模型\/模型池回退/.test(node.textContent)); assert.ok(columnIndex >= 0);
        assert.deepEqual(rows.map(row => row.children[columnIndex].textContent), ['未记录', '未记录', '否', '是']); assert.match(document.body.textContent, /模型\/模型池回退/);
      } finally { await unmount(); }
    });
  } finally {
    await unmount(); await server.close(); dom.window.close(); for (const name of names) globalThis[name] = previous[name]; globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
    delete globalThis.__fallbackDisplayFixture; delete globalThis.__fallbackDisplayRouter;
  }
});
