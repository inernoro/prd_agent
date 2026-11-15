import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

test('请求任务上下文只携带白名单、保持范围和筛选，调用链返回原请求', async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const nav = await server.ssrLoadModule('/src/lib/logNavigation.ts');
    const context = { source: 'logs', range: '7d', from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z', model: 'm', status: 'failed', platformId: 'p', view: 'physical', selectedLogId: 'row-65' };
    const trace = nav.buildLogTraceHref('row-65', context);
    const restored = nav.getLogTaskContext(new URL(trace, 'https://local').search);
    assert.deepEqual(restored, context);
    const back = new URL(nav.buildLogListHref(restored, restored.selectedLogId), 'https://local');
    assert.equal(back.pathname, '/logs'); assert.equal(back.searchParams.get('transaction'), 'row-65'); assert.equal(back.searchParams.get('anchor'), 'row-65');
    for (const key of ['model', 'status', 'platformId', 'view', 'from', 'to']) assert.equal(back.searchParams.get(key), context[key]);
    const detail = nav.buildLogDetailHref('another', { ...restored, traceReference: 'row-65', traceAnchor: 'unique', tracePage: '2' });
    const target = nav.getLogReturnTarget(nav.getLogTaskContext(new URL(detail, 'https://local').search));
    assert.equal(target.label, '返回调用链'); assert.match(target.href, /anchorId=unique/); assert.match(target.href, /page=2/);
    assert.equal(nav.getLogReturnTarget(nav.getLogTaskContext('')).href, '/logs');
    const unsafe = nav.getLogTaskContext(`?context=${encodeURIComponent('source=external&from=https://evil.test&return=https://evil.test&password=secret&body=private&range=999&tracePage=-1')}`);
    assert.deepEqual(unsafe, {}); assert.equal(nav.getLogReturnTarget(unsafe).href, '/logs');
    const entityHref = nav.withLogTaskContext('/app-callers/view', new URLSearchParams({ code: 'shared-code', requestType: 'chat' }), context);
    const entity = new URL(entityHref, 'https://local');assert.equal(entity.searchParams.get('requestType'),'chat');assert.deepEqual(nav.getLogTaskContext(entity.search),context);assert.match(nav.getLogReturnTarget(nav.getLogTaskContext(entity.search)).href,/anchor=row-65/);
    assert.throws(()=>nav.withLogTaskContext('https://evil.test',new URLSearchParams(),context),/Unsupported/);
    assert.doesNotMatch(nav.buildLogListHref({ ...context, model: undefined }), /undefined/);
  } finally { await server.close(); }
});

test('列表摘要恢复有时效且退出后清除', async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const cache = await server.ssrLoadModule('/src/lib/logListResume.ts');
    const saved = { key: 'tenant-window-filters', rows: [{ id: 'row-65' }], total: 100, page: 3, scrollTop: 750 };
    cache.saveLogListResume(saved);
    assert.equal(cache.readLogListResume(saved.key).page, 3);
    assert.equal(cache.readLogListResume('another-tenant'), null);
    cache.clearLogListResume(); assert.equal(cache.readLogListResume(saved.key), null);
    cache.saveLogListResume(saved);
    const now = Date.now; Date.now = () => now() + 6 * 60_000;
    try { assert.equal(cache.readLogListResume(saved.key), null); } finally { Date.now = now; }
  } finally { await server.close(); }
});
