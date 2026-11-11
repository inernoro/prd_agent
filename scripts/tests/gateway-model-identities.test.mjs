import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../migrate-gateway-model-identities.js', import.meta.url), 'utf8');
function execute(docs, apply = false, matchedCount) {
  const calls = { writes: [], indexes: [], output: [] };
  const collection = {
    find: () => ({ toArray: () => docs }),
    bulkWrite: writes => { calls.writes.push(...writes); return { matchedCount: matchedCount ?? writes.length }; },
    createIndex: (...args) => calls.indexes.push(args),
  };
  vm.runInNewContext(script, {
    process: { env: { PRD_GATEWAY_DB: '1', APPLY_GATEWAY_MODEL_IDENTITIES: apply ? '1' : '0' } },
    db: { getCollection: name => { assert.equal(name, 'llmgw_logical_models'); return collection; } },
    print: line => calls.output.push(JSON.parse(line)),
  });
  return calls;
}
const fixed = { _id: 'fixed', TenantId: 'tenant', ModelType: 'generation', PublicId: 'gpt-image-2.6-flare' };
const stable = { _id: 'stable', TenantId: 'tenant', ModelType: 'generation', PublicId: 'image-quality', Aliases: ['IMAGE-2-ALL'] };
test('dry run checks namespace without mutating configuration or indexes', () => {
  const r = execute([fixed, stable]);
  assert.equal(r.writes.length, 0); assert.equal(r.indexes.length, 0);
  assert.equal(r.output[0].backfill, 2);
});
test('explicit apply backfills canonical and aliases and creates one namespace constraint', () => {
  const r = execute([fixed, stable], true);
  assert.equal(r.writes.length, 2); assert.equal(r.indexes.length, 1);
  assert.deepEqual(Array.from(r.writes[1].updateOne.update.$set.IdentityKeys), ['image-2-all', 'image-quality']);
  assert.equal(r.indexes[0][1].unique, true);
});
test('existing correct namespace is idempotent', () => {
  const r = execute([{ ...fixed, IdentityKeys: ['gpt-image-2.6-flare'] }], true);
  assert.equal(r.writes.length, 0);
});
test('disabled fixed version cannot be stolen by an alias', () => {
  assert.throws(() => execute([{ ...fixed, Enabled: false }, { ...stable, Aliases: [fixed.PublicId] }], true), /重复模型身份/);
});
test('tenants and model purposes have independent namespaces', () => {
  assert.equal(execute([fixed, { ...fixed, _id: 'other', TenantId: 'other' }]).output[0].models, 2);
});
test('concurrent configuration change stops before creating index', () => {
  assert.throws(() => execute([fixed], true, 0), /并发修改/);
});
