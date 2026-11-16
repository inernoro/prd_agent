// Operator migration: log data and cold objects are never removed here.
// Run with mongosh in the correct environment before enabling archive policies.
const business = db.getSiblingDB('prdagent');
business.log_archive_policies.createIndex({OwnerId: 1}, {name: 'uniq_log_archive_policy_owner', unique: true});
business.log_archive_batches.createIndex({OwnerId: 1, CreatedAt: -1}, {name: 'idx_log_archive_owner_created'});
business.log_archive_batches.createIndex({OwnerId: 1, 'Records.RequestId': 1}, {name: 'idx_log_archive_owner_request'});
// Build source indexes separately during a quiet window; existing time indexes support the first pass.
if (process.env.PRD_ARCHIVE_BUILD_SOURCE_INDEXES === '1') {
  for (const name of ['apirequestlogs', 'llmrequestlogs']) {
    business.getCollection(name).createIndex({ColdArchiveId: 1, StartedAt: 1}, {name: 'idx_cold_archive_time'});
  }
  const gateway = db.getSiblingDB('llm_gateway');
  gateway.llmrequestlogs.createIndex({TenantId: 1, ColdArchiveId: 1, StartedAt: 1}, {name: 'idx_cold_archive_tenant_time'});
  gateway.llmgw_request_executions.createIndex({TenantId: 1, ColdArchiveId: 1, CreatedAt: 1}, {name: 'idx_cold_archive_tenant_time'});
}
print('Log archive metadata indexes ready; no log records removed.');
