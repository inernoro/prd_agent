import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act } from 'react';

test('真实线路删除入口确认、局部移除、409保护、busy及只读权限', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/logical-models' });
  const names = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Event', 'MouseEvent'];
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const { createRoot } = await import('react-dom/client');
  const router = await import('react-router-dom');
  globalThis.__offeringDeleteRouter = { ...router.default, ...router };
  const offering = (id, enabled) => ({ id, targetKind: 'model', targetId: `model-${id}`, targetName: id, upstreamModelId: id, enabled, priority: 10, weight: 1, queuePosition: enabled ? 1 : 0, targetUsable: true, healthStatus: 0 });
  const fixture = { role: 'admin', reads: 0, calls: [], prompts: [], typed: 'exact', failure: null, pending: false,
    items: [{ id: 'logical-quality', publicId: 'chat-quality', name: '公开聊天', identityKind: 'stable', aliases: ['legacy-chat'], modelType: 'chat', capabilities: ['chat'], allowedAppCallerCodes: ['arena.run'], defaultForAppCallerCodes: ['arena.run'], isDefaultForType: true, routingStrategy: 'priority', enabled: true,
      offerings: [offering('official-enabled', true), offering('legacy-disabled', false), offering('protected-disabled', false), offering('pending-disabled', false)] }],
  };
  globalThis.__offeringDeleteFixture = fixture;
  const api = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const apiNames = [...api.matchAll(/^export (?:async )?function (\w+)/gm)].map(match => match[1]);
  const cacheDir = await mkdtemp(join(tmpdir(), 'llmgw-offering-delete-'));
  const server = await createServer({ cacheDir, root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] }, ssr: { noExternal: ['react-router-dom'] },
    plugins: [{ name: 'offering-delete-fixture', enforce: 'pre', resolveId(id) { if (id === 'react-router-dom') return '\0offering-delete-router'; }, load(id) {
      if (id === '\0offering-delete-router') return Object.keys(globalThis.__offeringDeleteRouter).filter(name => name !== 'default').map(name => `export const ${name}=globalThis.__offeringDeleteRouter.${name};`).join('\n');
      if (id.endsWith('/src/lib/auth.tsx')) return 'export function useAuth(){return {tenant:{role:globalThis.__offeringDeleteFixture.role}}}';
      if (id.endsWith('/src/components/ConfirmDialog.tsx')) return 'export function useDialogs(){return {promptText:async options=>{const f=globalThis.__offeringDeleteFixture;f.prompts.push(options);return f.typed==="exact"?options.requireExact:f.typed},confirm:async()=>false}}';
      if (id.endsWith('/src/lib/api.ts')) return apiNames.map(name => {
        if (name === 'getLogicalModels') return 'export async function getLogicalModels(){const f=globalThis.__offeringDeleteFixture;f.reads++;return {success:true,data:{items:structuredClone(f.items)}}}';
        if (name === 'getExchangeMeta') return 'export async function getExchangeMeta(){return {success:true,data:{modelTypes:[{value:"chat",label:"聊天"}]}}}';
        if (name === 'deleteModelOffering') return 'export async function deleteModelOffering(logicalId,offeringId){const f=globalThis.__offeringDeleteFixture;f.calls.push({logicalId,offeringId});if(f.pending)return new Promise(resolve=>{f.complete=resolve});if(f.failure)return {success:false,error:{code:"OFFERING_IN_USE",message:f.failure}};return {success:true,data:{logicalModelId:logicalId,offeringId,removed:true}}}';
        return `export async function ${name}(){return {success:true,data:{items:[]}}}`;
      }).join('\n');
    } }],
  });
  let root;
  const buttons = label => [...document.querySelectorAll('button')].filter(button => button.textContent.trim() === label);
  const row = id => [...document.querySelectorAll('.lg-logical-model-route-detail')].find(element => element.textContent.includes(id));
  const remove = id => [...row(id).querySelectorAll('button')].find(button => button.textContent.trim() === '删除线路');
  const click = async button => { assert.ok(button, '缺少目标按钮'); await act(async () => button.click()); };
  try {
    const { LogicalModelsPage } = await server.ssrLoadModule('/src/pages/LogicalModelsPage.tsx');
    root = createRoot(document.getElementById('root'));
    const render = key => act(async () => root.render(React.createElement(globalThis.__offeringDeleteRouter.MemoryRouter, {}, React.createElement(LogicalModelsPage, { key }))));
    await render('admin'); await click(buttons('查看')[0]);
    assert.equal(remove('official-enabled').disabled, true, '启用线路必须先停用');
    assert.equal(remove('legacy-disabled').disabled, false);
    fixture.typed = null; await click(remove('legacy-disabled'));
    assert.equal(fixture.calls.length, 0, '取消确认不能调用DELETE');
    fixture.typed = 'wrong-id'; await click(remove('legacy-disabled'));
    assert.equal(fixture.calls.length, 0, '错误确认值不能调用DELETE');
    assert.match(document.body.textContent, /线路 ID 不一致/);
    fixture.typed = 'exact'; await click(remove('legacy-disabled'));
    assert.deepEqual(fixture.calls[0], { logicalId: 'logical-quality', offeringId: 'legacy-disabled' });
    assert.equal(row('legacy-disabled'), undefined, '成功后从同一列表局部移除');
    assert.ok(row('official-enabled'), '兄弟官方线路保持');
    assert.equal(fixture.reads, 1, '不重新加载整页或覆盖其他模型配置');
    const prompt = fixture.prompts.at(-1);
    assert.equal(prompt.requireExact, 'legacy-disabled'); assert.equal(prompt.tone, 'danger');
    assert.match(prompt.description, /无法撤销/); assert.match(prompt.description, /公开模型、兼容标识及 MAP 配置会保留/);

    fixture.failure = '仍有进行中的图片任务，请排空后重试';
    await click(remove('protected-disabled'));
    assert.ok(row('protected-disabled'), '409拒绝不能从列表删除');
    assert.match(document.body.textContent, /仍有进行中的图片任务，请排空后重试/);
    fixture.failure = null; fixture.pending = true;
    await click(remove('pending-disabled'));
    assert.ok(buttons('删除线路').every(button => button.disabled), '确认或DELETE待返回时阻止第二次删除');
    await click(remove('protected-disabled'));
    assert.equal(fixture.calls.length, 3, 'busy期间不得重复提交');
    await act(async () => fixture.complete({ success: true, data: { logicalModelId: 'logical-quality', offeringId: 'pending-disabled', removed: true } }));
    assert.equal(row('pending-disabled'), undefined);
    assert.equal(remove('protected-disabled').disabled, false);
    assert.equal(fixture.items[0].publicId, 'chat-quality'); assert.deepEqual(fixture.items[0].aliases, ['legacy-chat']);

    fixture.role = 'viewer'; await render('viewer'); await click(buttons('查看')[0]);
    assert.equal(buttons('删除线路').length, 0, '只读角色不可见写操作');
    assert.equal(fixture.calls.length, 3);
  } finally {
    if (root) await act(async () => root.unmount());
    await server.close(); await rm(cacheDir, { recursive: true, force: true }); dom.window.close();
    for (const name of names) globalThis[name] = previous[name];
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
    delete globalThis.__offeringDeleteFixture; delete globalThis.__offeringDeleteRouter; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
