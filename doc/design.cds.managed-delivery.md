# CDS 托管交付契约 · 设计

> **版本**：v1.0 | **日期**：2026-07-10 | **状态**：开发中

## 一、管理摘要

- **解决什么问题**：CDS 的部署事实分散在分支状态、服务状态、OperationLog、SSE、容器日志、CLI 轮询和 GitHub Check 中，部署中断后难以恢复完整过程，用户和 Agent 需要跨多个入口判断根因。
- **方案概述**：引入持久化 `DeploymentRun` 作为部署过程唯一事实源，引入不可变 `DeploymentVersion` 分离构建与部署，并用 `managed` / `compose` 双模式降低常规项目的配置自由度。
- **业务价值**：让部署过程可恢复、版本可复用、失败可解释；常规项目只声明所需能力，不再手工维护大量 BuildProfile、连接串和调试步骤。
- **影响范围**：CDS 类型、状态持久化、部署路由、事件流、CLI、Dashboard、GitHub Check、项目配置和测试体系。
- **预计风险**：中 — 部署路由是高复杂度核心链路，必须采用纯增量模型、双读兼容和逐入口接入，禁止一次性替换现有 OperationLog。

## 二、问题背景

CDS 已具备多语言、多容器、分支隔离、远端执行器、预构建镜像、发布、回滚、日志归档和故障诊断能力。当前主要问题不是缺少功能，而是同一部署被多个状态模型分别描述：`BranchEntry.status` 表示分支汇总态，`ServiceState` 表示容器态，`OperationLog` 只在部署收尾时完整追加，SSE 负责在途进度，GitHub Check 和 CLI 又分别推导一次结果。

这会产生三个直接后果：第一，CDS 进程或请求流中断时，部署历史可能缺失，只能根据分支错误和容器状态合成兜底记录；第二，构建、启动、健康检查和运行态变更混在一次可变部署里，同一 commit 重新部署时仍可能重复构建；第三，自动部署、手动部署、远端执行器和 CLI 各自维护部分流程，规则与行为容易漂移。

Codex Sites 值得借鉴的部分不是特定运行时，而是控制面契约：项目清单很薄、平台拥有资源绑定、保存版本与部署版本分离、一个任务内完成构建验证与发布。CDS 保留任意 Docker 工作负载的能力，但为常规项目新增托管车道。

## 三、设计目标

| 目标 | 说明 |
|------|------|
| 部署事实唯一 | 每次部署在任何副作用发生前创建 `DeploymentRun`，所有消费者读取同一事实 |
| 过程可恢复 | CDS 重启、浏览器断线或执行器切换后，可按 `runId + seq` 恢复状态和增量事件 |
| 构建部署解耦 | `DeploymentVersion` 固化 commit、产物、配置和迁移，重复部署不重新构建 |
| 常规项目低配置 | `managed` 模式只声明应用入口、健康契约和能力绑定，CDS 生成生效配置 |
| 失败可解释 | 失败点写结构化分类、责任侧和证据引用，AI 只做解释，不充当事实源 |
| 高级能力不退化 | 现有 compose、BuildProfile、远端执行器和分支覆盖继续可用 |

| 非目标 | 说明 |
|--------|------|
| 删除 compose 模式 | 特殊网络、多服务和自定义运行时仍需要完整控制能力 |
| 重写全部 legacy 前端 | 本目标只接入部署与诊断相关页面，不扩大迁移范围 |
| 限制为 JavaScript 站点 | CDS 继续支持 .NET、Node.js、Python、Go、Rust、Java 等工作负载 |
| 用 LLM 替换确定性诊断 | LLM 只能消费结构化事实，不能根据原始日志猜最终状态 |

## 四、核心设计决策

### 决策 1：DeploymentRun 是部署过程唯一事实源

**结论**：所有本地、远端、Webhook、手动、重试和调度器部署先创建 `DeploymentRun`，再执行 pull、build、start、ready 和 smoke。

| 方案 | 优势 | 劣势 | 判定 |
|------|------|------|------|
| 继续扩展 OperationLog | 改动少 | 只在收尾追加、无稳定 id 和续传序号，仍无法覆盖中断 | 放弃 |
| 新增 DeploymentRun | 可在入口持久化、按序追加、跨重启恢复 | 需要双读迁移期 | 选定 |
| 直接复用 ServiceDeployment | 已有 seq 和持久日志 | 语义只覆盖 shared-service，字段和阶段不适合分支部署 | 借模式，不复用实体 |

