import test from 'node:test';
import assert from 'node:assert/strict';
import { quickstartDraftScope, readQuickstartDraft, saveQuickstartDraft, clearQuickstartDraft } from '../src/lib/quickstartDraft.ts';

test('接入恢复只保留本会话描述，租户和账号隔离，过期或损坏不展示', () => {
  const previous = globalThis.sessionStorage;
  const values = new Map();
  globalThis.sessionStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  try {
    const scope = quickstartDraftScope('tenant-a', 'alice');
    assert.equal(quickstartDraftScope('tenant-a', undefined), null);
    assert.equal(readQuickstartDraft(scope), null);
    saveQuickstartDraft(scope, '给售后团队接入知识库问答');
    assert.equal(readQuickstartDraft(scope).intent, '给售后团队接入知识库问答');
    assert.equal(readQuickstartDraft(quickstartDraftScope('tenant-b', 'alice')), null);
    assert.equal(readQuickstartDraft(quickstartDraftScope('tenant-a', 'bob')), null);
    assert.deepEqual(Object.keys(JSON.parse(values.get(scope))).sort(), ['intent', 'updatedAt']);
    values.set(scope, JSON.stringify({ intent: '给售后团队接入知识库问答', updatedAt: Date.now() - 86400001 }));
    assert.equal(readQuickstartDraft(scope), null);
    values.set(scope, '{invalid');
    assert.equal(readQuickstartDraft(scope), null);
    saveQuickstartDraft(scope, '给售后团队接入知识库问答');
    clearQuickstartDraft(scope);
    assert.equal(readQuickstartDraft(scope), null);
    globalThis.sessionStorage = { getItem() { throw Error('disabled'); }, setItem() { throw Error('disabled'); }, removeItem() { throw Error('disabled'); } };
    assert.equal(readQuickstartDraft(scope), null);
    assert.doesNotThrow(() => saveQuickstartDraft(scope, '给售后团队接入知识库问答'));
    assert.doesNotThrow(() => clearQuickstartDraft(scope));
  } finally { globalThis.sessionStorage = previous; }
});
