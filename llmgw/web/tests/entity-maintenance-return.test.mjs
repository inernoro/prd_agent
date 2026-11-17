import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

test('型号进入供应方保留有限清单来源；真实日志来源仍回日志，直达使用页面自身回退', async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const nav = await server.ssrLoadModule('/src/lib/entityNavigation.ts');
    const logs = await server.ssrLoadModule('/src/lib/logNavigation.ts');
    const origin = new URLSearchParams({ returnKind: 'upstream-provider', returnProviderId: 'p0', ownedQuery: '型号', ownedPage: '3', ownedFocus: 'm29', from: 'https://untrusted.example' });
    const detail = new URL(nav.modelProviderDetailHref({ id: 'p0', name: '原供应方' }, origin), 'https://local');
    const back = new URL(nav.entityBackTarget(detail.searchParams).href, 'https://local');
    assert.equal(back.pathname, '/platforms');
    assert.equal(back.searchParams.get('providerId'), 'p0');
    assert.equal(back.searchParams.get('ownedFocus'), 'm29');
    assert.equal(back.searchParams.get('ownedPage'), '3');
    assert.equal(back.searchParams.get('ownedQuery'), '型号');
    assert.equal(back.searchParams.has('from'), false);
    const other = new URL(nav.modelProviderDetailHref({ id: 'p1' }, origin), 'https://local');
    assert.equal(other.searchParams.has('returnProviderId'), false, '另一供应方不能冒原清单对象来源');
    const context = { source: 'logs', view: 'physical', status: 'failed', selectedLogId: 'row-65', from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z' };
    const logParams = new URL(logs.withLogTaskContext('/models/view', new URLSearchParams({ modelId: 'm0' }), context), 'https://local').searchParams;
    const logProvider = new URL(nav.modelProviderDetailHref({ id: 'p0' }, logParams), 'https://local');
    const logBack = new URL(nav.entityBackTarget(logProvider.searchParams).href, 'https://local');
    assert.equal(logBack.pathname, '/logs');
    assert.equal(logBack.searchParams.get('anchor'), 'row-65');
    assert.equal(logBack.searchParams.get('status'), 'failed');
    assert.equal(logBack.searchParams.get('view'), 'physical');
    assert.deepEqual(nav.entityBackTarget(new URLSearchParams(), { href: '/platforms', label: '返回上游' }), { href: '/platforms', label: '返回上游' });
  } finally { await server.close(); }
});