**理由**：`ServiceDeployment` 已验证“先建记录、阶段追加、SSE 续传”的模式可行；分支部署应复用该模式，但保持独立领域实体，避免把 shared-service 与分支运行混在一起。

### 决策 2：保存版本与部署版本分离

**结论**：构建成功后生成不可变 `DeploymentVersion`，启动、重启、回滚只消费版本，不重新解释源代码和可变配置。

| 方案 | 优势 | 劣势 | 判定 |
|------|------|------|------|
| 每次部署现场解析并构建 | 灵活 | 重复耗时，运行事实容易受当前配置漂移影响 | 仅保留为源码开发模式 |
| 固化 DeploymentVersion | 可复用、可回滚、可证明运行内容 | 需要产物和配置快照 | 选定 |

**理由**：版本必须回答“代码、镜像、配置、迁移、健康契约分别是什么”。分支当前状态只保存正在运行的版本引用，不再承担版本本身。

### 决策 3：managed 与 compose 是两条正式车道

**结论**：项目显式选择 `managed` 或 `compose`。`managed` 由 CDS 生成 BuildProfile 和资源注入；`compose` 保留现有全部能力。

| 模式 | 适用对象 | 用户负责 | CDS 负责 |
|------|----------|----------|----------|
| managed | 常规 Web、API、Worker | 应用目录、入口、健康路径、能力需求 | 技术栈检测、构建配置、端口、依赖、资源和连接注入 |
| compose | 多服务、特殊网络、自定义镜像 | 完整服务拓扑与高级参数 | 解析、隔离、调度、执行和观测 |

**理由**：降低调试成本的主要手段是减少自由度，而不是继续添加配置帮助文档。高级模式仍是必要逃生口。

### 决策 4：结构化失败先于 AI 解释

**结论**：失败发生位置必须写入稳定错误码、责任侧、可重试性和证据引用；AI 只基于这些事实生成说明和最小修复建议。

| 层 | 职责 |
|----|------|
| 事实层 | 状态机、错误码、退出码、服务、阶段、证据引用 |
| 规则层 | 确定性分类、责任侧、是否重试、恢复动作 |
| 解释层 | 面向用户的大白话摘要、跨服务影响、建议顺序 |

## 五、整体方案

### 架构概览

```text
Webhook / UI / CLI / Scheduler
              |
              v
       DeploymentRunService
       begin -> append -> finish
              |
      +-------+--------+
      |                |
      v                v
DeploymentPlanner   DeploymentExecutor
生成或复用版本       pull/build/start/ready/smoke
      |                |
      v                v
DeploymentVersion   DeploymentRunEvent
不可变交付物          持久追加、seq 续传
      |                |
      +-------+--------+
              v
 UI / CLI / GitHub Check / AI Diagnosis
       只读同一 run 与 version
```

### 核心流程

1. 部署入口完成权限、项目和分支存在性校验。
2. `DeploymentRunService.begin()` 创建 `pending` 记录并立即持久化，返回 `runId`。
3. 操作协调器取得租约后，run 进入 `queued` 或 `preparing`；每次阶段变化追加带 `seq` 的事件。
4. Planner 根据 commit、项目模式、BuildProfile 和能力绑定，复用已有版本或创建构建计划。
5. Executor 执行本地或远端部署，所有输出通过统一事件写入，而不是仅写响应 SSE。
6. 构建成功后固化 `DeploymentVersion`；启动与健康检查引用该版本。
7. Run 进入终态后，兼容层生成旧 `OperationLog` 供历史消费者读取。
8. SSE、CLI、GitHub Check 和 Dashboard 按 `runId` 读取快照与增量事件。

## 六、数据设计

### DeploymentRun

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 稳定 runId，入口处生成 |
| projectId / branchId | string | 所属项目与分支 |
| trigger | enum | webhook、manual、retry、scheduler、system |
| status | enum | pending、queued、preparing、building、starting、verifying、running、failed、cancelled |
| phase | string | 当前细分阶段 |
| seq | number | 事件递增序号 |
| commitSha | string? | 本轮锚定提交 |
| versionId | string? | 生成或复用的 DeploymentVersion |
| operationId / executorId | string? | 操作租约与执行器关联 |
| configHash | string? | 生效配置快照哈希 |
| startedAt / updatedAt / finishedAt | string | 生命周期时间 |
| heartbeatAt | string? | 长阶段存活证明 |
| failure | DeploymentFailure? | 结构化失败 |
| events | DeploymentRunEvent[] | 有界、持久、追加式事件 |

### DeploymentRunEvent

