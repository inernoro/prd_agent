# CDS 绝对可视化部署 · 计划看板

> **类型**：plan（看板） · **版本**：v1.0 · **日期**：2026-06-01 · **状态**：进行中
>
> 目标：CDS 能纯前端点点点一键部署任意常用前后端（N 个）+ 数据库 + 缓存 + 消息队列并跑起来；新增基建便捷；数据库初始化/修改友好；借鉴 Railway 的数据层控制思路；AI 生成 compose 作为可配置备选。
>
> 关联：`doc/plan.cds-status.md`（CDS 总状态看板）、`doc/design.cds-railway-onboarding-flow.md`（已落地的一键部署向导）、`doc/design.cds-ai-compose.md`（AI 备选路径设计）、`doc/spec.cds-compose-contract.md`（compose 契约 SSOT）。

---

## 一、30 秒了解

CDS 此前已落地 Railway 式一键部署向导（11 运行时预设 + 自动栈检测 + MongoDB/PostgreSQL/MySQL/Redis/RabbitMQ 五个基建预设 + SSE 部署事件）。本计划补齐与放大其中的硬缺口：

- 基建预设此前散落在后端 if-blocks、CLI 模板、前端两处镜像表中，互相漂移（Kafka/NATS 只在 CLI 有、后端存不下）。
- 没有可视化部署时间线，只有状态徽标。
- 没有 UI 内数据库操作（查询/初始化/schema 浏览），Railway 式数据层控制缺失。
- CDS 自身零 LLM，AI 生成 compose 属于未建能力。

## 二、工作流与状态

| # | 工作流 | 交付 | 状态 |
|---|--------|------|------|
| W1 | 基建注册表 SSOT | `cds/src/services/infra-catalog.ts` 单一注册表（12 个预设，含 Kafka/NATS）；后端 `createInfraPreset` 改读注册表；`GET /api/infra/catalog` 脱敏端点；新增基建=注册表加一条 | 已完成（tsc + 1796 vitest 全绿，9 例新单测） |
| W1-UI | 一键部署弹窗基建选择器 | 改读 `/api/infra/catalog`，按类别分组展示全部预设（含消息队列） | 已完成（web tsc 全绿） |
| W2 | 精选自包含示例 | `cds/examples/demo-admin-pg-redis`（PG+Redis 管理台）/ `demo-queue-rabbitmq` / `demo-stream-kafka` / `demo-events-nats`，全部 image+命令+挂载、`cdscli verify` A 级 | 已完成（A/98、A/100×3） |
| W5 | AI 生成 compose 设计 | `doc/design.cds-ai-compose.md`：借用 CDS Agent/OpenRouter 生成草稿 → 可视化编辑器人工确认；确定性检测器为默认兜底；用户可配开关 | 已完成（设计文档） |
| W1-Topo | 拓扑页新增基建选择器 | 改读 `/api/infra/catalog`；预设走真随机密码 + 自动连接变量（修 change-me 占位弱点） | 待办 |
| W3 | 可视化部署时间线 | 订阅 SSE `branch.deploy-step`，渲染「拉取→构建→启动→就绪→路由」实时时间线 | 待办 |
| W4 | Railway 式数据层操作 | infra 卡片「数据」面板：查询控制台 + 执行 init SQL + schema 浏览（backup/restore 已有） | 待办（用户已同意必要时先交查询+schema，init-SQL 顺延） |
| RUN | 生产建独立 demo 跑通 | 在 cds.miduo.org 用独立命名建 demo 项目，部署前后端+基建并验证运行 | 待办（见 §四验证现实） |
| KB | 部署验收知识库 | 全流程归档进新建「CDS 部署验收知识库」并出分享链 | 待办 |

## 三、关键设计决策

- **注册表 SSOT**：后端 `infra-catalog.ts` 是唯一真源；CLI 的 `_INFRA_TEMPLATES` 与前端选择器都应最终收敛到它（CLI 收敛为后续项）。连接变量名保持历史命名（MONGODB_URL/DATABASE_URL/REDIS_URL/RABBITMQ_URL）以兼容存量项目。
- **借用而非自造（#9）**：CDS 不自建 LLM 栈；AI 生成 compose 借用现有 CDS Agent sidecar（用户在运行时 profile 里配 OpenRouter 的 baseUrl/key/model）或 prd-api 的 `ILlmGateway`（Lite 只读）。详见 `design.cds-ai-compose.md` 与 `.claude/rules/no-rootless-tree.md`。
- **算/发两阶段**：AI「生成草稿」与「应用到项目」分离；应用前必过 `cdscli verify`，遇 ERROR 阻断（`.claude/rules/compute-then-send.md`）。
- **示例自包含**：CDS 以 image+命令+目录挂载运行，不构建自定义 Dockerfile，故示例不用真实热门仓库（多数需 build），改用仿热门栈的自包含工程，保证必跑通。

## 四、验证现实（诚实记录）

- 本会话沙盒**无本地 Docker daemon**，无法在本地起容器，故 `cds/` 改动用 `tsc`（前后端）+ 全量 `vitest`（1796 通过）+ `cdscli verify`（示例 A 级）做静态与单元验证。
- CDS 工具自身运行在 `cds.miduo.org`，通过自更新从 `main` 拉取；**本分支对 `cds/` 的改动在合并 main 前不会出现在 `cds.miduo.org`**。因此「新选择器里 Kafka/NATS 可见」当前由 tsc+vitest 保证，合并自更新后才在生产 UI 可见。
- 分支预览域名部署的是仓库根的主应用（prd-api/prd-admin），不是 CDS 子工具，故 CDS UI 不能用分支预览验收。
- RUN（#7）：将在 `cds.miduo.org`（用户已授权建独立 demo 项目）用现网 CDS + 示例验证「前后端可一次性跑起来」的端到端能力，并附可复现 runbook。

## 五、下一步

1. W3 部署时间线（前端组件 + 契约测试）。
2. W4 数据层操作（后端 `infra-data.ts` 查询/initSQL/schema + 前端面板）。
3. W1-Topo 拓扑页选择器接 catalog + 真密码预设端点。
4. 收敛 CLI `_INFRA_TEMPLATES` 到 `infra-catalog.ts`（消除三处漂移的最后一处）。
5. RUN + KB。
