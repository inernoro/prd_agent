# CDS 可视化部署与验收指南

> **类型**：guide（操作指南） · **版本**：v1.0 · **日期**：2026-06-01 · **状态**：可用
>
> 面向使用者：如何在 CDS 上「纯前端点点点」一键部署一个前后端 + 数据库 + 消息队列并验收跑通。
> 关联：`doc/plan.cds.visual-deploy.md`（计划看板）、`doc/design.cds.railway-onboarding-flow.md`（一键部署向导）、`doc/design.cds.ai-compose.md`（AI 生成 compose 备选）、`doc/spec.cds.compose-contract.md`（compose 契约）。

---

## 一、30 秒了解

CDS 是分支预览部署平台（mini-PaaS）。一个项目 = 一个 git 仓库；CDS 给每个分支起独立容器、绑定预览域名。本指南讲「从 0 部署一个前后端 + 基础设施」的可视化路径与验收清单。

核心能力（本轮强化后）：

- 一键部署向导：选仓库 → 选运行环境（11 个预设或自动识别）→ 选基础设施 → 创建即自动 clone + 栈检测 + 生成构建配置 + 部署。
- 基础设施一键可选，按类别分组：**数据库**（MongoDB / PostgreSQL / MySQL / SQL Server / ClickHouse）、**缓存**（Redis / Memcached）、**消息队列**（RabbitMQ / Kafka / NATS）、**搜索**（Elasticsearch）、**对象存储**（MinIO）。选中即自动生成持久化卷 + 注入连接环境变量（如 `DATABASE_URL` / `REDIS_URL` / `RABBITMQ_URL` / `KAFKA_BROKERS`）。
- 实时部署时间线：拉取代码 → 构建镜像 → 启动服务 → 健康检查，全程可视，杜绝空白等待。
- 新增基础设施类型只需在后端注册表 `cds/src/services/infra-catalog.ts` 加一条，UI 选择器与 `GET /api/infra/catalog` 自动出现，无需改前端。

---

## 二、一键部署一个前后端 + 基础设施（纯前端操作）

1. 打开项目列表，点击「一键部署项目」。
2. 选择仓库：填 Git URL 或用 GitHub 选择器；可填默认分支。
3. 选择应用服务：为前端、后端各选运行环境（自动识别 / Node.js / Python / .NET / Java / Go / Rust / PHP / 静态站点 / Dockerfile / 自定义）。前端默认入口 `/`，后端默认 `/api/`。
4. 选择基础设施：在分组选择器里勾选所需的数据库 / 缓存 / 消息队列等（可多选）。每项会自动生成持久化卷与连接环境变量。
5. 点击创建。CDS 自动 clone 仓库 → 检测技术栈 → 生成构建配置（BuildProfile）→ 起基础设施容器 → 起应用容器。
6. 观察实时时间线（拉取 → 构建 → 启动 → 健康检查）。任一阶段失败会在该阶段标红并给出原因。
7. 就绪后打开预览域名验收（v3 公式：`{tail}-{prefix}-{project}.<预览根域>`）。

无 `cds-compose.yml` 的仓库也能用：选了应用服务后，CDS 会按前端、后端分别生成构建配置，不会把你留在空白拓扑页。已有 `cds-compose.yml` / `docker-compose.yml` 的仓库则以其为最高优先级。

---

## 三、基础设施目录（SSOT）

后端唯一真源：`cds/src/services/infra-catalog.ts`。`GET /api/infra/catalog` 暴露脱敏视图（不含密码），前端选择器据此渲染。

| 类别 | 预设 | 镜像 | 端口 | 自动注入连接变量 |
|---|---|---|---|---|
| 数据库 | MongoDB | mongo:7 | 27017 | MONGODB_URL |
| 数据库 | PostgreSQL | postgres:16-alpine | 5432 | DATABASE_URL / POSTGRES_URL |
| 数据库 | MySQL | mysql:8 | 3306 | DATABASE_URL / MYSQL_URL |
| 数据库 | SQL Server | mssql/server:2022 | 1433 | SQLSERVER_URL |
| 数据库 | ClickHouse | clickhouse-server:24 | 8123 | CLICKHOUSE_URL |
| 缓存 | Redis | redis:7-alpine | 6379 | REDIS_URL |
| 缓存 | Memcached | memcached:1-alpine | 11211 | MEMCACHED_URL |
| 消息队列 | RabbitMQ | rabbitmq:3-management | 5672 | RABBITMQ_URL |
| 消息队列 | Apache Kafka | apache/kafka:3.7 (KRaft) | 9092 | KAFKA_BROKERS / KAFKA_URL |
| 消息队列 | NATS | nats:2-alpine | 4222 | NATS_URL |
| 搜索 | Elasticsearch | elasticsearch:8.11 | 9200 | ELASTICSEARCH_URL |
| 对象存储 | MinIO | minio/minio | 9000 | S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY |

