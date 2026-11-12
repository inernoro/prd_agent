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
    plugins: [{ name: 'trace-api', enforce: 'pre', resolveId(id) { if (id === 'react-router-dom') return '\0trace-router'; }, load(id) { if (id === '\0trace-router') return Object.keys(globalThis.__traceRouter).filter(name => name !== 'default').map(name => `export const ${name}=globalThis.__traceRouter.${name};`).join('\n'); if (id.endsWith('/src/lib/api.ts')) return 'export async function getLogTrace(){return {success:true,data:globalThis.__traceFixture}}'; } }] });
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
  } finally {
    if (root) await act(async () => root.unmount());
    await server.close(); dom.window.close();
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    delete globalThis.__traceFixture; delete globalThis.__traceRouter;
  }
});