| 字段 | 类型 | 说明 |
|------|------|------|
| seq | number | run 内严格递增 |
| at | string | 事件时间 |
| phase | string | 所属阶段 |
| level | enum | info、warn、error |
| status | string | 阶段状态 |
| message | string | 已脱敏的人类可读说明 |
| detail | object? | 有界结构化详情 |
| evidenceRefs | string[]? | 容器日志、构建日志、检查结果等引用 |

### DeploymentFailure

| 字段 | 类型 | 说明 |
|------|------|------|
| code | string | 稳定错误码，如 `build.compile.csharp` |
| owner | enum | code、config、cds、external、unknown |
| retryable | boolean | 原操作是否可直接重试 |
| summary | string | 最短可信原因 |
| serviceId / phase | string? | 失败服务与阶段 |
| evidenceRefs | string[] | 支撑结论的证据 |
| suggestedAction | string? | 确定性恢复动作 |

### DeploymentVersion

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 内容寻址或稳定随机 id |
| projectId / branchId | string | 所属范围 |
| commitSha | string | 源码锚点 |
| configHash | string | 生效配置快照哈希 |
| profiles | object[] | 每个服务的镜像 digest、命令、端口和健康契约 |
| migrations | object[] | 本版本需执行的数据迁移及校验摘要 |
| capabilities | object[] | 本版本绑定的数据库、缓存、存储和身份能力 |
| createdByRunId | string | 生成此版本的 run |
| createdAt | string | 创建时间 |

`DeploymentVersion` 创建后不可原地修改。任何配置、镜像或迁移变化都生成新版本。

### ManagedAppSpec 与能力绑定

| 字段 | 说明 |
|------|------|
| mode | `managed` 或 `compose` |
| appPath | 应用相对仓库目录 |
| workload | web、api、worker |
| health | HTTP 路径或 TCP 存活契约 |
| capabilities | database、cache、assets、identity、secrets 等声明 |

能力绑定只保存逻辑引用，不把密钥放进仓库。CDS 在生成生效配置时解析实际资源，并在 DeploymentVersion 中记录不含敏感值的来源与指纹。

## 七、状态机与接口设计

### DeploymentRun 状态机

| 当前状态 | 允许进入 | 说明 |
|----------|----------|------|
| pending | queued、preparing、cancelled、failed | 记录已落盘，尚未执行副作用 |
| queued | preparing、cancelled、failed | 等待构建槽或执行器 |
| preparing | building、starting、cancelled、failed | 拉取、解析、期望清单收敛 |
| building | starting、cancelled、failed | 生成或确认不可变版本 |
| starting | verifying、cancelled、failed | 启动版本对应容器 |
| verifying | running、failed | readiness 与 smoke |
| running | 终态 | 本轮部署成功 |
| failed | 终态 | 失败并已写结构化原因 |
| cancelled | 终态 | 被更高优先级操作取代或人工取消 |

任何非终态 run 都必须刷新 `heartbeatAt`。启动调和器发现心跳过期时，根据操作租约、执行器心跳和容器状态收敛为 `failed`、`cancelled` 或恢复继续，禁止无限保持“构建中”。

