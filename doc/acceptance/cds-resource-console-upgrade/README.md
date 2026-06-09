# CDS Resource Console Upgrade Acceptance KB

This directory is the local acceptance knowledge base for the CDS branch resource console upgrade.

## Reports

| Date | Report | Verdict | Scope |
|---|---|---|---|
| 2026-06-10 | [acc-prd-agent-202606100120-cds-resource-danger-and-multidb-backups.md](./acc-prd-agent-202606100120-cds-resource-danger-and-multidb-backups.md) | Conditional pass | PostgreSQL/MongoDB/Redis backup and restore executors, PostgreSQL/MongoDB branch database clone/restore, dangerous operation API/UI |
| 2026-06-09 | [acc-prd-agent-202606092359-cds-resource-console-permission-and-db-panels.md](./acc-prd-agent-202606092359-cds-resource-console-permission-and-db-panels.md) | Conditional pass | Resource permissions, external access TTL/allowlist, connect-existing, restore-backup new database, MongoDB/Redis/PostgreSQL readonly panels |
| 2026-06-09 | [acc-prd-agent-202606092242-cds-分支资源控制台升级.md](./acc-prd-agent-202606092242-cds-分支资源控制台升级.md) | Conditional pass | Branch resource chips, resource tab, resource detail panel, database connection and clone/backup entry points |

## Current Gap Ledger

The local acceptance KB now has three rounds of evidence. Round 3 covers non-MySQL backup/restore executors, PostgreSQL/MongoDB branch database creation and clone/restore flows, dangerous-operation API/UI, and the MySQL clone exit-code fix.

Remaining gaps: real network-layer enforcement for dynamic TCP exposure/IP allowlist, frontend role-aware button visibility from authenticated user context, and non-placeholder metrics/infra logs. The exact `/create-visual-test-to-kb` skill is still unavailable in this environment; evidence is kept in this local KB and can be mirrored to the online document store.
