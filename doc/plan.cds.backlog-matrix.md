# CDS 未完成事项矩阵 · 计划

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：规划中

## 定位

本文只跟踪不属于大期里程碑、但仍需要实施或裁决的 CDS 横向事项。已完成的 UF、GAP、L10N、FU 和 TEST 历史不再保留在计划中，可从 Git 历史和周报查询；长期风险应进入对应 `debt.cds.*` 台账。

新增事项必须有稳定 ID、优先级、完成条件和归属。完成后删除该行并把长期事实更新到设计、规则或债务文档，禁止继续累积实施日记。

## 当前矩阵

| ID | 优先级 | 事项 | 当前边界 | 完成条件 |
| --- | --- | --- | --- | --- |
| CDS-UX-01 | P0 | 统一 skill 扫描与服务端技术栈扫描 | 本地 cdscli 与服务端对 lockfile、包管理器和启动命令可能得出不同结果 | 同一 fixture 在两个入口生成一致的包管理器和命令；`package-lock.json` 明确使用 npm |
| CDS-UX-02 | P1 | 数据库节点直接浏览与初始化 | Mongo、MySQL、Postgres 卡片缺少统一的库、表、集合、容量和初始化入口 | 从节点进入即可查看结构并执行受控初始化；权限、失败和回滚可见 |
| CDS-UX-03 | P1 | 部署失败结构化归因 | 日志已有诊断，但卡片和部署页没有统一展示代码、配置、平台或上游故障 | 失败页返回权威分类、证据和下一动作，不由前端猜测 |
| CDS-UX-04 | P2 | 三条首次部署 E2E | compose 导入、skill 扫描和零配置创建缺少稳定真人路径回归 | 三条路径各有至少一条 Playwright 或 Bridge 冒烟并保留失败证据 |
| CDS-CANVAS-01 | P2 | 画布手势与视觉 token 防漂移 | CDS、Workflow、Visual Agent 技术栈不同，不能直接共享组件 | 共享 token 和手势契约有自动守卫；再次漂移时再评估共享包 |
| CDS-AUTH-01 | P2 | 多用户 GitHub Device Flow | 当前授权身份仍可能是实例级单值，多个用户或标签页会覆盖 | token 和 device flow 按用户隔离，并发授权互不覆盖 |
| CDS-CLUSTER-01 | P2 | 多仓库项目跨 executor 可调度 | clone 和 worktree 仍依赖主节点文件系统 | 远程 executor 能获得同一 repo/ref，部署和清理均通过验收 |
| CDS-DISCOVERY-01 | P3 | 多项目自动发现 | proxy 自动发现不扫描所有项目仓库；显式部署不受影响 | 自动发现按 project 隔离且不产生跨项目路由 |
| CDS-VOLUME-01 | P2 | 持久化卷 UI 完整性 | 数据模型支持 volumes，但入口和能力覆盖需按当前 React 页面复核 | 创建、编辑、删除、风险确认和重部署后持久化均可用 |

## 已知限制的归口

下列旧矩阵内容不再作为计划项：

- Mongo 单文档与 `state.json` 退场：`debt.cds.state-json.md`。
- 分支网络、共享别名和队列隔离：`debt.cds.branch-isolation.md`。
- 项目迁移和跨节点复制：`debt.cds.project-migration.md`。
- UI 视觉与响应性能：`debt.cds.performance.md`。

## 执行顺序

1. 先处理 P0 的扫描一致性，避免用户从不同入口得到不同配置。
2. 再完成部署失败归因和数据库节点操作，缩短首次接入与排障路径。
3. 补三条端到端冒烟，作为后续 React legacy 退场的前置证据。
4. 集群、多用户授权和自动发现按真实使用压力启动，不提前扩架构。

## 完成规则

- 修复必须落到服务端事实源，前端只展示权威状态。
- 每项至少有一个行为级测试；只有类型检查或静态页面不算完成。
- 涉及凭据、跨项目、跨节点或破坏性初始化时必须覆盖越权和回滚。
- 完成项不留在本表，不新增“已完成”长列表。

## 关联文档

- `doc/plan.cds.status.md`
- `doc/plan.cds.multi-project-phases.md`
- `doc/plan.cds.web-migration.md`
- `doc/design.cds.md`
- `doc/guide.cds.view-parity.md`