### 新增读取接口

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/deployment-runs` | 按项目、分支、状态列出 run |
| GET | `/api/deployment-runs/:id` | 获取 run 快照、版本和失败摘要 |
| GET | `/api/deployment-runs/:id/stream?afterSeq=N` | 断线续传状态与事件 |
| GET | `/api/deployment-versions` | 按项目、分支、commit 查询版本 |
| GET | `/api/deployment-versions/:id` | 查看不可变版本内容 |

现有 `POST /api/branches/:id/deploy` 暂不删除。它在通过前置校验后创建 run，并通过响应头与首个 SSE 事件返回 `runId`。CLI、UI 和 Webhook 逐步改为跟踪该 run。

## 八、兼容、持久化与迁移

### 兼容原则

1. `OperationLog` 在迁移期保留，只由 DeploymentRun 终态投影生成，不再作为在途事实源。
2. `BranchEntry.status` 和 `ServiceState` 继续表示当前运行态，但增加 `lastDeploymentRunId` 与 `currentVersionId` 指针。
3. `ServiceDeployment` 暂不合并；它作为 run 模式的已验证参考，后续可单独评估统一。
4. compose、BuildProfile、profile override、extra profile、远端执行器协议保持兼容。
5. 新旧 CDS 混合执行器期间，master 可把旧执行器 SSE 适配成 DeploymentRunEvent；协议升级后再改为执行器直接携带 runId。

### 持久化原则

- `CdsState` 新增 `deploymentRuns` 与 `deploymentVersions`，均为可选字段，旧数据无需一次性迁移。
- JSON 模式按项目保留最近 50 个 run，每个 run 最多 500 个事件；超限事件归档并保留摘要。
- Mongo 和 mongo-split 模式把 run 事件作为 detached log records 持久化，主文档仅保存元数据和有限快照。
- 每个阶段关键变化调用 `save()`；向客户端报告成功前必须 `flush()` 确认相应代次已持久化。
- 所有事件在持久化前统一脱敏和大小限制，禁止把完整环境变量或密钥写入 `detail`。

## 九、实施波次与机器验收

### Wave 1：DeploymentRun 事实层

1. 新增类型、状态服务和存储投影。
2. 新增 begin、append、heartbeat、finish、list、reconcile 方法及单元测试。
3. 新增读取与续传接口。
4. 先接入本地全量部署，再接入单 profile 和远端执行器。
5. UI、CLI、GitHub Check 改为只读 run，旧 OperationLog 保持兼容。

机器验收：所有部署入口在首个 shell 或 Docker 副作用前已有持久 `runId`；重建 StateService 后可读取事件；`afterSeq` 不重复不遗漏。

### Wave 2：DeploymentVersion

1. 计算配置哈希和服务产物摘要。
2. 构建成功生成版本，重复部署优先复用。
3. BranchEntry 记录 currentVersionId。
4. 新增按版本部署与回滚流程。

机器验收：同一 commit 与 configHash 的第二次部署不执行构建；回滚后运行态指向目标 versionId。

### Wave 3：managed 模式与能力绑定

1. Project 新增交付模式与 ManagedAppSpec。
2. StackDetector 生成受控默认配置。
3. 数据库、缓存、存储、身份和密钥通过逻辑绑定解析。
4. Dashboard 提供简单模式，最终生效配置始终可查看。

机器验收：常规样例项目不创建手写 BuildProfile 即可部署；compose 样例行为保持不变。

### Wave 4：结构化诊断与 AI 解释

1. 在失败发生位置写稳定错误码和证据引用。
2. 现有正则诊断降级为 legacy fallback。
3. AI Gateway 只消费终态 run、version diff 和证据摘要。

机器验收：已覆盖的失败类型不依赖原始日志正则即可确定责任侧；无结构化证据时不得生成确定性结论。

## 十、影响范围与风险

| 模块 | 主要变更 |
|------|----------|
| `cds/src/types.ts` | 新实体、状态、指针和能力声明 |
| `cds/src/services/state.ts` | run/version CRUD、事件追加、保留策略 |
| `cds/src/infra/state-store/*` | detached run event 持久化与迁移 |
| `cds/src/services/deployment-*` | 新的 run、version、planner、diagnosis 服务 |
| `cds/src/routes/branches.ts` | 部署入口接入 run；逐步抽离流程 |
| `cds/src/routes/deployment-runs.ts` | 统一读取与 SSE 续传接口 |
| `cds/src/routes/github-webhook*` | Webhook 只触发并跟踪 run |
| `cds/web/src/**` | 部署进度和失败详情读取 run |
| `.claude/skills/cds/cli/cdscli.py` | 展示和跟踪 run，不再自行推导部署真相 |

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 核心部署路由回归 | 中 | 高 | 纯增量接入、逐入口开关、现有测试全量回归 |
| 事件写入导致状态文档膨胀 | 中 | 高 | detached logs、有界保留、大小限制和压测 |
| 远端执行器协议版本不一致 | 高 | 中 | master 适配旧 SSE，新字段全部可选 |
| OperationLog 与 run 双写不一致 | 中 | 中 | 只允许 run 投影 OperationLog，禁止两个方向写 |
| managed 模式隐藏必要配置 | 中 | 中 | 生效配置可查看、compose 逃生口、样例矩阵验收 |

## 十一、北极星验收矩阵

| 判据 | 自动验证 | 真实环境验证 |
|------|----------|--------------|
| 部署事实唯一且可恢复 | StateService 与存储重载测试、SSE afterSeq 测试 | 部署中重启 CDS，页面恢复同一 run |
| 版本可复用和回滚 | planner、version hash、rollback 集成测试 | 同版本二次部署不构建，回滚后预览可访问 |
| managed 降低配置负担 | Node、.NET、Worker 样例测试 | 新项目只声明能力即可得到预览 URL |
| 失败可解释 | 错误码与证据契约测试 | 制造编译、配置、平台三类失败并核对责任侧 |
| 高级能力不退化 | compose、远端执行器、profile override 回归 | 现有 prd-agent 多服务分支完整部署 |

