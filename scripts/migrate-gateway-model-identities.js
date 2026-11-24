// DBA maintenance only. Dry run by default; never loaded by application startup.
// PRD_GATEWAY_DB=1 APPLY_GATEWAY_MODEL_IDENTITIES=1 mongosh <gateway-uri> this-file
if (process.env.PRD_GATEWAY_DB !== '1') throw new Error('请明确声明 PRD_GATEWAY_DB=1 并选择目标网关数据库');
const applyIdentities = process.env.APPLY_GATEWAY_MODEL_IDENTITIES === '1';
const identityCollection = db.getCollection('llmgw_logical_models');
const identityDocs = identityCollection.find({}, {
  _id: 1, TenantId: 1, ModelType: 1, PublicId: 1, Aliases: 1,
  MigratedFromPoolIds: 1, IdentityKeys: 1,
}).toArray();
const identityOwners = new Map();
const identityWrites = [];
for (const doc of identityDocs) {
  if (!doc.TenantId || !doc.ModelType || !doc.PublicId) throw new Error('旧模型身份不完整，请先修复后重试');
  const keys = [...new Set([doc.PublicId, ...(doc.Aliases || []), ...(doc.MigratedFromPoolIds || [])]
    .map(x => String(x).trim().toLowerCase()))].sort();
  for (const key of keys) {
    const namespaceKey = JSON.stringify([doc.TenantId, doc.ModelType, key]);
    const previous = identityOwners.get(namespaceKey);
    if (previous && previous !== doc._id) throw new Error('存在重复模型身份，未修改数据；请核对兼容标识与原公开模型');
    identityOwners.set(namespaceKey, doc._id);
  }
  if (JSON.stringify([...(doc.IdentityKeys || [])].sort()) !== JSON.stringify(keys)) {
    const observed = Object.prototype.hasOwnProperty.call(doc, 'IdentityKeys')
      ? { IdentityKeys: doc.IdentityKeys } : { IdentityKeys: { $exists: false } };
    identityWrites.push({ updateOne: { filter: { _id: doc._id, TenantId: doc.TenantId,
      PublicId: doc.PublicId, ...observed }, update: { $set: { IdentityKeys: keys } } } });
  }
}
if (applyIdentities) {
  if (identityWrites.length) {
    const changed = identityCollection.bulkWrite(identityWrites, { ordered: true });
    if (changed.matchedCount !== identityWrites.length) throw new Error('配置发生并发修改，请重新预检；未覆盖变更');
  }
  identityCollection.createIndex({ TenantId: 1, ModelType: 1, IdentityKeys: 1 }, {
    name: 'uniq_llmgw_model_identity_namespace', unique: true,
    partialFilterExpression: { 'IdentityKeys.0': { $exists: true } },
  });
}
print(JSON.stringify({ apply: applyIdentities, models: identityDocs.length,
  backfill: identityWrites.length, index: 'uniq_llmgw_model_identity_namespace' }));
