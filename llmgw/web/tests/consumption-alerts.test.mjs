import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('动态增长预警展示历史依据且保留旧固定告警语义', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/logs' });
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const fixture = [
    { id: 'dynamic', metric: 'request_rate_baseline', kind: 'warning', scope: 'app-caller', appCallerCode: 'future-task::chat', origin: 'automatic', windowSeconds: 3600, windowStart: '2026-10-29T12:00:00Z', count: 6, limit: 6, baselineAverage: 2, baselineSamples: 3 },
    { id: 'fixed', kind: 'blocked', scope: 'tenant', origin: 'general', windowSeconds: 60, windowStart: '2026-10-29T12:00:00Z', count: 21, limit: 20 },
  ];
  globalThis.__consumptionAlertsFixture = fixture;
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{ name: 'consumption-api-fixture', enforce: 'pre', load(id) {
      if (id.endsWith('/src/lib/api.ts')) return 'export async function getConsumptionAlerts(){return {success:true,data:{items:globalThis.__consumptionAlertsFixture}}}';
    } }],
  });
  let root;
  try {
    const { createRoot } = await import('react-dom/client');
    const { ConsumptionAlertsPanel } = await server.ssrLoadModule('/src/components/ConsumptionAlertsPanel.tsx');
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(ConsumptionAlertsPanel, { refreshToken: 0 })));
    assert.match(document.body.textContent, /动态增长/);
    assert.match(document.body.textContent, /历史均值 2，3 个已结束窗口/);
    assert.match(document.body.textContent, /不修改现有限额/);
    assert.match(document.body.textContent, /已拦截超限调用/);
    assert.equal(document.querySelectorAll('li').length, 2);
    assert.match(document.querySelectorAll('li')[1].textContent, /已拦截.*租户合计/);
  } finally {
    if (root) await act(async () => root.unmount());
    await server.close();
    dom.window.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    delete globalThis.__consumptionAlertsFixture;
  }
});
