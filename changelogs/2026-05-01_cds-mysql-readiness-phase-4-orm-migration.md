| feat | cds-skill | Phase 4 — cdscli scan 新增 6 种 ORM 自动识别(prisma / ef-core / typeorm / sequelize / rails / flyway),命中后把 migration 命令注入应用 command 启动前缀,链式 `<wait-for-db> && <migrate> && <用户原 command>` |
| feat | cds-skill | Phase 4 — `_wrap_with_migration` helper:幂等检查(原 command 已含 prisma/ef/sequelize 等关键词不重复注入)+ flyway 等无注入 ORM 跳过 |
| feat | cds-skill | Phase 4.3 — 自动生成 `x-cds-deploy-modes`:支持 seed 的 ORM(prisma/sequelize/rails)输出 dev / prod 双模式,默认 prod(无 seed,不污染数据库),用户在 CDS UI 切 dev 启用 seed |
| feat | cds-skill | Phase 4 — scan 输出新增 `signals.orms` / `signals.schemafulInfra` / `signals.deployModes` 三字段,_emit_scan_result 摘要里也带 ORM 注入提示 |
| docs | cds | 新增 doc/guide.cds-orm-support.md:6 种 ORM 支持矩阵 + 用户使用方法 + 维护者扩展指南 + 6 条不要做的事 + 与 Phase 1-6 关系图 |
| test | cds-skill | 9 个 pytest fixture(.claude/skills/cds/tests/test_orm_phase4.py):5 种 ORM 识别 + 无 ORM 返回 None + _wrap_with_migration 幂等 + e2e Prisma+MySQL 完整链路 + 无 ORM 项目无 deploy-modes |
| docs | cds | plan.cds-mysql-readiness.md § 五 Phase 4 ✅ 一行 |
