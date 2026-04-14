| feat | cds | P4 Part 3a 数据层 project scoping：`BranchEntry` / `BuildProfile` / `InfraService` / `RoutingRule` 四个接口新增 `projectId?` 字段 |
| feat | cds | `StateService.migrateProjectScoping()` 在 load 时把 pre-P4 entries 全部标为 `'default'`；`addBranch` / `addBuildProfile` / `addInfraService` / `addRoutingRule` 在 projectId 缺失时自动填 `'default'`，保证运行时不变量：每个 entry 必有 projectId |
| feat | cds | 新增四个 read-only helper：`getBranchesForProject(id)` / `getBuildProfilesForProject(id)` / `getInfraServicesForProject(id)` / `getRoutingRulesForProject(id)`，为 Part 3b 的 project-scoped 路由铺路 |
| test | cds | 新增 `tests/services/state-project-scoping.test.ts` 13 条（迁移幂等性 + add*() 自动填充 + helpers 过滤正确性 + defensive fallback），全量测试 362 → **375 零回归** |
| docs | cds | `doc/plan.cds-multi-project-phases.md` P4 section 更新为 Part 1/2/3a 已落地 + Part 3b 待办 |
