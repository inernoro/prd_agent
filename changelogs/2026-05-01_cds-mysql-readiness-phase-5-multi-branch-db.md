| feat | cds | Phase 5 — BuildProfile 加 `dbScope: 'shared' \| 'per-branch'` 字段(默认 shared 不破坏现有行为);BuildProfileOverride 同步加,允许单分支覆盖 |
| feat | cds | Phase 5 — 新增 services/db-scope-isolation.ts(applyPerBranchDbIsolation / slugifyBranchForDb / previewPerBranchDbDiff)。per-branch 模式自动给 MYSQL_DATABASE / POSTGRES_DB / MARIADB_DATABASE / MONGO_INITDB_DATABASE 等白名单 env key 后缀 `_<branchSlug>`,实现"同一 DB 实例下每分支独立 database"。幂等 + 白名单制度,杜绝意外破坏 |
| feat | cds | Phase 5 — container.ts runService 在 mergedEnv 收集完毕、resolveEnvTemplates 之前注入隔离,${MYSQL_DATABASE} 引用自动跟随。shared 模式 noop 保证现有项目零行为变化 |
| docs | cds | 新增 doc/guide.cds-multi-branch-db.md:开启方式 / env 白名单 / 连接串引用规范 / 已知边界 / 模式选择决策表 / 实现索引 |
| test | cds | 17 个新单测(tests/services/db-scope-isolation.test.ts):slugify / shared noop / per-branch 各 DB 类型 / 幂等 / 多分支隔离 / 不动非白名单 / preview diff |
| docs | cds | plan.cds-mysql-readiness.md § 五 Phase 5 ✅ 一行(MVP:核心隔离机制 done;UI 切换 / 自动建库 / GC / migration 冲突警告 留给 Phase 5.5+) |
