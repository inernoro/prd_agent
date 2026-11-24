import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('旧共享密钥提交冻结草稿和版本，未知不盲重提，确认写与待读取分开', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/service-keys' });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Event', 'MouseEvent'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollTo = () => {}; dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const router = await import('react-router-dom'); globalThis.__legacyRouter = { ...router.default, ...router };
  const { createRoot } = await import('react-dom/client');
  const policy = () => ({ applicable: true, policyRevision: 4, status: 'observing', deadlineAt: '2099-01-01T00:00:00.000Z', allowedAppCallerCodes: ['client.a::chat'], successorServiceKeyIds: [], requiredIngressProtocols: ['openai-compatible'], requiredScopes: ['invoke'], requiredSuccessorObservations: 1, successorObservedCount: 0, successorObservationCounts: {}, readyToRevoke: false, usage: [] });
  const f = { policy: policy(), writes: [], confirmations: 0, reads: 0, delayConfirm: false, readThrow: false };
  globalThis.__legacyFixture = f;
  const api = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const exports = [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(x => x[1]);
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] }, ssr: { noExternal: ['react-router-dom'] }, plugins: [{
    name: 'legacy-policy-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'react-router-dom') return '\0legacy-router'; },
    load(id) {
      if (id === '\0legacy-router') return Object.keys(globalThis.__legacyRouter).filter(n => n !== 'default').map(n => `export const ${n}=globalThis.__legacyRouter.${n};`).join('\n');
      if (id.endsWith('/src/lib/auth.tsx')) return 'export function useAuth(){return {tenant:{id:"internal",role:"owner",isInternal:true,teamIds:[]}}}';
      if (id.endsWith('/src/components/ConfirmDialog.tsx')) return 'export function useDialogs(){return {confirm:()=>{const f=globalThis.__legacyFixture;f.confirmations++;return f.delayConfirm?new Promise(resolve=>f.confirmResolve=resolve):Promise.resolve(true)}}}';
      if (id.endsWith('/src/lib/api.ts')) return exports.map(n => {
        if (n === 'getServiceKeys') return 'export async function getServiceKeys(){return {success:true,data:[]}}';
        if (n === 'getLegacyKeyCutover') return 'export async function getLegacyKeyCutover(){const f=globalThis.__legacyFixture;f.reads++;if(f.readThrow)throw new Error("body interrupted");if(f.deferNextRead){f.deferNextRead=false;const data=structuredClone(f.policy);return new Promise(resolve=>f.resolveRead=()=>resolve({success:true,data}))}return {success:true,data:structuredClone(f.policy)}}';
        if (n === 'updateLegacyKeyCutover') return 'export async function updateLegacyKeyCutover(body){const f=globalThis.__legacyFixture;f.writes.push(structuredClone(body));return new Promise((resolve,reject)=>{f.resolve=resolve;f.reject=reject})}';
        return `export async function ${n}(){return {success:true,data:{items:[],teams:[]}}}`;
      }).join('\n');
    },
  }] });
  let root;
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
  const click = async text => act(async () => { assert.ok(button(text), text); button(text).click(); });
  const field = label => [...document.querySelectorAll('.lg-collection-key-legacy label')].find(e => e.querySelector('span')?.textContent === label)?.querySelector('input,select');
  const change = async (label, value) => act(async () => {
    const el = field(label); assert.ok(el, label);
    Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
  const locked = () => document.querySelector('.lg-collection-key-legacy fieldset')?.disabled;
  const mount = async () => {
    if (root) await act(async () => root.unmount());
    root = createRoot(document.getElementById('root'));
    const { ServiceKeysPage } = await server.ssrLoadModule('/src/pages/ServiceKeysPage.tsx');
    await act(async () => root.render(React.createElement(globalThis.__legacyRouter.MemoryRouter, {}, React.createElement(ServiceKeysPage))));
  };
  try {
    await mount(); await change('状态', 'revoked'); f.delayConfirm = true;
    await act(async () => { button('保存收口策略').click(); button('保存收口策略').click(); });
    assert.equal(f.confirmations, 1, '确认期间防双'); assert.equal(f.writes.length, 0); assert.equal(locked(), true);
    await act(async () => f.confirmResolve(true));
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].expectedPolicyRevision, 4); assert.equal(f.writes[0].status, 'revoked');
    assert.equal(field('允许的 appCaller 清单').matches(':disabled'), true, '提交A期间不能把表单改成B');
    await act(async () => f.resolve({ success: false, error: { code: 'UNEXPECTED_AUDIT_FAILURE', message: 'lost after write' } }));
    assert.ok(document.body.textContent.includes('保存结果未确认')); await click('保存收口策略'); assert.equal(f.writes.length, 1);
    await click('核对当前策略'); assert.equal(locked(), true, '普通GET成功不满足目标不能解锁');
    f.policy = { ...f.policy, ...f.writes[0], policyRevision: 5 }; await click('核对当前策略');
    assert.equal(locked(), false); assert.ok(document.body.textContent.includes('当前策略符合本次目标')); assert.equal(f.writes.length, 1);

    f.delayConfirm = false; f.policy = policy(); await mount(); await change('允许的 appCaller 清单', 'client.submitted::chat');
    await click('保存收口策略'); const accepted = structuredClone(f.writes.at(-1)); f.readThrow = true;
    await act(async () => f.resolve({ success: true, data: { policyRevision: 5, status: 'observing' } }));
    assert.ok(document.body.textContent.includes('已确认保存策略 v5')); assert.equal(document.body.textContent.includes('保存结果未确认'), false); assert.equal(locked(), true);
    f.policy = { ...policy(), ...accepted, policyRevision: 5 }; f.readThrow = false; await click('核对当前策略'); assert.equal(locked(), false);

    f.policy = policy(); await mount(); await change('允许的 appCaller 清单', 'client.draft::chat');
    await click('保存收口策略'); await act(async () => f.resolve({ success: false, error: { code: 'LEGACY_POLICY_CONFLICT', message: 'changed' } }));
    assert.equal(field('允许的 appCaller 清单').value, 'client.draft::chat'); assert.equal(locked(), true);
    f.policy = { ...policy(), policyRevision: 8, allowedAppCallerCodes: ['client.other::chat'] };
    await click('丢弃草稿并读取最新策略'); assert.equal(field('允许的 appCaller 清单').value, 'client.other::chat'); assert.equal(locked(), false);
    await click('保存收口策略'); assert.equal(f.writes.at(-1).expectedPolicyRevision, 8, '明确读取新基线后不循环提交旧revision');
    await act(async () => f.reject(new Error('response body interrupted'))); assert.equal(locked(), true); assert.ok(button('核对当前策略')); assert.ok(document.body.textContent.includes('保存结果未确认'));

    f.policy = policy(); await mount(); await change('允许的 appCaller 清单', 'client.keep-draft::chat');
    f.policy = { ...policy(), policyRevision: 9, allowedAppCallerCodes: ['client.current::chat'] }; await click('刷新');
    assert.equal(field('允许的 appCaller 清单').value, 'client.keep-draft::chat', '其它清单刷新不覆盖草稿');
    await click('保存收口策略'); assert.equal(f.writes.at(-1).expectedPolicyRevision, 4, '读取期间不偷偷把草稿绑定到未审阅的新版本');
    await act(async () => f.resolve({ success: false, error: { code: 'LEGACY_POLICY_CONFLICT', message: 'changed' } }));
    f.policy = policy(); await mount(); await change('允许的 appCaller 清单', 'client.latest::chat');
    f.deferNextRead = true; await click('刷新'); assert.ok(f.resolveRead);
    await click('保存收口策略'); const latest = structuredClone(f.writes.at(-1)); f.policy = { ...policy(), ...latest, policyRevision: 5 };
    await act(async () => f.resolve({ success: true, data: { policyRevision: 5, status: 'observing' } }));
    assert.equal(locked(), false); assert.ok(document.body.textContent.includes('草稿基于 v5'));
    await act(async () => f.resolveRead());
    assert.ok(document.body.textContent.includes('草稿基于 v5'), '迟到普通刷新不能回退专用核对已采用的新版策略');
    assert.equal(field('允许的 appCaller 清单').value, 'client.latest::chat');
    f.policy = policy(); await mount(); await change('允许的 appCaller 清单', 'client.inflight::chat');
    f.deferNextRead = true; await click('刷新'); const oldRead = f.resolveRead;
    await click('保存收口策略'); const inFlight = structuredClone(f.writes.at(-1)); f.policy = { ...policy(), ...inFlight, policyRevision: 5 }; f.deferNextRead = true;
    await act(async () => f.resolve({ success: true, data: { policyRevision: 5, status: 'observing' } })); const newRead = f.resolveRead;
    await act(async () => oldRead());
    assert.equal(locked(), true); assert.equal(button('正在核对…').disabled, true, '旧读取finally不能清掉新专用核对busy');
    await act(async () => newRead()); assert.equal(locked(), false); assert.ok(document.body.textContent.includes('草稿基于 v5'));
    f.policy = policy(); await mount(); await click('保存收口策略');
    await act(async () => f.resolve({ success: false, error: { code: 'NETWORK_ERROR', message: 'lost' } }));
    await click('核对当前策略'); assert.equal(locked(), false, '完整目标已存在可自然收敛，不要求证明原POST');
    f.policy = policy(); await mount(); await change('允许的 appCaller 清单', 'client.pending::chat'); await click('保存收口策略');
    await act(async () => f.resolve({ success: false, error: { code: 'NETWORK_ERROR', message: 'lost' } }));
    await click('核对当前策略'); assert.equal(locked(), true); assert.equal(button('丢弃原草稿并按最新策略编辑'), undefined, '同revision不因普通读取而放开');
    f.policy = { ...policy(), policyRevision: 6, status: 'revoked' }; const writesBeforeNewIntent = f.writes.length;
    await click('核对当前策略'); assert.ok(document.body.textContent.includes('当前策略已更新为其他目标')); assert.equal(locked(), true);
    await click('丢弃原草稿并按最新策略编辑'); assert.equal(locked(), false); assert.ok(document.body.textContent.includes('草稿基于 v6'));
    assert.equal(field('状态').value, 'revoked'); assert.equal(field('状态').querySelector('option[value="observing"]').disabled, true); assert.equal(f.writes.length, writesBeforeNewIntent, '采用权威新基线不重发旧写');
  } finally {
    if (root) await act(async () => root.unmount()); await server.close(); dom.window.close();
    for (const name of names) globalThis[name] = previous[name];
    delete globalThis.__legacyFixture; delete globalThis.__legacyRouter; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
