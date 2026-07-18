# CDS 当前工作看板 · 计划

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：规划中

## 〇、配置体系三波演进

配置树已经形成“全局、项目、分支、派生分支快照”的服务端权威，repo compose 只承担结构种子。当前不再按旧波次重复记已完成文件，后续只守住四条不变量：

1. effective config 能解释每个值的来源、覆盖层和敏感性。
2. 派生分支按已选来源复制快照，不在运行时隐式追随父分支变化。
3. repo compose 与权威配置的 drift 可扫描、可预览、可选择性应用。
4. 平台注入密钥、数据库和队列隔离值时，不覆盖用户显式配置，也不向 UI 泄露明文。

## 一、30 秒现状

| 维度 | 当前结论 |
| --- | --- |
| 控制面 | Node、Express、MongoDB；默认 `mongo-split` |
| Web | React 控制台是 dashboard 权威；`web-legacy` 只待物理退场 |
| 项目 | 多项目、项目网络、GitHub 绑定、手动创建和自动部署已落地 |
| 分支 | 分支级入口、配置覆盖、额外服务、数据库与队列隔离已有实现 |
| Agent | 官方 SDK 商业闭环仍受 runtime profile 和真实 provider 证据约束 |
| 高可用 | 调度与多节点代码存在，真实两 executor 故障迁移证据仍不足 |
| 存储 | `state.json` 正常写路径尚未退场，是明确债务 |

当前主线按优先级只有四条：

1. 收口 React legacy 功能差距并在授权后删除旧前端。
2. 关闭 CDS Agent 官方 SDK 的真实 provider、审批与停止证据。
3. 完成多节点高可用真实部署和故障演练。
4. 继续拆分 Mongo 权威数据并退场 `state.json` 影子写。

## 二、里程碑状态

| 能力 | 状态 | 当前入口 |
| --- | --- | --- |
| 项目与分支基础设施 | 已落地 | `design.cds.md`、`spec.cds.project-model.md` |
| GitHub 授权与 Webhook | 已落地 | `guide.cds.github-webhook-events.md` |
| MySQL、Postgres、Mongo 接入 | 已落地，持续兼容验证 | `guide.cds.orm-support.md` |
| 多项目隔离 | 已落地，残留偿债 | `plan.cds.multi-project-phases.md`、`debt.cds.branch-isolation.md` |
| React 控制台 | 现行权威，旧代码待删 | `plan.cds.web-migration.md` |
| Agent 工作台 | Lite 可用，官方 SDK 商业闭环未关闭 | `plan.cds.agent.official-sdk-migration.md` |
| 高可用与多 executor | 代码已具备，真实运行验证未关闭 | `plan.cds.resilience-rollout.md` |
| 集群 bootstrap | 规划中 | `design.cds.cluster-bootstrap.md` |

## 三、未完成事项归口

| 类型 | 唯一入口 |
| --- | --- |
| 横向产品与体验事项 | `plan.cds.backlog-matrix.md` |
| 多项目与 workspace | `plan.cds.multi-project-phases.md` |
| React legacy 退场 | `plan.cds.web-migration.md` |
| 多节点高可用 | `plan.cds.resilience-rollout.md` |
| Agent 官方 SDK | `plan.cds.agent.official-sdk-migration.md` |
| 存储、隔离、迁移与性能风险 | 对应 `debt.cds.*.md` |

已完成故障、旧分支名、测试数量和临时预览地址不进入本看板；这些由 Git 历史、周报和 CI 证据承担。

## 四、开始 CDS 任务的顺序

1. 读本页确认任务归口。
2. 读对应 design、spec 或 debt，确认当前事实和边界。
3. 在 `plan.cds.backlog-matrix.md` 搜索稳定 ID，避免重复登记。
4. 实现后跑 backend/web 类型检查、聚焦单测和行为级冒烟。
5. 若涉及控制台，走真实导航入口完成双主题验收。
6. 完成项从计划移除；长期事实更新设计，未偿还边界更新债务。

## 五、维护规则

- 本页只写当前主线和归口，不写分支名、临时 commit、一次性日志或已完成长清单。
- 同一事项不得同时在 status、roadmap、handoff 和独立 plan 中维护。
- 新 blocker 必须能归入现有计划或债务；无法归入时先判断是否真的需要新文档。
- 页面展示、API 状态和本文结论冲突时，以运行时服务端事实为准，并立即校正文档。
