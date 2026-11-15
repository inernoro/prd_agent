import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('响应体中断返回网络错误信封，保留已知401与业务拒绝', async () => {
  const dom = new JSDOM('', { url: 'http://localhost/account' });
  const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage };
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.localStorage = dom.window.localStorage; globalThis.sessionStorage = dom.window.sessionStorage;
  const server = await createServer({ root: process.env.GW_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true } });
  try {
    const api = await server.ssrLoadModule('/src/lib/api.ts');
    const interrupted = (status = 200) => new Response(new ReadableStream({ start(controller) { controller.error(new Error('fixture response body interrupted')); } }), { status });
    for (const invoke of [() => api.getAccountProfile(), () => api.changePassword({ newPassword: 'fixture-only-password' })]) {
      globalThis.fetch = async () => interrupted();
      const result = await invoke();
      assert.equal(result.success, false); assert.equal(result.error.code, 'NETWORK_ERROR');
    }
    const session = token => ({ token, username: 'fixture-user', expiresAt: new Date(Date.now() + 60_000).toISOString(), tenant: { id: 'fixture-tenant', role: 'owner' } });
    let expired = 0; const unsubscribe = api.onSessionExpired(() => expired++);
    api.setSession(session('fixture-session-A'));
    globalThis.fetch = async () => interrupted(401);
    assert.equal((await api.getAccountProfile()).error.code, 'UNAUTHORIZED');
    assert.equal(api.getToken(), null); assert.equal(expired, 1);
    api.setSession(session('fixture-session-A')); expired = 0;
    globalThis.fetch = async () => { api.setSession(session('fixture-session-B')); return interrupted(401); };
    assert.equal((await api.getAccountProfile()).error.code, 'UNAUTHORIZED');
    assert.equal(api.getToken(), 'fixture-session-B'); assert.equal(expired, 0); unsubscribe();
    api.clearSession();
    const refused = { success: false, data: null, error: { code: 'INVALID_CREDENTIALS', message: 'fixture refusal' } };
    globalThis.fetch = async () => Response.json(refused, { status: 400 });
    assert.deepEqual(await api.changePassword({ newPassword: 'fixture-only-password' }), refused);
  } finally { await server.close(); dom.window.close(); Object.assign(globalThis, saved); }
});
