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
  const fixture = { role: 'admin', reads: 0, calls: [], checks: [], deleted: [], prompts: [], typed: 'exact', failure: null, pending: false,
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
        if (name === 'checkLogicalModelDeletion') return 'export async function checkLogicalModelDeletion(id){const f=globalThis.__offeringDeleteFixture;f.checks.push(id);return {success:true,data:{canDelete:id!=="blocked-model",reasons:id==="blocked-model"?["仍有业务配置，请先迁移"]:[],offerings:17}}}';
        if (name === 'deleteLogicalModel') return 'export async function deleteLogicalModel(id){const f=globalThis.__offeringDeleteFixture;f.deleted.push(id);return {success:true,data:{offeringsDeleted:0}}}';
        if (name === 'deleteModelOffering') return 'export async function deleteModelOffering(logicalId,offeringId){const f=globalThis.__offeringDeleteFixture;f.calls.push({logicalId,offeringId});if(f.pending)return new Promise(resolve=>{f.complete=resolve});if(f.failure)return {success:false,error:{code:"OFFERING_IN_USE",message:f.failure}};f.items=f.items.map(x=>x.id===logicalId?{...x,offerings:x.offerings.filter(o=>o.id!==offeringId)}:x);return {success:true,data:{logicalModelId:logicalId,offeringId,removed:true}}}';
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
    const render = key => act(async () => root.render(React.createElement(globalThis.__offeringDeleteRouter.MemoryRouter, { initialEntries: ['/logical-models?references=old-model'] }, React.createElement(LogicalModelsPage, { key }))));
    await render('admin');
    assert.doesNotMatch(document.body.textContent, /升级与引用|升级记录与遗漏|修复失效引用|全量使用位置|旧引用残留|待处理/);
    assert.equal(document.querySelector('[data-testid="model-reference-migration-panel"]'), null);
    assert.ok(buttons('新建模型').length);
    assert.ok(buttons('绑定上游').length && buttons('测试').length && buttons('删除').length);
    await click(buttons('绑定上游')[0]); assert.ok(buttons('保存绑定').length);
    await click(document.querySelector('[aria-label="关闭详情"]'));
    await click(buttons('测试')[0]);
    assert.equal(buttons('保存绑定').length, 0, '行内测试不能带出前次关闭的空白绑定表单');
    await click(document.querySelector('[aria-label="关闭详情"]'));
    await click(buttons('查看')[0]);
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
    assert.equal(fixture.reads, 2, '删除后重新读取服务端权威线路状态');
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
    fixture.items[0].offerings = fixture.items[0].offerings.filter(offering => offering.id !== 'pending-disabled');
    await act(async () => fixture.complete({ success: true, data: { logicalModelId: 'logical-quality', offeringId: 'pending-disabled', removed: true } }));
    assert.equal(row('pending-disabled'), undefined);
    assert.equal(remove('protected-disabled').disabled, false);
    assert.equal(fixture.items[0].publicId, 'chat-quality'); assert.deepEqual(fixture.items[0].aliases, ['legacy-chat']);

    fixture.role = 'viewer'; await render('viewer'); await click(buttons('查看')[0]);
    assert.equal(buttons('删除线路').length, 0, '只读角色不可见写操作');
    assert.equal(fixture.calls.length, 3);
    fixture.role = 'admin'; fixture.pending = false;
    fixture.items = ['safe-model', 'blocked-model'].map(id => ({...fixture.items[0], id, publicId:id, name:id, enabled:false, isDefaultForType:false, defaultForAppCallerCodes:[], offerings:[]}));
    await render('batch'); await click(buttons('选择已停用')[0]);
    fixture.typed = null; await click(buttons('删除所选')[0]);
    assert.deepEqual(fixture.deleted, [], '预检和取消确认不能执行删除');
    assert.deepEqual(fixture.checks, ['safe-model', 'blocked-model']);
    assert.match(fixture.prompts.at(-1).description, /safe-model.*全部 17 条线路/, '确认数包含服务端返回的隐藏旧版线路，不能采用可见0条');
    assert.match(fixture.prompts.at(-1).description, /含被替换的旧版/);
    await act(async () => { const select = document.querySelector('select[aria-label="清单状态筛选"]'); select.value = 'disabled'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(buttons('删除')[0]);
    assert.match(fixture.prompts.at(-1).description, /全部 17 条线路/, '单项删除也使用服务端计数');
    fixture.typed = 'exact'; await click(buttons('删除所选')[0]);
    assert.deepEqual(fixture.deleted, ['safe-model'], '仅删除预检通过项，保留有引用模型');
    assert.match(fixture.prompts.at(-1).description, /blocked-model.*仍有业务配置/);
    assert.match(document.body.textContent, /已删除 1\/2/);
    assert.equal(buttons('下一页').length, 0);
  } finally {
    if (root) await act(async () => root.unmount());
    await server.close(); await rm(cacheDir, { recursive: true, force: true }); dom.window.close();
    for (const name of names) globalThis[name] = previous[name];
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
    delete globalThis.__offeringDeleteFixture; delete globalThis.__offeringDeleteRouter; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