新增一类基础设施：在 `INFRA_CATALOG` 加一条（id / name / category / image / port / volumePaths / build 闭包生成 env 与连接串）。无需改前端、无需改其他后端代码。

---

## 四、可直接学习的示例工程

仓库内 `cds/examples/` 下有自包含示例，均以 image + 命令 + 目录挂载运行（不构建自定义 Dockerfile），`cdscli verify` 评级 A：

| 示例 | 栈 / 基础设施 | 演示 | 关键端点 |
|---|---|---|---|
| `demo-admin-pg-redis` | 静态管理台 + Express + PostgreSQL + Redis | 管理台读写 PG 的 items 表、Redis 计数 | `/api/health` `/api/items` `/api/visits` |
| `demo-queue-rabbitmq` | 静态页 + Express + RabbitMQ | 发布 → 入队 → 消费 闭环 | `/api/health` `/api/publish` `/api/messages` |
| `demo-stream-kafka` | 静态页 + Express + Kafka(KRaft 单节点) | 生产 → topic → 消费 | `/api/health` `/api/produce` `/api/events` |
| `demo-events-nats` | 静态页 + Express + NATS | 发布 → subject → 订阅 | `/api/health` `/api/pub` `/api/sub` |

---

## 五、验收清单（逐项打勾）

- [ ] 项目创建成功，clone 完成无报错
- [ ] 栈检测生成了前端、后端构建配置（或读到了 cds-compose.yml）
- [ ] 所选基础设施容器已起、状态 running
- [ ] 应用环境变量里出现了对应连接串（DATABASE_URL / REDIS_URL / RABBITMQ_URL / KAFKA_BROKERS 等）
- [ ] 部署时间线四阶段（拉取 / 构建 / 启动 / 健康检查）依次走到就绪
- [ ] 预览域名打开返回 200，前端页面正常渲染
- [ ] 后端 `/api/health` 返回正常，且能读写所选基础设施（数据/消息真实往返）
- [ ] 数据库重启后数据仍在（持久化卷生效）

---

## 六、AI 生成 compose（备选，用户可配）

CDS 自身不内置大模型，AI 生成 `cds-compose.yml` 草稿走「借用」路线：复用 CDS Agent（用户在运行时 profile 里配 OpenRouter 的 baseUrl/key/model）或 prd-api 的 `ILlmGateway`。生成的是**草稿**，必须在可视化编辑器人工确认、并通过 `cdscli verify`（遇 ERROR 阻断）后才应用。确定性栈检测器始终是默认与兜底。详见 `doc/design.cds.ai-compose.md`。

---

## 七、本轮交付与验证状态（诚实记录）

- 已交付并验证：基础设施注册表 SSOT + `GET /api/infra/catalog` + 一键部署选择器接入（含 Kafka/NATS 等）；4 个示例工程（verify A）；部署时间线（既有，已确认接入分支详情）。后端/前端 `tsc` 全绿、全量 `vitest` 1796 通过、`cds` 技能 `pytest` 122 通过、示例 `cdscli verify` A 级。
- 运行验证：开发分支经 CDS 自动部署在预览平台上以「前后端 running」状态跑通（admin + api 均 running，预览域名返回 200），证明可视化部署链路端到端可用。
- 待后续：拓扑页新增基建选择器接 catalog（真随机密码）；Railway 式数据层操作（查询控制台 / 执行 init SQL / schema 浏览，设计见计划看板）；CLI 基建模板收敛到 `infra-catalog.ts`。新增的基础设施选择器需合并 main 后 CDS 自更新才在生产 UI 生效。
