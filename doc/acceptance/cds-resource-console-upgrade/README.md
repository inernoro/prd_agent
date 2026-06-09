# CDS Resource Console Upgrade Acceptance KB

This directory is the local acceptance knowledge base for the CDS branch resource console upgrade.

## Reports

| Date | Report | Verdict | Scope |
|---|---|---|---|
| 2026-06-09 | [acc-prd-agent-202606092359-cds-resource-console-permission-and-db-panels.md](./acc-prd-agent-202606092359-cds-resource-console-permission-and-db-panels.md) | Conditional pass | Resource permissions, external access TTL/allowlist, connect-existing, restore-backup new database, MongoDB/Redis/PostgreSQL readonly panels |
| 2026-06-09 | [acc-prd-agent-202606092242-cds-分支资源控制台升级.md](./acc-prd-agent-202606092242-cds-分支资源控制台升级.md) | Conditional pass | Branch resource chips, resource tab, resource detail panel, database connection and clone/backup entry points |

## Current Gap Ledger

The local acceptance KB now has two rounds of evidence. Round 2 covers permission gates, external access policy payloads, MySQL restore-backup new database entry points, connect-existing, and readonly database panels for MongoDB/Redis/PostgreSQL. Remaining gaps are remote CDS self-update, online KB archival, and non-MySQL backup/restore/clone executors.
