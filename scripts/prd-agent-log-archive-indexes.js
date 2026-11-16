// Operator migration: log data and cold objects are never removed here.
// Run with mongosh in the correct environment before enabling archive policies.
const business = db.getSiblingDB('prdagent');
business.log_archive_policies.createIndex({OwnerId: 1}, {name: 'uniq_log_archive_policy_owner', unique: true});
business.log_archive_batches.createIndex({OwnerId: 1, CreatedAt: -1}, {name: 'idx_log_archive_owner_created'});
business.log_archive_batches.createIndex({OwnerId: 1, 'Records.RequestId': 1}, {name: 'idx_log_archive_owner_request'});
// Build bounded source/UI indexes during a quiet window, before enabling migration.
if (process.env.PRD_ARCHIVE_BUILD_SOURCE_INDEXES === '1') {
  // One collection scan builds all indexes needed by the existing log page.
  business.apirequestlogs.createIndexes([
    {ColdArchiveId: 1, StartedAt: 1},
    {Status: 1, StartedAt: -1, Path: 1},
    {Path: 1, Status: 1},
    {AppName: 1},
    {Direction: 1},
  ], {maxTimeMS: 180000});
  business.llmrequestlogs.createIndex({ColdArchiveId: 1, StartedAt: 1}, {name: 'idx_cold_archive_time', maxTimeMS: 180000});
  const gateway = db.getSiblingDB('llm_gateway');
  gateway.llmrequestlogs.createIndex({TenantId: 1, ColdArchiveId: 1, StartedAt: 1}, {name: 'idx_cold_archive_tenant_time', maxTimeMS: 180000});
  gateway.llmgw_request_executions.createIndex({TenantId: 1, ColdArchiveId: 1, CreatedAt: 1}, {name: 'idx_cold_archive_tenant_time', maxTimeMS: 180000});
}
print('Log archive indexes ready; no log records removed.');
