# CDS 多项目剩余交付 · 计划

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：规划中

## 1. 目标

收口 CDS 从单项目到多项目架构后仍未完成的团队 workspace、远程 executor 和迁移退场事项。P0-P4 与 P6 的已落地事实由设计、规格和代码承担，本文保留 P0-P6 编号，是因为代码注释和规则仍用这些阶段标识解释所属能力。

## 2. 当前总览

| 阶段 | 当前状态 | 事实源或剩余动作 |
| --- | --- | --- |
| P0 设计与规格 | 已落地 | `design.cds.multi-project.md`、`spec.cds.project-model.md` |
| P1 项目外壳 | 已落地 | React 项目列表与项目级路由已取代早期单项目外壳 |
| P2 认证 | 已落地 | GitHub OAuth、Device Flow 和 auth store 已有现行实现 |
| P3 Mongo 数据层 | 部分退场未完成 | 默认 `mongo-split` 已落地；`state.json` 影子写仍见 `debt.cds.state-json.md` |
| P4 多项目隔离 | 已落地，持续偿债 | 项目网络、projectId 过滤和分支隔离已落地；残留见 `debt.cds.branch-isolation.md` |
| P5 团队 workspace | 基础能力已落地 | 需要验证成员同步、RBAC 和跨 workspace 越权边界 |
| P6 手动项目与自动部署 | 已落地 | 手动创建、Webhook 和自动部署已有现行实现，不再作为待开发阶段 |

## 3. P0：设计文档

P0 已结束。后续架构变更只更新 canonical 文档，不恢复四份并行实施稿：

- 主设计：`doc/design.cds.multi-project.md`
- 数据模型：`doc/spec.cds.project-model.md`
- Mongo 迁移规则：`doc/rule.cds.mongo-migration.md`

## 4. P1：项目外壳

P1 已结束。当前验收基线是：

- 首次进入能看到项目列表和零项目引导。
- 项目路由、设置、分支和部署操作均携带明确 projectId。
- legacy default 项目只能作为兼容数据，不能成为新项目的隐式归属。

## 5. P2：GitHub 认证

P2 已结束，代码中的 `P2` 注释继续表示认证能力来源。仍需偿还的多用户 Device Flow 隔离归 `plan.cds.backlog-matrix.md`，不再把整期标为未完成。

## 6. P3：MongoDB 数据层迁移

当前默认存储模式为 `mongo-split`。P3 只剩退场工作：

1. 把仍混在全局状态中的项目元信息、BuildProfile 和 RoutingRule 拆到独立 collection。
2. 明确 Mongo 权威下的备份、恢复和降级读策略。
3. 删除 `state.json` 正常写路径，只保留一次性迁移读取；执行前必须验证回滚不会读取落后的影子数据。

详细顺序和风险以 `doc/debt.cds.state-json.md` 为准。

## 7. P4：多项目隔离

P4 的项目创建、projectId 过滤、项目网络和资源归属已经落地。后续验收只处理残留边界：

- 同一项目多分支网络别名和队列不能串台。
- 删除项目或分支时，容器、网络、worktree、路由和运行记录都按归属清理。
- 项目迁移不能写入目标 legacy/default 项目，也不能泄露节点级 access key。
- 所有列表、统计和事件查询必须按 project 或 workspace 过滤。

## 8. P5：团队 workspace 与成员同步

P5 是当前多项目主线的剩余阶段。完成条件：

1. workspace 创建、重命名、归档和成员管理有服务端权限校验。
2. GitHub Org 同步是可重试的增量同步，删除或降权不会被下次同步静默恢复。
3. owner、admin、member、viewer 的项目、分支、环境变量、部署和审计权限形成矩阵测试。
4. 同一用户跨 workspace 时，项目列表、运行记录、密钥和 Webhook 事件不串域。
5. 迁移旧项目到 workspace 有 dry-run、冲突提示和回滚记录。

## 9. P6：手动项目、Webhook 与自动部署

P6 已结束。后续只维护以下不变量：

- 手动创建和 GitHub Webhook 创建必须经过同一项目、分支和部署服务，不产生两套状态机。
- Webhook 重放、乱序和重复投递幂等。
- 自动部署失败产生结构化归因，并可在项目和分支视图追溯。
- 默认分支、远程分支和手动分支的来源明确，不根据名称猜测来源。

## 10. 验收矩阵

| 维度 | 必须证明 |
| --- | --- |
| 身份与权限 | 未登录、跨 workspace、项目 key 和系统管理员边界正确 |
| 数据隔离 | projectId、workspaceId、网络、队列、日志和密钥无串域 |
| 生命周期 | 创建、部署、停止、删除、迁移和恢复都有幂等与清理 |
| 兼容 | legacy default 项目可读，不能污染新项目写入 |
| 运维 | Mongo 备份恢复、Webhook 重放和 executor 故障可诊断 |
| 体验 | 零项目、无权限、缺配置和部署失败都有明确下一动作 |

## 11. 关联文档

- `doc/design.cds.multi-project.md`
- `doc/spec.cds.project-model.md`
- `doc/rule.cds.mongo-migration.md`
- `doc/debt.cds.state-json.md`
- `doc/debt.cds.branch-isolation.md`
- `doc/debt.cds.project-migration.md`
