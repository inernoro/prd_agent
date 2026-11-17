// Operator migration. Default is read-only; never enable the global TTL monitor here.
const retained = [
  ['llmgw_request_executions', 'ExpiresAt', 'ttl_llmgw_request_executions', 0],
  ['llmrequestlogs', 'StartedAt', 'ttl_llmgw_logs_started', 7776000],
  ['llmshadow_comparisons', 'ComparedAt', 'ttl_llmgw_shadow_compared', 2592000],
  ['llmgw_login_audits', 'CreatedAt', 'ttl_llmgw_login_audits', 15552000],
  ['llmgw_operation_audits', 'CreatedAt', 'ttl_llmgw_operation_audits', 15552000],
  ['llmgw_lifecycle_runs', 'StartedAt', 'ttl_llmgw_lifecycle_runs', 15552000],
];
const temporary = [
  ['llmgw_tenant_rate_windows', 'ttl_llmgw_tenant_rate_windows'],
  ['llmgw_provider_concurrency_slots', 'ttl_llmgw_provider_concurrency_slot'],
  ['llmgw_service_key_rate_windows', 'ttl_llmgw_service_key_rate_windows'],
  ['llmgw_app_caller_rate_windows', 'ttl_llmgw_rate_windows'],
  ['llmgw_cost_import_scope_locks', 'ttl_llmgw_cost_import_scope_locks'],
  ['llmgw_map_sso_tickets', 'ttl_llmgw_map_sso_expires'],
  ['llmgw_offering_rate_windows', 'ttl_llmgw_offering_rate_window'],
];
function matches(index, field, name, seconds) {
  return index.name === name && Object.keys(index.key).length === 1
    && index.key[field] === 1 && Number(index.expireAfterSeconds) === seconds
    && !index.unique && !index.partialFilterExpression;
}
function inspect() {
  const out = { temporary: [], protected: [], unknown: [], collectionTtl: [] };
  for (const name of db.getMongo().getDBNames()) {
    const database = db.getSiblingDB(name);
    for (const info of database.getCollectionInfos({ type: 'collection' })) {
      if (info.options && info.options.expireAfterSeconds !== undefined)
        out.collectionTtl.push({ database: name, collection: info.name });
      for (const index of database.getCollection(info.name).getIndexes()) {
        if (index.expireAfterSeconds === undefined) continue;
        const item = { database: name, collection: info.name, index: index.name };
        const preserve = name === 'llm_gateway' && retained.some(([collection, field, indexName, seconds]) =>
          info.name === collection && matches(index, field, indexName, seconds));
        const ephemeral = name === 'llm_gateway' && temporary.some(([collection, indexName]) =>
          info.name === collection && matches(index, 'ExpiresAt', indexName, 0));
        const session = name === 'config' && info.name === 'system.sessions'
          && matches(index, 'lastUse', 'lsidTTLIndex', 1800);
        out[preserve ? 'protected' : ephemeral || session ? 'temporary' : 'unknown'].push(item);
      }
    }
  }
  return out;
}
const before = inspect();
const apply = process.env.PRD_TTL_APPLY === '1';
if (before.unknown.length || before.collectionTtl.length)
  throw new Error('Unclassified expiration policy; keep global TTL paused');
const changed = [];
if (apply && before.protected.length) {
  const parameter = db.getSiblingDB('admin').runCommand({ getParameter: 1, ttlMonitorEnabled: 1 });
  if (parameter.ttlMonitorEnabled !== false) throw new Error('Pause TTL before protecting log indexes');
  const gateway = db.getSiblingDB('llm_gateway');
  for (const [collection, field, oldName] of retained) {
    const target = gateway.getCollection(collection);
    const index = target.getIndexes().find(item => item.name === oldName && item.expireAfterSeconds !== undefined);
    if (!index) continue;
    // Build query coverage before dropping only the expiration index. No records are removed.
    const key = { [field]: 1, _id: 1 };
    const normalName = 'idx_preserved_' + collection;
    target.createIndex(key, { name: normalName, maxTimeMS: 60000 });
    target.dropIndex(oldName);
    changed.push({ collection, removedExpirationIndex: oldName, preservedQueryIndex: normalName });
  }
}
const after = inspect();
print(JSON.stringify({ mode: apply ? 'apply' : 'audit', ...after, changed }));
