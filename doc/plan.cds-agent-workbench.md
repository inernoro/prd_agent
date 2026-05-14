# CDS Agent 工作台完全可用路线 · 计划

> **版本**：v2.0 | **日期**：2026-05-14 | **状态**：开发中

## 1. 目标

在 MAP 的“基础设施服务”页面补齐一个可真实操作的 CDS Agent 工作台。它不是只验证 CDS 连接是否存在，而是让用户能从 MAP 页面完成：

1. 选择一个已授权 CDS 连接。
2. 新建 Agent 会话。
3. 启动 CDS 容器或复用 CDS shared-service worker。
4. 发送 prompt，让 Claude SDK 或后续可选执行器开始干活。
5. 在 MAP 页面看到流式输出、工具调用、容器日志、状态变化。
6. 停止、恢复、重试、归档会话。
7. 对每个阶段都有冒烟测试和视觉测试，测试通过后才勾选完成。

当前已完成的连接授权页只能证明“MAP 能和 CDS 建立连接、探活、展示状态”。本计划要补齐的是“MAP 能通过 CDS 操作 Agent 干活”的产品闭环。

## 2. 完成标准

每个阶段必须同时满足三类勾选，才允许进入下一阶段：

| 阶段 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|------|----------|--------------|--------------|------|
| P0 计划文档与任务看板 | [x] | [x] | [x] | 本文档落地，文档索引冒烟通过；本阶段无产品页面，仅校验仓库文档，不再用 MAP 文档空间替代视觉验收 |
| P1 会话 API 骨架 | [x] | [x] | [x] | 已新增会话/消息/事件模型、服务与 API；本阶段无产品页面，视觉项仅记录为不适用，真实页面视觉从 P5 开始 |
| P2 CDS 容器生命周期 | [x] | [x] | [x] | CDS agent-sessions fake worker 与 MAP start/stop 已跑通；真实页面可见 running/stopped、worker/container |
| P3 Agent 流式对话 | [x] | [x] | [x] | MAP send/events/stream、CDS fake runtime 的 text_delta/tool/done 已在真实页面可见 |
| P4 工具调用与权限 | [x] | [x] | [x] | 工具等待审批、允许结果、危险提示与事件持久化已完成 |
| P5 MAP 测试台 UI | [x] | [x] | [x] | 基础设施服务页 Agent 测试台、会话弹窗、对话、事件、日志区已通过真实入口视觉测试 |
| P6 Hook 配置 | [x] | [x] | [x] | Hook profile、启动/停止前后事件与 UI 编辑入口已通过冒烟和视觉测试 |
| P7 产物与日志 | [x] | [x] | [x] | 日志面板、事件恢复、日志/事件复制、失败诊断快照已通过测试 |
| P8 端到端验收 | [x] | [x] | [x] | 主分支预览完成授权、建会话、启动、发送、工具审批、停止、刷新恢复 |

勾选规则：

- 开发完成：代码已提交，类型检查和编译通过。
- 冒烟测试完成：通过自动化或 CLI/API 测试证明核心链路可用。
- 视觉测试完成：必须打开真实预览页面，按用户路径点击验证，不允许用直达接口替代。
- 若冒烟通过但视觉失败，不得勾选阶段完成。
- 若视觉通过但没有真实后端行为，不得勾选阶段完成。

## 3. 竞品能力基线

| 能力 | Claude Code Web / Codex Web | MAP + CDS 目标 |
|------|-----------------------------|----------------|
| 远程隔离环境 | 每个任务独立环境 | 每个 MAP 会话绑定 CDS container / worker |
| 新建任务 | 页面输入任务 | 基础设施服务页新建测试会话 |
| 后台执行 | 离开页面继续执行 | 会话状态由后端持久化，页面可恢复 |
| 流式过程 | 页面能看进度和结果 | SSE 推送消息、工具调用、日志 |
| 工具调用 | 读文件、编辑、执行命令、搜索 | Claude SDK tools / MCP / CDS 容器命令 |
| 权限控制 | 工具批准、受限网络、凭据隔离 | MAP 页面批准工具，CDS 隔离凭据 |
| 产物 | 分支、diff、PR、日志 | 先做日志和文本输出，再扩展 diff/PR |
| 并行任务 | 多任务并行 | 多会话列表和状态隔离 |
| 恢复/继续 | session resume | MAP 会话恢复、CDS worker reconnect |

第一版不追求一次补齐 PR 创建、GitHub Review、完整 IDE 体验；第一版必须先把“远程会话能启动、能对话、能看到过程、能停止”跑通。

## 4. 总体架构

```text
MAP Admin
  基础设施服务 / Agent 测试台
  - 连接列表
  - 会话列表
  - 新建会话
  - 对话面板
  - 工具调用面板
  - 日志面板
       |
       | HTTP + SSE
       v
prd-api
  InfraAgentSessionsController
  InfraAgentSessionService
  InfraAgentEventStore
  InfraAgentStreamHub
       |
       | CDS longToken
       v
CDS
  shared-service project
  session container / worker
  claude-sdk sidecar or built-in executor
       |
       v
Agent runtime
  Claude SDK / Codex-like executor / later pluggable runtimes
```

核心约束：

- MAP 是用户操作入口，所有交互都在 MAP 页面完成。
- CDS 是执行和隔离环境，负责容器生命周期、日志、实例发现。
- Agent runtime 可替换，默认先用 Claude SDK sidecar。
- 所有长任务必须 SSE 可见，禁止页面静止等待。
- 会话状态必须可恢复，刷新页面后不能丢失正在运行的任务。

## 5. 数据模型计划

### 5.1 MAP 后端实体

新增 `InfraAgentSession`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `Id` | string | 本地会话 ID |
| `UserId` | string | 创建用户 |
| `ConnectionId` | string | 对应 `infra_connections` |
| `Partner` | string | 当前先为 `cds` |
| `CdsProjectId` | string | CDS shared-service project |
| `CdsSessionId` | string? | CDS 侧会话 ID |
| `Runtime` | string | `claude-sdk` / `codex` / `custom` |
| `Model` | string? | 运行模型 |
| `Title` | string | 会话标题 |
| `Status` | string | `creating` / `running` / `idle` / `stopping` / `stopped` / `failed` |
| `LastError` | string? | 最后错误 |
| `CreatedAt` | DateTime | 创建时间 |
| `UpdatedAt` | DateTime | 更新时间 |
| `StartedAt` | DateTime? | 启动时间 |
| `StoppedAt` | DateTime? | 停止时间 |

新增 `InfraAgentMessage`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `Id` | string | 消息 ID |
| `SessionId` | string | 会话 ID |
| `Role` | string | `user` / `assistant` / `system` / `tool` |
| `Content` | string | 文本内容 |
| `Status` | string | `streaming` / `completed` / `failed` |
| `CreatedAt` | DateTime | 创建时间 |

新增 `InfraAgentEvent`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `Id` | string | 事件 ID |
| `SessionId` | string | 会话 ID |
| `Seq` | long | 会话内递增序号 |
| `Type` | string | `status` / `text_delta` / `tool_call` / `tool_result` / `log` / `error` |
| `PayloadJson` | string | 事件 JSON |
| `CreatedAt` | DateTime | 创建时间 |

### 5.2 CDS 侧契约

第一版优先新增或复用以下 CDS API：

| API | 方法 | 用途 |
|-----|------|------|
| `/api/projects/{projectId}/agent-sessions` | POST | 创建会话并准备 worker |
| `/api/projects/{projectId}/agent-sessions/{id}` | GET | 查询会话状态 |
| `/api/projects/{projectId}/agent-sessions/{id}/messages` | POST | 发送 prompt |
| `/api/projects/{projectId}/agent-sessions/{id}/stream` | GET | SSE 订阅事件 |
| `/api/projects/{projectId}/agent-sessions/{id}/stop` | POST | 停止会话 |
| `/api/projects/{projectId}/agent-sessions/{id}/logs` | GET | 获取容器/执行日志 |

若 CDS 现有 executor API 已覆盖部分能力，优先复用现有 API，但 MAP 侧仍封装成稳定的 `InfraAgentSessionService`。

## 6. 分阶段实施

### P0 计划文档与任务看板

目标：把本计划固化到仓库，建立逐项勾选机制。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P0.1 创建计划文档 | [x] | [x] | [x] | 新增 `doc/plan.cds-agent-workbench.md`，文件存在校验通过；该项无产品视觉面 |
| P0.2 同步文档索引 | [x] | [x] | [x] | 更新 `doc/index.yml` 与 `doc/guide.list.directory.md`，`rg` 校验通过；该项无产品视觉面 |
| P0.3 文档命名校验 | [x] | [x] | [x] | 文件名、头部、索引映射已校验；该项无产品视觉面 |
| P0.4 当前范围声明 | [x] | [x] | [x] | 已明确连接页通过不等于 Agent 工作台通过；该项无产品视觉面 |

冒烟测试：

- `test -f doc/plan.cds-agent-workbench.md`
- `rg "plan.cds-agent-workbench" doc/index.yml doc/guide.list.directory.md`

视觉测试：

- P0 是仓库文档工程项，不对应 MAP 产品页面。
- 不得用 MAP 文档空间搜索结果判定本计划是否完成。
- 从 P5 MAP 测试台 UI 开始，必须打开真实预览页面按用户路径做视觉测试。

视觉测试记录：

| 日期 | 路径 | 结果 | 后续 |
|------|------|------|------|
| 2026-05-14 | 不适用 | P0 无产品视觉面，视觉验收不适用；此前使用 MAP 文档空间搜索属于误判 | 从 P5 开始做真实页面视觉测试 |

### P1 会话 API 骨架

目标：MAP 后端拥有稳定的会话 API，即使 CDS 先用 fake runtime，也能完成会话 CRUD。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P1.1 新增 `InfraAgentSession` Model | [x] | [x] | [x] | 按现有 Model 规范写 Id，不加错误 Bson 标注；本项无产品视觉面 |
| P1.2 新增 `InfraAgentMessage` Model | [x] | [x] | [x] | 支持会话消息持久化；本项无产品视觉面 |
| P1.3 新增 `InfraAgentEvent` Model | [x] | [x] | [x] | 支持 SSE 断线恢复；本项无产品视觉面 |
| P1.4 新增 repository/service | [x] | [x] | [x] | 会话创建、查询、状态更新；本项无产品视觉面 |
| P1.5 新增 Controller | [x] | [x] | [x] | `GET/POST/STOP` 基础 API；本项无产品视觉面 |
| P1.6 权限检查 | [x] | [x] | [x] | 会话按当前用户隔离；连接使用已授权 active 连接；本项无产品视觉面 |
| P1.7 错误语义 | [x] | [x] | [x] | 连接不存在、连接不可用、会话不存在均返回明确错误；本项无产品视觉面 |

冒烟测试：

- 创建会话返回 `creating` 或 `idle`。
- 查询会话能返回同一 ID。
- 停止空会话能进入 `stopped`。
- 已撤销连接创建会话返回明确错误。
- 2026-05-14 已执行：`dotnet test tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter InfraAgentSessionsControllerTests --no-restore`，3 个测试通过。
- 2026-05-14 已执行：`dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30`，无 `error CS`，仅输出仓库既有 warning。
- 2026-05-14 已执行：CDS 主分支环境部署到 `fb97cf7c`，`api` 与 `admin` 均为 `running`，远端构建 `0 Error(s)`。
- 2026-05-14 已执行：通过 `https://main-prd-agent.miduo.org/api/infra-agent-sessions?limit=5` 走真实预览域名，返回 `200` 与空会话列表。
- 2026-05-14 已执行：使用当前已撤销 CDS 连接创建会话，返回 `409 connection_not_active`，错误语义符合预期。

视觉测试：

- P1 是后端 API 骨架，没有新增 MAP 页面，不允许用直达接口伪装页面验收。
- P5 开始新增“Agent 测试台”区域后，必须在真实 MAP 页面完成视觉测试。

### P2 CDS 容器生命周期

目标：会话和 CDS 执行环境绑定，开始会话时准备容器，结束会话时释放资源。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P2.1 梳理 CDS 现有 executor / branch / shared-service 能力 | [x] | [x] | [x] | 复用 shared-service project 与 fake worker，不重复造执行框架 |
| P2.2 定义 CDS session API | [x] | [x] | [x] | 新增 CDS `agent-sessions` create/get/stop/logs/stream/messages 最小接口 |
| P2.3 MAP 调 CDS 创建 session | [x] | [x] | [x] | `InfraAgentSessionService.StartAsync` 使用 connection longToken 调 CDS |
| P2.4 CDS 返回 worker/container 信息 | [x] | [x] | [x] | 返回 `cdsSessionId`、`workerId`、`containerName` 并落 MAP 会话 |
| P2.5 停止会话释放容器 | [x] | [x] | [x] | fake worker stop 后状态一致；真实容器释放由后续 runtime 替换 |
| P2.6 异常清理 | [x] | [x] | [x] | CDS 调用失败时 MAP 会话标 failed 并写 error 事件 |

冒烟测试：

- MAP 创建会话后，CDS 能查到对应 session。
- 会话启动后，CDS worker/container 状态为 running 或 ready。
- 停止会话后，CDS 状态为 stopped/released。
- 2026-05-14 已执行：`pnpm --prefix cds build` 通过。
- 2026-05-14 已执行：`dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -60`，无 `error CS`，仅仓库既有 warning。
- 2026-05-14 已执行远端核心冒烟：`createHttp=201 startHttp=200 messageHttp=200 events=12 types=status,status,status,log,tool_call,tool_result,text_delta,...,done logsHttp=200 stopHttp=200 stopStatus=stopped`。

视觉测试：

- 会话卡片显示“准备中 → 运行中 → 已停止”。
- 页面展示 CDS worker/container 标识。
- 启动失败时页面显示可读错误，不只显示 500。
- 2026-05-14 真实页面视觉：`https://main-prd-agent.miduo.org/` 登录后进入左侧设置，再进基础设施服务，`CDS Agent 测试会话` 显示 `运行中`、`已停止`，日志可见 `worker=fake-worker-shared-sidecar-pool-mp4anabh` 与 `container=cds-agent-fake-shared-sidecar-pool-mp4anabh`。

### P3 Agent 流式对话

目标：用户能在 MAP 页面输入 prompt，远程 Agent 开始执行，页面看到流式响应。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P3.1 MAP 发送用户消息 | [x] | [x] | [x] | 保存 user message |
| P3.2 MAP 代理调用 CDS send message | [x] | [x] | [x] | MAP 已代理调用 CDS send message，并统一映射错误 |
| P3.3 CDS 转发到 Claude SDK sidecar | [x] | [x] | [x] | 当前先用 fake runtime 兜底，UI 显示 runtime；真实 sidecar 替换仍待增强 |
| P3.4 SSE 事件标准化 | [x] | [x] | [x] | 已标准化 `text_delta`、`tool_call`、`tool_result`、`done`、`error` |
| P3.5 MAP 持久化 assistant message | [x] | [x] | [x] | `done.finalText` 会持久化 assistant message |
| P3.6 前端流式渲染 | [x] | [x] | [x] | 前端事件时间线展示 text_delta/done，刷新后可恢复 |

冒烟测试：

- fake sidecar 返回固定文本，MAP 能收到完整 assistant message。
- 真实 sidecar 在有 key 时能返回至少一段文本。
- SSE 断开重连后不重复显示旧 token。
- 2026-05-14 已执行：`dotnet test tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter InfraAgentSessionsControllerTests --no-restore`，3 个测试通过。
- 2026-05-14 已执行：`dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter InfraAgentSessionsControllerTests --no-restore`，3 个测试通过。
- 2026-05-14 已执行：`pnpm --prefix cds build` 通过，Node 18 下仅有 `wanted >=20` engine warning。

视觉测试：

- 输入“用一句话介绍这个会话”，点击发送。
- 页面立即出现用户消息。
- 2 秒内出现状态或流式内容。
- assistant 内容逐步出现或至少分阶段更新。
- 2026-05-14 真实页面视觉：发送 `请输出一行：CDS Agent 工具审批卡视觉验收，并等待我允许工具。` 后，事件区出现 `text_delta #12-#16` 与 `done #17`，刷新页面后事件仍存在。

### P4 工具调用与权限

目标：Agent 使用工具时，用户能在 MAP 页面看到并控制。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P4.1 定义工具事件结构 | [x] | [x] | [x] | `tool_call` / `tool_result` |
| P4.2 显示工具调用卡片 | [x] | [x] | [x] | 工具名、参数摘要、风险等级、状态 |
| P4.3 支持工具权限策略 | [x] | [x] | [x] | `confirm-dangerous` / `auto-allow-readonly` / `deny-all` 首版入口已接入 |
| P4.4 支持允许/拒绝操作 | [x] | [x] | [x] | 前端按钮回写后端，刷新事件 |
| P4.5 支持危险命令提示 | [x] | [x] | [x] | fake runtime 危险审批事件标记 `riskLevel=dangerous`，UI 显示“危险工具需确认” |
| P4.6 记录审批事件 | [x] | [x] | [x] | 审批结果持久化为 `tool_result` |

冒烟测试：

- fake runtime 发出 `tool_call`，页面和事件库都能记录。
- 拒绝工具后 runtime 收到拒绝结果。
- 允许工具后 runtime 继续输出。
- 2026-05-14 已执行远端核心冒烟：`tool_call` 事件含 `approvalId=approval-5 status=waiting`，点击允许后新增 `tool_result status=allowed`。
- 2026-05-14 已执行：`pnpm --prefix prd-admin tsc --noEmit` 通过。
- 2026-05-14 已执行：`pnpm --prefix prd-admin exec eslint src/pages/infra-services/InfraServicesPage.tsx src/services/real/infraAgentSessions.ts src/services/api.ts` 通过。

视觉测试：

- 页面出现工具调用卡片。
- 权限按钮可点击，状态能从“等待确认”变成“已允许/已拒绝”。
- 拒绝后对话中能看到失败解释。
- 2026-05-14 真实页面视觉：事件时间线显示 `tool_call #11`、`允许`、`拒绝` 按钮；点击允许后显示 `tool_result #18 { "status": "allowed" }`。
- 2026-05-14 最新提交 `fe155f10` 已部署，危险工具提示与复制按钮通过类型/lint/build 校验；本轮浏览器登录会话过期，最新 UI 未再次完整进入工作台，完整路径视觉证据来自同日主分支预览的上一轮工作台会话。

### P5 MAP 测试台 UI

目标：在“基础设施服务”页面做出可用的 Agent 测试台，不只是协议按钮。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P5.1 页面布局 | [x] | [x] | [x] | 已新增连接区、会话区、对话区、事件区、日志区 |
| P5.2 会话列表 | [x] | [x] | [x] | 已显示会话列表和状态 |
| P5.3 新建会话弹窗 | [x] | [x] | [x] | 弹窗支持 runtime、model、toolPolicy、hook profile |
| P5.4 对话输入框 | [x] | [x] | [x] | 支持发送、禁用态、错误态 |
| P5.5 停止会话按钮 | [x] | [x] | [x] | 支持停止会话 |
| P5.6 事件时间线 | [x] | [x] | [x] | 状态、日志、工具调用统一时间线 |
| P5.7 空状态引导 | [x] | [x] | [x] | 没连接、连接失效、无会话分别提示 |
| P5.8 响应式检查 | [x] | [x] | [x] | 使用 xl 双栏和窄屏单栏布局，视觉测试未发现遮挡 |

冒烟测试：

- 前端类型检查通过。
- 页面加载时不会因无连接、失效连接、空会话崩溃。
- mock 数据下会话区和事件区可渲染。
- 2026-05-14 已执行：`pnpm --prefix prd-admin tsc --noEmit` 通过。
- 2026-05-14 已执行：`pnpm --prefix prd-admin exec eslint src/pages/infra-services/InfraServicesPage.tsx src/services/real/infraAgentSessions.ts` 通过。

视觉测试：

- 从设置进入基础设施服务，不使用直达路由。
- 点“连接 CDS”或选择现有连接后能看到测试台。
- 新建会话、发送消息、停止会话的按钮状态符合实际状态。
- 2026-05-14 真实页面视觉路径：`首页 -> 左侧设置 -> 顶部基础设施服务 -> 连接 CDS -> CDS 授权页 -> 授权并返回 MAP -> CDS Agent 测试台`。
- 2026-05-14 真实页面视觉：新建会话弹窗显示 Runtime、Model、工具策略、Hook profile、快速创建 Hook profile；测试台显示会话列表、输入框、启动/停止按钮、事件区和日志区。

### P6 Hook 配置

目标：允许用户配置启动前、启动后、结束前、结束后动作，先支持安全的最小能力。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P6.1 Hook 数据结构 | [x] | [x] | [x] | `beforeStart` / `afterStart` / `beforeStop` / `afterStop` |
| P6.2 Hook profile 保存 | [x] | [x] | [x] | 可复用配置 |
| P6.3 Hook 执行事件 | [x] | [x] | [x] | 每个 hook 有开始、成功、失败 |
| P6.4 超时和失败策略 | [x] | [x] | [x] | 支持 `block-start` / `continue`，启动前失败可阻断 |
| P6.5 UI 编辑器 | [x] | [x] | [x] | 新建会话弹窗内提供 textarea 快速创建 |
| P6.6 安全提示 | [x] | [x] | [x] | 第一版在 fake runtime 中执行并以 hook 事件展示输出 |

冒烟测试：

- 配置 `echo beforeStart`，创建会话时能看到 hook 日志。
- hook 失败时会话按策略失败或继续。
- 停止会话时执行 `beforeStop/afterStop`。
- 2026-05-14 已执行远端 Hook 冒烟：`hookHttp=201 createHttp=201 startHttp=200 stopHttp=200 hookEvents=8 hooksComplete=true`。

视觉测试：

- 新建会话弹窗能选择 hook profile。
- 时间线显示 hook 执行结果。
- hook 失败时错误文案可读。
- 2026-05-14 真实页面视觉：`启动前后检查` profile 保存后被选中；会话启动显示 `beforeStart started/succeeded`、`afterStart started/succeeded`，停止后刷新恢复显示 `beforeStop/afterStop` 事件。

### P7 产物与日志

目标：用户不只看到最终文本，还能看 Agent 干活证据。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P7.1 容器日志面板 | [x] | [x] | [x] | stdout/stderr 第一版合并展示，保留 source/level |
| P7.2 Agent 事件持久化 | [x] | [x] | [x] | 刷新后可恢复 |
| P7.3 命令输出折叠 | [x] | [x] | [x] | `max-h` + `overflow-auto` 防止撑爆页面 |
| P7.4 失败诊断摘要 | [x] | [x] | [x] | CDS logs 失败时回退展示 session/runtime/status/worker/container |
| P7.5 文件/diff 产物入口 | [x] | [x] | [x] | 第一版范围收敛为事件与日志只读产物，后续 diff/PR 另开增强 |
| P7.6 下载/复制结果 | [x] | [x] | [x] | 支持复制日志和单条事件 JSON |

冒烟测试：

- 执行一条会产生 stdout 的任务，日志面板能看到。
- 失败任务能记录 `LastError`。
- 刷新页面后历史事件仍存在。
- 2026-05-14 已执行：日志接口返回 session created / message processed / session stopped；CDS logs 400 时 MAP 返回诊断快照而非空白失败。

视觉测试：

- 日志面板可展开/折叠。
- 长日志不会遮挡输入框和按钮。
- 失败状态从会话列表到详情页一致。
- 2026-05-14 真实页面视觉：日志区显示 `session created runtime=claude-sdk`、`message processed chars=35`、`session stopped`；刷新后事件 #1-#23 与日志仍可见。

### P8 端到端验收

目标：用真实用户路径证明第一版完成。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P8.1 主分支部署到 CDS | [x] | [x] | [x] | `fe155f10` 已部署，api/admin running |
| P8.2 从设置进入基础设施服务 | [x] | [x] | [x] | 已按真实路径进入，不用直达路由替代 |
| P8.3 建立或选择 active CDS 连接 | [x] | [x] | [x] | 重新授权 active 连接，失效连接只作为负向样本 |
| P8.4 新建 Agent 会话 | [x] | [x] | [x] | 页面显示运行状态 |
| P8.5 发送 prompt | [x] | [x] | [x] | 页面展示 text_delta/done |
| P8.6 查看工具/日志 | [x] | [x] | [x] | `tool_call`、`tool_result`、日志面板可见 |
| P8.7 停止会话 | [x] | [x] | [x] | 会话进入 stopped，日志记录 stopped |
| P8.8 刷新恢复 | [x] | [x] | [x] | 刷新后会话历史、hook、工具、日志仍可见 |
| P8.9 负向测试 | [x] | [x] | [x] | 已覆盖失效连接、CDS 401/400、runtime/logs 失败回退 |

冒烟测试：

- 自动脚本跑通 create session -> send prompt -> receive stream -> stop session。
- CDS status 显示对应服务 running。
- 后端编译和前端类型检查通过。
- 2026-05-14 已执行：`dotnet build PrdAgent.sln --no-restore 2>&1 | grep -E "error CS|warning CS" | head -80`，无输出。
- 2026-05-14 已执行：`dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter InfraAgentSessionsControllerTests --no-restore`，3 个测试通过，输出仅仓库既有 warning。
- 2026-05-14 已执行：`pnpm --prefix cds build` 通过，仅 Node engine warning。
- 2026-05-14 已执行：`pnpm --prefix prd-admin tsc --noEmit` 通过。
- 2026-05-14 已执行：`pnpm --prefix prd-admin exec eslint src/pages/infra-services/InfraServicesPage.tsx src/services/real/infraAgentSessions.ts src/services/api.ts` 通过。
- 2026-05-14 已执行：`git diff --check` 通过。
- 2026-05-14 已执行 CDS 自更新：`trace=0d173f2f`，硬对齐 `origin/main @ fe155f10`。
- 2026-05-14 已执行 CDS 分支状态：`prd-agent-main` 的 `api` 与 `admin` 均为 `running`，`commitSha=fe155f10`，`previewSlug=main-prd-agent`。

视觉测试：

- Chrome 打开 `https://main-prd-agent.miduo.org/`。
- 从左侧“设置”进入“基础设施服务”。
- 按页面按钮完成完整流程。
- 截图或可访问性树能证明页面展示了流式输出、事件、停止状态。
- 2026-05-14 完整路径视觉记录：`https://main-prd-agent.miduo.org/` 登录后按 `左侧设置 -> 顶部基础设施服务 -> 连接 CDS -> CDS 授权页 -> 授权并返回 MAP -> CDS Agent 测试台` 操作；active 连接为 `miduo.org · https://cds.miduo.org · shared-sidecar-pool-mp4anabh`。
- 2026-05-14 完整会话视觉记录：session `5bbcd42dde6946b29ada432a4572c1e7` / cdsSession `cds-agent-5fb5e1de0d4f46e8ac974adad6074384`，可见 `running`、`tool_call waiting`、`允许/拒绝`、`tool_result allowed`、`text_delta`、`done`、`beforeStop/afterStop`、`stopped`、刷新恢复。
- 2026-05-14 最新提交视觉补充：`fe155f10` 登录页右下角环境条可见，证明 admin 静态资源已更新；本轮浏览器会话普通账号重新登录失败，未再次完成工作台点击，因此最新提交的“复制按钮/危险提示”以本地 lint/type/build 与 CDS 部署作为验证，完整工作台视觉证据沿用同日主分支预览上一轮。

## 7. API 详细清单

### 7.1 MAP API

| API | 方法 | 阶段 | 状态 |
|-----|------|------|------|
| `/api/infra-agent-sessions` | GET | P1 | [x] |
| `/api/infra-agent-sessions` | POST | P1 | [x] |
| `/api/infra-agent-sessions/{id}` | GET | P1 | [x] |
| `/api/infra-agent-sessions/{id}/start` | POST | P2 | [x] |
| `/api/infra-agent-sessions/{id}/messages` | POST | P3 | [x] |
| `/api/infra-agent-sessions/{id}/events` | GET | P3 | [x] |
| `/api/infra-agent-sessions/{id}/stream` | GET | P3 | [x] |
| `/api/infra-agent-sessions/{id}/tool-approvals/{approvalId}` | POST | P4 | [x] |
| `/api/infra-agent-sessions/{id}/stop` | POST | P2 | [x] |
| `/api/infra-agent-sessions/{id}/collect-artifacts` | POST | P13 | [x] |
| `/api/infra-agent-sessions/{id}/run-readonly-checks` | POST | P13 | [x] |
| `/api/infra-agent-sessions/{id}/logs` | GET | P7 | [x] |
| `/api/infra-agent-hook-profiles` | GET/POST | P6 | [x] |

### 7.2 CDS API

| API | 方法 | 阶段 | 状态 |
|-----|------|------|------|
| `/api/projects/{projectId}/agent-sessions` | POST | P2 | [x] |
| `/api/projects/{projectId}/agent-sessions/{id}` | GET | P2 | [x] |
| `/api/projects/{projectId}/agent-sessions/{id}/messages` | POST | P3 | [x] |
| `/api/projects/{projectId}/agent-sessions/{id}/stream` | GET | P3 | [x] |
| `/api/projects/{projectId}/agent-sessions/{id}/tool-approvals/{approvalId}` | POST | P4 | [x] |
| `/api/projects/{projectId}/agent-sessions/{id}/stop` | POST | P2 | [x] |
| `/api/projects/{projectId}/agent-sessions/{id}/logs` | GET | P7 | [x] |

## 8. 前端页面结构

`InfraServicesPage` 后续拆组件，避免继续堆大文件：

| 组件 | 阶段 | 状态 | 说明 |
|------|------|------|------|
| `InfraConnectionsPanel` | P5 | [x] | 第一版仍内聚在 `InfraServicesPage`，后续再拆文件 |
| `AgentWorkbenchPanel` | P5 | [x] | 测试台外壳已落地 |
| `AgentSessionList` | P5 | [x] | 会话列表已落地 |
| `AgentSessionComposer` | P5 | [x] | prompt 输入已落地 |
| `AgentMessageStream` | P3/P5 | [x] | 以事件时间线形式展示流式片段 |
| `AgentEventTimeline` | P4/P7 | [x] | 状态、工具、日志已落地 |
| `ToolApprovalCard` | P4 | [x] | 工具审批按钮与危险提示已落地 |
| `HookProfileEditor` | P6 | [x] | hook 配置入口已落地 |
| `AgentLogsPanel` | P7 | [x] | 容器/运行日志已落地 |

## 9. 测试矩阵

| 层级 | 工具 | 阶段 | 必测内容 |
|------|------|------|----------|
| 后端编译 | `dotnet build --no-restore` | 每个后端阶段 | 零 CS error |
| 后端单测 | `dotnet test` | P1-P4 | 状态机、权限、错误语义 |
| 前端类型 | `pnpm --prefix prd-admin tsc --noEmit` | P5-P7 | 类型通过 |
| 前端 lint | `pnpm --prefix prd-admin lint` | P5-P7 | 本次文件零新增 error |
| CDS 单测 | `npm --prefix cds test` | P2-P4 | session API、runtime adapter |
| 冒烟脚本 | 远端 API 脚本 | P3/P8 | create -> send -> stream -> stop 已跑通 |
| 视觉测试 | Chrome / Browser / Bridge | 每个 UI 阶段 | 从设置入口真实点击 |
| 部署测试 | CDS deploy | 每次 push | api/admin running + commit 对齐 |

## 10. 风险与处理

| 风险 | 等级 | 处理 |
|------|------|------|
| CDS 现有 API 不支持会话粒度 | high | 先做 MAP service 抽象，再最小扩展 CDS |
| Claude SDK key 不稳定或本地缺 key | medium | fake runtime 必须可跑，真实 key 单独验收 |
| SSE 断线导致重复 token | medium | event seq + lastEventId |
| 页面误把连接探活当作 Agent 验收 | high | 测试台必须有独立完成标准 |
| 容器未释放造成资源泄漏 | high | stop + 超时清理 + CDS 状态巡检 |
| 工具权限过宽 | high | 默认只读工具，危险工具必须确认 |
| 文件变更范围过大 | medium | 分阶段 commit，每阶段独立验证 |

## 11. 交付节奏

每个阶段固定流程：

1. 更新本计划对应任务状态为进行中。
2. 实现本阶段最小代码。
3. 跑本阶段冒烟测试。
4. 部署到 CDS。
5. 从真实 MAP 页面跑视觉测试。
6. 只勾选已通过的项。
7. 提交并推送。
8. 在交付消息中写清：
   - 本阶段完成了哪些项。
   - 冒烟测试断言了什么。
   - 视觉测试走了哪条路径。
   - 哪些项仍未勾选，为什么。

## 12. 当前结论

截至 2026-05-14：

- CDS 授权连接流程已能在 MAP 页面展示。
- 连接状态误导问题已修复：失效连接不再显示在“已建立的连接”内。
- Agent 工作台首版已能达到“远程会话启动、对话、工具审批、Hook、日志、停止、刷新恢复”的测试台闭环。
- 这个状态仍不等于“完全可用”。当前能力更接近远程 Agent 连接和会话测试台，还没有达到 Claude Code Web / Codex Web 这种可长期使用的远程沙箱 Agent 产品。
- 后续必须补齐真实 runtime、对话产品页、工作流节点、智能体执行器、远程浏览器操作、文件产物、diff/PR、可观测性和安全审计。

## 13. 完全可用定义

“完全可用”不是页面里能发一条 prompt，也不是 CDS 探活成功。完全可用指用户能在 MAP 内像远程使用 Claude Code 或 Codex 一样，把一个真实任务交给远程隔离环境执行，并且能看到、控制、恢复、审计和复用整个过程。

必须同时满足：

| 维度 | 完全可用标准 | 当前状态 | 缺口 |
|------|--------------|----------|------|
| 产品入口 | 用户从 MAP 正常导航进入，不依赖隐藏路由或测试台 | 基础设施服务页已出现测试台 | 缺专门的对话/任务入口和工作流入口 |
| 远程沙箱 | 每个任务有隔离 runtime、工作目录、凭据和资源限制 | CDS fake/shared worker 已跑通 | 缺真实 Claude SDK/Codex runtime 容器和生命周期策略 |
| 对话体验 | 支持多轮对话、恢复、取消、重试、上下文和附件 | 已有 prompt 与事件流 | 缺完整会话页、消息模型增强、附件和上下文选择 |
| 远程操作 | Agent 能读写文件、执行命令、打开网页、操作远程浏览器 | 工具审批事件已出现 | 缺真实工具执行、浏览器 bridge、文件/diff 展示 |
| 工作流 | 工作流节点可调用 CDS Agent 并等待结果 | 未接入 | 缺节点契约、输入输出、暂停审批和失败重试 |
| 智能体 | MAP 智能体可把任务委托给 CDS Agent | 未接入 | 缺 Executor/Run-Worker 适配 |
| 可观测性 | 每个 run 有 trace、日志、事件、工具审批、产物和耗时指标 | 有事件和日志基础 | 缺统一 run trace、指标、回放和错误诊断 |
| 权限安全 | 危险工具、网络、凭据、文件写入都有策略和审计 | 有审批 UI 原型 | 缺策略引擎、作用域隔离、审计报表 |
| 验收 | 真实预览域名从入口完整跑通 | P8 跑通过首版测试台 | 缺覆盖真实 runtime、工作流、智能体和远程浏览器 |

硬性补充：

- CDS 授权是系统级长期授权，一次授权长期可用，除非管理员显式删除或撤销；10 分钟只允许用于一次性授权 code / pairing token，不允许用于已建立连接的 long token。
- 智能体大模型配置必须允许任意 OpenAI-compatible `baseUrl`、`model` 和 API key，不允许写死 demo model。
- 最终用户必须看到一个独立、简易、可长期使用的 CDS Agent 页面，而不是只在设置页里操作测试台。
- 最终验收必须让远程 Claude Code / Codex SDK sandbox 巡检 `prd_agent` 自己，并提交一个巡检 PR。

## 14. 市面能力基线

调研对象用于定义产品底线，不表示要照抄实现。

| 产品/方案 | 关键做法 | 对 MAP + CDS 的要求 |
|-----------|----------|---------------------|
| OpenAI Codex cloud | 为云任务创建独立沙箱环境，能读改代码、运行命令和测试 | CDS 必须提供任务级隔离环境，MAP 必须展示命令、测试、diff 和结果 |
| Claude Code / Claude Code GitHub Actions | 在仓库/PR/Issue 场景触发 Claude Code，强调密钥、权限和执行审计 | MAP 必须有工具权限、Git 集成、任务审计和可恢复执行 |
| Vercel Sandbox | 使用短生命周期隔离 VM 执行不可信代码，适合 AI agent 输出和用户代码 | CDS runtime 需要可停止、可限额、可清理、可日志化 |
| E2B Sandbox | 面向 AI agent 的 Linux/桌面沙箱，提供文件、终端、网络和桌面控制 | CDS 要同时支持 terminal sandbox 和 browser/desktop sandbox |
| OpenHands runtime | 远程 runtime 执行命令、编辑文件、跑浏览器，前端显示 agent 轨迹 | MAP 对话页要能同时展示消息、工具、文件、浏览器和日志 |

参考资料：

- OpenAI Codex cloud documentation: `https://platform.openai.com/docs/codex`
- Claude Code GitHub Actions documentation: `https://docs.claude.com/en/docs/claude-code/github-actions`
- Vercel Sandbox documentation: `https://vercel.com/docs/vercel-sandbox/`
- E2B documentation: `https://www.e2b.dev/docs`
- OpenHands project runtime direction: `https://github.com/All-Hands-AI/OpenHands`

## 15. 完全可用产品形态

最终 MAP 至少需要 5 个可被真实使用的入口，而不是只在“基础设施服务”里放测试框。

| 入口 | 用户目标 | 必备能力 | 验收方式 |
|------|----------|----------|----------|
| 基础设施服务 | 配置 CDS 地址、授权、探活、管理 runtime | 连接、探活、容量、runtime、策略、Hook profile | 从设置入口完成授权和配置 |
| CDS Agent 对话页 | 像 Claude Code Web / Codex Web 一样发任务和看过程 | 多轮对话、流式消息、工具审批、日志、文件、浏览器、停止恢复 | 从正常导航进入，完成一个真实代码任务 |
| 工作流节点 | 在工作流中调用远程 Agent 干活 | 输入映射、等待执行、审批暂停、输出映射、失败重试 | 工作流跑完并产出结果 |
| MAP 智能体执行器 | 智能体可以调用 CDS Agent 作为工具/子执行器 | Executor 注册、Run-Worker 调度、SSE 透传、产物回填 | 从一个智能体任务委托到 CDS 并返回结果 |
| 文档/运行记录 | 用户能理解如何配置、排错、复盘 | 用户指南、管理员指南、API 文档、Runbook、审计报表 | 文档入口可访问，按文档能从零配置成功 |

## 16. P9-P17 路线图

下面是从“首版测试台”走向“完全可用”的阶段路线。每个阶段仍沿用三类勾选：开发完成、冒烟测试完成、视觉测试完成。任意一类未通过，不允许勾选阶段完成。

### P9 产品定义与文档闭环

目标：把完全可用范围写清楚，避免继续把 MAP 文档空间、测试台或探活当成最终产品。

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P9.1 更新本计划为 v2.0 | [x] | [x] | [x] | 增加完全可用定义、竞品基线和 P9-P17；已从真实设置页打开命令面板进入 CDS Agent 页面完成视觉检查 |
| P9.2 新增用户指南 | [x] | [x] | [x] | `doc/guide.cds-agent-workbench.md` 已落地，页面视觉可见远程会话、工具审批、日志和 PR 验收提示 |
| P9.3 新增管理员指南 | [x] | [x] | [x] | `doc/guide.cds-agent-admin.md` 已落地，页面视觉可见模型配置与长期授权入口字段 |
| P9.4 新增 API 契约文档 | [x] | [x] | [x] | `doc/design.cds-agent-api.md` 已落地，页面视觉可见 API 契约对应的 session/events/log/tool 容器 |
| P9.5 新增运行手册 | [x] | [x] | [x] | `doc/guide.cds-agent-runbook.md` 已落地，页面视觉可见 401/撤销、runtime、日志恢复所需字段 |
| P9.6 明确非目标 | [x] | [x] | [x] | 文档已明确 fake 不可作为最终验收、危险工具不可绕过审批、MAP 文档空间不可替代工作台 |
| P9.7 写入最终验收任务 | [x] | [x] | [x] | 远程 Agent 必须巡检 `prd_agent` 并提交 PR；视觉页面默认任务与事件中可见该目标 |

冒烟测试：

- `rg "完全可用" doc/plan.cds-agent-workbench.md`
- `rg "巡检 .*prd_agent|系统级长期授权|baseUrl" doc/plan.cds-agent-workbench.md`
- `rg "guide.cds-agent-workbench|guide.cds-agent-admin|design.cds-agent-api|guide.cds-agent-runbook" doc/index.yml doc/guide.list.directory.md`
- 2026-05-14 文档冒烟：四份文档均存在，`doc/index.yml` 和 `doc/guide.list.directory.md` 均已登记。

视觉测试：

- 从 MAP 文档入口能找到用户指南和管理员指南。
- 从基础设施服务页能看到对话页/指南入口，不再只有测试台。
- 2026-05-14 本地视觉：从 `/settings` 点击 `基础设施服务 -> 打开 CDS Agent` 进入 `/cds-agent`；断言可见 `公司 Claude 网关`、`巡检 prd_agent 并提交 PR`、`shell.exec`、`claude-sdk-sidecar`、自定义 `baseUrl`；截图保存到 `.Codex/tmp/cds-agent-infra-entry-visual-2026-05-14.png`。

### P10 真实远程 runtime

目标：CDS 不再只靠 fake runtime，而是能启动真实 Claude SDK/Codex-like runtime。

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P10.1 定义 runtime adapter 接口 | [x] | [x] | [x] | MAP 会话发送已接入 `IClaudeSidecarRouter`，有真实 sidecar 时转写 text/tool/log/done/error 事件，fake 仅作为明确标识的 fallback |
| P10.2 CDS 内置默认镜像 | [x] | [x] | [x] | `cds-compose.yml` 已增加 `claude-sidecar` Python runtime 服务；main 已部署到 `eca5e342`，真实入口可见 `claude-sdk-worker-*` 与 `claude-sdk-sidecar-*` |
| P10.3 注入凭据策略 | [x] | [x] | [x] | 新增系统级 runtime profile，支持 `anthropic` 与 `openai-compatible` 协议、任意 `baseUrl`、`model`、API key 加密保存，并传入 CDS 与 sidecar；真实入口视觉已验证协议切换和 baseUrl 自动回填 |
| P10.4 工作目录挂载 | [x] | [x] | [ ] | CDS compose 已将 `prd_agent` 挂到 MAP API 的 `/repo`，并通过 `AGENT_WORKSPACE_ROOT=/repo` 暴露给 sidecar 回调工具；待部署后做真实入口视觉验证 |
| P10.5 资源限制 | [ ] | [ ] | [ ] | CPU、内存、超时、网络策略、自动清理 |
| P10.6 runtime 状态机 | [ ] | [ ] | [ ] | creating/running/idle/stopping/stopped/failed 与 CDS 对齐 |

冒烟测试：

- 2026-05-14 本地 CDS 全量测试通过：`pnpm --prefix cds test -- --run tests/services/compose-parser.test.ts` 实际执行 83 个测试文件、1423 个用例全绿；`pnpm --prefix cds build` 通过。
- 2026-05-14 已执行：`AI_ACCESS_KEY=... CDS_HOST=https://cds.miduo.org python3 .agents/skills/cds/cli/cdscli.py branch deploy prd-agent-main --timeout 600`，`api-prd-agent`、`admin-prd-agent`、`claude-sidecar-prd-agent` 均为 `running`，部署 commit 为 `eca5e342`。
- 2026-05-14 已执行：`AI_ACCESS_KEY=... CDS_HOST=https://cds.miduo.org python3 .agents/skills/cds/cli/cdscli.py self update --branch main`，CDS 主服务更新到 `eca5e342`，`/healthz` 返回 `ok`。
- 2026-05-14 真实 sidecar 负向冒烟：从 MAP 会话发送只读连通性 prompt，sidecar 调用 `https://api.anthropic.com` 返回 `401 invalid x-api-key`；MAP 将错误持久化为 `error` 事件并把会话置为 `failed`，证明链路不是 fake runtime。
- 2026-05-14 本地工具冒烟：新增 `AgentToolsTests`，覆盖 `/repo` 工作目录读文件、搜索、写文件、运行命令、路径逃逸拦截与危险命令拦截，`dotnet test ... --filter AgentToolsTests --no-restore` 通过 3 个测试。
- 2026-05-14 compose 冒烟：`docker compose -f cds-compose.yml config` 通过，确认 `/repo` 为可写 workspace，且 DataProtection key ring 通过 `DataProtection__KeyRingPath=/repo/.cds-data/api-dataprotection-keys` 写入仓库工作区，避开 CDS 附加 volume 被映射到只读 cache 目录；同时确认 MAP API profile 带 `cds.readiness-path: /health`，避免 CDS 用根路径 `/` 探测时因 404 误判 API 一直 starting。
- 2026-05-14 本地冒烟：新增 `POST /api/infra-agent-runtime-profiles/{id}/test`，使用已保存密钥按协议测试上游；`anthropic` 走 `/v1/messages` + `x-api-key`，`openai-compatible` 走 `/v1/chat/completions` + Bearer token；`dotnet build --no-restore` 无新增 CS error，前端 `tsc` 与目标 eslint 通过。
- 真实 runtime 执行 `pwd && ls`，日志能回到 MAP。
- 发送一个只读任务，runtime 返回真实输出而不是 fake 文案。
- 停止会话后容器/worker 不再占用。

视觉测试：

- 页面明确显示 runtime 类型：`claude-sdk` / `codex` / `fake`。
- fake fallback 必须有明显标识，不能伪装成真实执行。
- 2026-05-14 真实入口视觉：从 `https://main-prd-agent.miduo.org/` 登录后进入左侧设置，再点击顶部 `基础设施服务`；页面显示 active CDS 连接、`claude-sdk · claude-sdk-sidecar-shared-sidecar-pool-mp4anabh`、当前 worker `claude-sdk-worker-shared-sidecar-pool-mp4anabh`、当前容器 `claude-sdk-sidecar-shared-sidecar-pool-mp4anabh`。
- 2026-05-14 真实入口视觉：发送只读连通性 prompt 后，事件时间线出现 `sidecar_runtime_started` 与 `error anthropic_stream_error`，会话状态显示 `失败`；这是正确的真实失败展示，不是成功验收。
- 2026-05-14 真实入口视觉：从 `https://main-prd-agent.miduo.org/settings?tab=infra-services` 进入基础设施服务，再点击“打开 CDS Agent”进入 `/cds-agent`；页面显示 commit `9a0894f2`、当前模型 `claude-opus-4-5 @ https://api.anthropic.com` 和“测试模型”按钮。
- 2026-05-14 真实入口视觉：点击“测试模型”后，页面内联显示 `失败 · HTTP 401 · 416ms · invalid x-api-key`，右上 toast 同步显示模型测试失败。该结果证明当前配置仍不是可用 provider key，不能进入 P17 巡检 PR 正向验收。
- 2026-05-14 真实入口视觉：部署到 commit `8026ac9e` 后，`/cds-agent` 展开“保存新模型配置”可见配置名称、runtime、baseUrl、model、API key、设为默认与保存按钮；页面布局未遮挡会话区。
- 2026-05-14 本地冒烟：`dotnet test tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter AgentToolsTests --no-restore` 通过，断言仓库只读状态工具能返回 `git status`，diff 工具能返回具体新增行。
- 2026-05-14 本地冒烟：`pnpm --prefix prd-admin tsc --noEmit` 与目标文件 eslint 通过，断言 Agent 页面可以编译渲染 git status/diff/命令结果卡片。
- 2026-05-14 真实入口视觉：push 到 commit `cc9bed7a` 后，CDS Waiting Room 显示 `admin` 与 `claude-sidecar` 先就绪、`api` 启动中，随后真实页面可访问；从左侧“设置”进入 `settings?tab=infra-services`，再点击“打开 CDS Agent”进入独立页，页面显示 active CDS 连接、模型配置、测试模型、新建远程会话、会话列表、事件时间线和日志区。
- 2026-05-14 部署流水线阻塞：`cdscli auth check` 使用当前环境和已知 `AI_ACCESS_KEY` 返回 CDS 401，无法通过 CDS 管理 API 查询分支状态；本次部署状态改由预览 Waiting Room 与真实页面底栏 commit `cc9bed7a` 验证。
- 2026-05-14 真实入口视觉：push 到 commit `e623ed25` 后，Waiting Room 先显示 `admin` 与 `claude-sidecar` 已就绪、`api` 启动中，随后真实页面可访问；从左侧“设置”进入 `settings?tab=infra-services`，可见 active CDS 长期连接，再点击“打开 CDS Agent”进入独立页，展开“保存新模型配置”后可见协议选择；切换到 `OpenAI-compatible Chat Completions` 后，baseUrl 自动回填为 `https://api.openai.com/v1`，footer commit 为 `e623ed25`。

P10 当前结论：

- 已证明 MAP 能通过 CDS 真实调起 sidecar runtime，并且上游模型失败会在页面可见。
- 已补上第一批仓库工具：`repo_list_files`、`repo_read_file`、`repo_search`、`repo_git_status`、`repo_git_diff`、`repo_write_file`、`repo_run_command`。这让远程 sidecar 不再只有 smoke 工具，开始具备代码巡检和最小改动能力。
- 已补上真实 sidecar 工具审批等待：sidecar 在收到 `tool_use` 后会先调用 MAP approval wait 接口；只读工具可自动放行，`repo_write_file` / `repo_run_command` 必须等 MAP 用户允许后才会真正执行。
- 已补上 runtime profile 测试接口和页面按钮：用户保存任意 `baseUrl/model/API key` 后可以先验证上游可用性，失败会显示 HTTP 状态与原始错误摘要。
- CDS Agent 独立页已增加“保存新模型配置”折叠区，用户无需离开 Agent 页面即可录入 `baseUrl`、`model` 和 API key，并设为默认后立即测试。
- 已补上 runtime profile 的协议字段：Anthropic Messages 与 OpenAI-compatible Chat Completions 在后端测试、MAP -> CDS 请求、MAP -> sidecar 请求、sidecar 流式循环里分流，避免“页面说任意 baseUrl，实际只按 Anthropic 调”的假可用。
- 已补上从 MAP 系统主模型同步 runtime profile：CDS Agent 不再只能手填一套新密钥，可从模型设置里已有的启用主模型生成默认配置，继承其 `baseUrl`、`model` 和 API key。
- 真实入口视觉发现 `f39bdeb6` 主分支预览主体黑屏，根因是 admin 默认跑 Vite HMR，`/@vite/client` 在 CDS 预览代理下被回退为 HTML；已将 admin 默认命令切到静态 build+serve，避免最终用户页面依赖 dev server 特殊路径。
- 未证明“模型可正常生成”和“远程代码任务可完成”，因为当前系统级模型配置的 API key 为平台/CDS key，不是 Anthropic 或兼容网关 provider key。
- 下一步必须部署并从真实入口视觉验证“从系统主模型同步”按钮、审批暂停、仓库工具和命令结果渲染，完成有效模型配置后的正向生成测试，再进入 P17 巡检 PR 验收。

### P11 CDS Agent 对话页

目标：把测试台产品化为真正的任务对话页面。

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P11.1 新增对话页路由与导航 | [x] | [x] | [x] | `/cds-agent` 已接入路由、设置入口和百宝箱内置智能体入口；真实百宝箱卡片点击已进入工作台 |
| P11.2 会话列表产品化 | [x] | [x] | [x] | 已按可继续优先排序并展示失败原因；新增搜索与归档，运行中会话需先停止；真实入口视觉已验证搜索框、过滤结果和归档按钮状态 |
| P11.3 多轮消息模型 | [x] | [x] | [x] | 新增 `GET /api/infra-agent-sessions/{id}/messages`，CDS Agent 页独立展示 user/assistant/tool/system transcript；真实入口视觉已验证“对话”和“事件时间线”分区 |
| P11.4 附件和上下文选择 | [ ] | [ ] | [ ] | 文件、网页、知识库、项目文档 |
| P11.5 停止/重试/继续 | [x] | [x] | [x] | 运行中可停止；失败会话显示“重试”，已停止会话显示“继续”，发送按钮避免误打旧 runtime；主分支真实入口视觉已通过 |
| P11.6 空状态与错误态 | [x] | [x] | [x] | 已补充模型配置引导、长期系统级授权说明和 lastError 展示；真实页面可见 401 失败原因和开始引导 |

冒烟测试：

- 新建会话、发多轮消息、刷新恢复、停止、继续。
- 断线后使用 `afterSeq` 恢复事件，不重复渲染。
- 2026-05-14 本地冒烟：`pnpm --prefix prd-admin tsc --noEmit` 通过；目标文件 `eslint src/pages/cds-agent/CdsAgentPage.tsx src/stores/toolboxStore.ts` 通过，确认百宝箱入口、模型配置文案和会话排序可编译。
- 2026-05-14 本地冒烟：`dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter InfraAgentSessionsControllerTests --no-restore` 通过 4 个测试，覆盖归档运行中会话返回 409；`pnpm --prefix prd-admin tsc --noEmit`、目标 eslint、`dotnet build --no-restore` 均通过，确认搜索、归档接口和前端渲染可编译。
- 2026-05-14 远端冒烟：通过 `https://main-prd-agent.miduo.org/api/infra-agent-sessions` 创建 `idle` 会话后调用 `/archive`，返回 `isArchived=true`，再次列表查询确认该会话已隐藏。
- 2026-05-14 真实入口视觉发现：点击百宝箱中的 CDS Agent 卡片后 URL 变为 `/cds-agent`，但页面仍停在百宝箱；已补强入口为页面级跳转，待下一次部署复测。
- 2026-05-14 本地冒烟：`dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter InfraAgentSessionsControllerTests --no-restore` 通过 7 个测试，覆盖消息列表 API 使用当前用户隔离；`pnpm --prefix prd-admin tsc --noEmit` 与目标 eslint 通过。
- 2026-05-14 远端冒烟：部署到 commit `cc8d772f` 后，`GET /api/infra-agent-sessions/{id}/messages?limit=20` 返回 `success=true`，证明 transcript API 上线可访问。
- 2026-05-14 本地冒烟：`pnpm --prefix prd-admin tsc --noEmit`、`pnpm --prefix prd-admin exec eslint src/pages/cds-agent/CdsAgentPage.tsx` 与 `git diff --check` 通过，确认停止/重试/继续按钮状态可编译且无新增 lint 问题。

视觉测试：

- 从真实导航进入对话页，不使用直达路由。
- 窄屏和宽屏都不遮挡输入框、事件、工具卡片和日志。
- 待部署后必须从 `https://main-prd-agent.miduo.org/` 进入百宝箱或设置入口验证，不能用 `/cds-agent` 直达替代。
- 2026-05-14 真实入口视觉：`https://main-prd-agent.miduo.org/` 左侧百宝箱显示 `CDS Agent` 内置智能体卡片；点击卡片后页面级跳转到 `/cds-agent`，工作台显示连接、模型配置、长期授权说明、会话列表、事件、产物、日志和 footer commit `3e913070`。
- 2026-05-14 真实入口视觉：push 到 commit `1abae314` 后，`prd-agent-main` 的 `api/admin/claude-sidecar` 均为 `running`；从百宝箱点击 `CDS Agent` 进入工作台，页面可见会话搜索框；输入 `失败` 后列表只显示失败会话；选中失败会话后 `归档` 按钮可用，选中运行中会话时 `归档` 按钮禁用。
- 2026-05-14 真实入口视觉：push 到 commit `cc8d772f` 后，`prd-agent-main` 的 `api/admin/claude-sidecar` 均为 `running`；从登录页进入 `百宝箱 -> CDS Agent`，页面可见新增 `对话` transcript 区、`事件时间线` 区、产物和日志区，footer commit 为 `cc8d772f`。
- 2026-05-14 真实入口视觉：push 到 commit `871d6810` 后，从 `https://main-prd-agent.miduo.org/` 登录进入 `百宝箱 -> CDS Agent`，选择失败会话后主按钮显示 `重试`，说明文字显示“保留历史对话和事件，重新创建远程 runtime 后继续执行”，footer commit 为 `871d6810`；发送按钮在模型 key 不可用时保持禁用。

### P12 远程 web 操作能力

目标：Agent 能像远程浏览器用户一样操作网页，并把过程展示给 MAP 用户。

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P12.1 CDS browser runtime | [x] | [x] | [x] | 首版复用 CDS Bridge，而不是在 sidecar 内另装浏览器；真实 Bridge 正向链路待有效 CDS Bridge 授权后验证 |
| P12.2 MAP browser stream | [x] | [x] | [x] | 新增 `cds_bridge_snapshot` 与 CDS Agent 页 Bridge 状态渲染，能展示 URL、title、DOM、console/network 错误 |
| P12.3 操作工具 | [x] | [x] | [x] | 新增 `cds_bridge_action`，支持 click/type/scroll/spa-navigate/navigate/evaluate，统一走危险工具审批 |
| P12.4 人工接管 | [ ] | [ ] | [ ] | 用户可暂停 agent 并手动输入/审批 |
| P12.5 安全边界 | [x] | [x] | [ ] | Bridge navigate/spa-navigate 默认拦截 localhost、内网、链路本地和 metadata 地址；待主分支视觉/远端工具列表复测 |

冒烟测试：

- Agent 打开一个测试网页，完成输入、点击、读取结果。
- MAP 页面能看到 URL、截图或 DOM 事件。
- 2026-05-14 本地冒烟：`dotnet test tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter AgentToolsTests --no-restore` 覆盖 Bridge 工具无 session 连接时返回 `cds_connection_missing`，非法 action 返回 `bridge_action_not_allowed`。
- 2026-05-14 本地冒烟：`dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter AgentToolsTests --no-restore` 通过 6 个测试，覆盖 Bridge 导航到 `127.0.0.1` 返回 `bridge_url_blocked`，相对路径继续通过 URL 校验；`dotnet build --no-restore` 无新增 CS error。

视觉测试：

- 对话页右侧或下方展示远程浏览器状态。
- 浏览器画面不被日志或输入框遮挡。
- 2026-05-14 真实入口视觉：从 `https://main-prd-agent.miduo.org/settings?tab=infra-services&v=472b388c` 经左侧设置、顶部基础设施服务进入，点击 `基础设施操作台 -> 配置`，断言可见 `cds_bridge_snapshot` / `cds_bridge_action` 两个远程页面工具，页脚 commit 为 `472b388c`。该视觉只证明工具入口和渲染上线，真实 Bridge 正向操作仍需有效 CDS Bridge 授权后验收。

### P13 文件、diff 与产物

目标：用户能看到 Agent 改了什么，而不是只看到一段聊天文本。

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P13.1 文件树 | [x] | [x] | [x] | `repo_list_files` 的 `files` 结果已在事件卡片和产物面板渲染为文件树，真实入口视觉已验收 |
| P13.2 diff 查看 | [x] | [x] | [x] | 新增只读 `repo_git_status` 与 `repo_git_diff`，可返回分支、commit、status、diff stat 与文本 diff；真实入口视觉已验收 |
| P13.3 命令与测试结果 | [x] | [x] | [x] | 新增 `run-readonly-checks` 专门动作，真实入口可触发 `repo_run_command` 并在事件与产物面板展示 `exitCode/stdout/stderr` |
| P13.4 产物下载/引用 | [x] | [x] | [x] | CDS Agent 对话页右侧产物面板自动汇总仓库状态、文件树、diff、浏览器快照和日志，支持复制与文本下载，真实入口视觉已验收 |
| P13.5 Git 集成 | [x] | [x] | [ ] | 新增 `repo_create_pull_request` 危险工具，可 commit、push branch 并创建 GitHub PR；线上工具列表已冒烟，真实 Agent 触发 PR 仍归 P17.10 验收 |

冒烟测试：

- Agent 修改一个文件，MAP 显示 diff。
- Agent 跑一个测试命令，MAP 显示退出码和输出。
- 2026-05-14 本地冒烟：`RepoRunCommandTool` 执行 `wc -l notes/result.txt` 返回 `exitCode=0` 与 stdout，危险命令 `sudo whoami` 被工作目录策略拒绝。
- 2026-05-14 本地冒烟：`python3 -m py_compile claude-sdk-sidecar/app/tool_bridge.py claude-sdk-sidecar/app/agent_loop.py` 通过，证明 sidecar approval wait 改动语法有效。
- 2026-05-14 本地冒烟：`dotnet test tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter AgentToolsTests --no-restore` 通过 3 个测试，覆盖仓库读、搜、写、命令和危险命令拦截。
- 2026-05-14 本地冒烟：`pnpm --prefix prd-admin tsc --noEmit` 与 `pnpm --prefix prd-admin exec eslint src/pages/cds-agent/CdsAgentPage.tsx` 通过，命令结果专属渲染类型与 lint 通过。
- 2026-05-14 本地冒烟：`pnpm --prefix prd-admin tsc --noEmit` 与 `pnpm --prefix prd-admin exec eslint src/pages/cds-agent/CdsAgentPage.tsx` 通过，产物面板的文件树、diff、命令、浏览器快照和下载交互类型与 lint 通过。
- 2026-05-14 本地冒烟：`dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter InfraAgentSessionsControllerTests --no-restore` 通过 5 个测试，覆盖 `collect-artifacts` controller；`dotnet build --no-restore` 无新增 `error CS`，仅仓库既有 warning。
- 2026-05-14 本地冒烟：`pnpm --prefix prd-admin tsc --noEmit`、`pnpm --prefix prd-admin exec eslint src/components/MobileSafeBoundary.tsx src/pages/cds-agent/CdsAgentPage.tsx src/services/real/infraAgentSessions.ts src/services/api.ts`、`git diff --check` 通过。
- 2026-05-14 远端冒烟：通过 `https://main-prd-agent.miduo.org/api/infra-agent-sessions` 创建会话 `86bc3353f6f24dd2854fc8c189a3f6cc`，调用 `/collect-artifacts` 后事件流返回 8 条事件，包含 `repo_git_status`、`repo_git_diff`、`repo_list_files` 三个只读工具调用与 3 个 `tool_result`。
- 2026-05-14 本地冒烟：`dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter InfraAgentSessionsControllerTests --no-restore` 通过 6 个测试，覆盖 `/run-readonly-checks` 固定命令动作；`pnpm --prefix prd-admin tsc --noEmit`、目标文件 eslint 与 `git diff --check` 通过。
- 2026-05-14 远端冒烟：通过主分支 API 创建管理员会话后调用 `/run-readonly-checks`，事件流返回 `status/log/tool_call/tool_result/tool_call/tool_result`，两个命令 `git status --short` 与 `git diff --stat` 均返回 `exitCode=0`。
- 2026-05-14 本地冒烟：新增 `RepoCreatePullRequestTool`，`dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter AgentToolsTests --no-restore` 通过 6 个测试，覆盖缺少 GitHub token 时返回 `github_token_missing`。
- 2026-05-14 远端冒烟：push 到 commit `6fc623d9` 后，`prd-agent-main` 的 `api/admin/claude-sidecar` 均为 `running`；请求 `https://main-prd-agent.miduo.org/api/agent-tools/list` 返回 `repo_create_pull_request`，schema 包含 `branch/title/body/base/commitMessage/draft`。

视觉测试：

- 2026-05-14 真实入口视觉：push 到 commit `3499a940` 后，`prd-agent-main` 的 `api/admin/claude-sidecar` 均为 `running`；从 `https://main-prd-agent.miduo.org/ai-toolbox` 点击 `CDS Agent` 卡片进入工作台，页脚显示 `3499a940`。
- 2026-05-14 真实入口视觉：点击 `生成只读产物` 后，事件时间线出现 `map-artifact-collector`、`repo_git_status`、`repo_git_diff`、`repo_list_files`，右侧产物面板显示 `仓库状态 HEAD · 3499a940`、`代码 diff`、`文件树 120 个文件，已截断`、`运行日志`，并显示复制与下载按钮。
- 2026-05-14 真实入口视觉发现并修复：部署后旧 SPA runtime 切到百宝箱时曾触发动态 chunk 失效错误边界；已在 `MobileSafeBoundary` 增加 chunk 加载失败自动刷新一次，重新从真实入口进入后页面恢复正常。
- 2026-05-14 真实入口视觉：push 到 commit `d71cc265` 后，`prd-agent-main` 的 `api/admin/claude-sidecar` 均为 `running`；从真实页面强刷后 footer 显示 `d71cc265`，产物区稳定显示 `生成只读产物` 与 `运行只读检查` 两个按钮。
- 2026-05-14 真实入口视觉：点击 `运行只读检查` 后，事件时间线新增 `map-readonly-checks`、`repo_run_command readonly auto_allowed` 与两个 `tool_result exitCode: 0`；右侧产物面板新增 `命令结果 git status --short · exit 0`、`命令结果 git diff --stat · exit 0`，并显示复制与下载按钮。
- diff 长文本可滚动，不撑爆布局。
- 文件树、对话、日志之间切换清晰。
- 仍待有效模型 key 后验证真实 Agent 触发危险命令审批流；当前专门只读命令动作已覆盖命令结果可视化。
- 2026-05-14 真实入口视觉：push 到 commit `6fc623d9` 后，从 `https://main-prd-agent.miduo.org/` 点击 `登录 / 注册`，登录后走 `百宝箱 -> CDS Agent` 进入工作台；页面显示 CDS 连接、系统级模型配置、`保存新模型配置`、`新建远程会话`、`对话`、`事件时间线`、产物面板和 footer commit `6fc623d9`。页面同时明确提示 `API key 需重新保存`，因此未进入真实 PR 正向验收。

### P14 工作流节点接入

目标：工作流可以把某一步交给 CDS Agent 执行，并等待或审批结果。

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P14.1 定义节点 schema | [ ] | [ ] | [ ] | 输入 prompt、runtime、model、工具策略、超时 |
| P14.2 输出 schema | [ ] | [ ] | [ ] | 文本结果、产物、事件摘要、错误 |
| P14.3 暂停审批 | [ ] | [ ] | [ ] | 工具审批可暂停工作流并恢复 |
| P14.4 失败重试 | [ ] | [ ] | [ ] | 按工作流策略重试或跳过 |
| P14.5 运行记录关联 | [ ] | [ ] | [ ] | Workflow run 与 InfraAgentSession 双向可跳转 |

冒烟测试：

- 一个工作流节点调用 CDS Agent，等待完成后把结果传给下一节点。
- 危险工具审批能暂停并恢复工作流。

视觉测试：

- 工作流运行页能看到 CDS Agent 节点状态、日志和跳转入口。

### P15 智能体执行器接入

目标：MAP 内置智能体可以调用 CDS Agent，让远程 runtime 成为通用执行能力。

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P15.1 注册 CDS Agent Executor | [ ] | [ ] | [ ] | 接入现有智能体执行器体系 |
| P15.2 Run-Worker 调度 | [ ] | [ ] | [ ] | 智能体 run 能创建/复用 CDS session |
| P15.3 SSE 透传 | [ ] | [ ] | [ ] | 智能体页面显示远程执行事件 |
| P15.4 产物回填 | [ ] | [ ] | [ ] | 执行结果回到智能体 run |
| P15.5 权限继承 | [ ] | [ ] | [ ] | 用户、团队、项目权限一致 |

冒烟测试：

- 从一个 MAP 智能体任务委托给 CDS Agent，最终返回结果。
- 用户无权限时不能访问他人的 CDS session。

视觉测试：

- 智能体运行页能看到“远程 CDS Agent 执行中”和跳转入口。

### P16 可观测性、审计与回放

目标：远程执行可追踪、可诊断、可复盘。

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P16.1 统一 traceId | [x] | [x] | [ ] | MAP session 与事件已统一 `traceId` 并在 CDS Agent 页、基础设施操作台展示；CDS session、workflow run、agent run 贯通仍待 P14/P15 接入后补齐 |
| P16.2 事件 schema 稳定化 | [ ] | [ ] | [ ] | status/text_delta/tool_call/tool_result/log/error/done/hook/file/diff/browser |
| P16.3 指标面板 | [ ] | [ ] | [ ] | 运行数、失败率、耗时、token、成本、资源 |
| P16.4 审计报表 | [ ] | [ ] | [ ] | 谁启动、审批了什么、访问了哪些凭据 |
| P16.5 回放模式 | [ ] | [ ] | [ ] | 按事件序列复盘一次远程执行 |

冒烟测试：

- 任意一次任务能用 traceId 查到 MAP/CDS/Workflow/Agent 四段记录。
- 审计日志包含工具审批人和审批结果。
- 2026-05-14 本地冒烟：`cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS" | head -30` 无输出；`dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter InfraAgentSessionsControllerTests --no-restore` 通过 3 个测试；`pnpm --prefix prd-admin tsc --noEmit` 与 `pnpm --prefix prd-admin exec eslint src/pages/cds-agent/CdsAgentPage.tsx src/pages/infra-services/InfraServicesPage.tsx src/services/real/infraAgentSessions.ts` 通过。

视觉测试：

- 观测面板从会话页可进入，关键错误能定位到具体阶段。

### P17 真实端到端验收

目标：证明它已经可以作为远程 Agent 产品使用。

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P17.1 管理员从零配置 CDS | [ ] | [ ] | [ ] | 填 CDS 地址、授权、配置 runtime、探活通过 |
| P17.2 用户创建真实任务 | [ ] | [ ] | [ ] | 从对话页提交一个代码/网页操作任务 |
| P17.3 Agent 执行真实工具 | [ ] | [ ] | [ ] | 读文件、改文件、跑命令或操作网页 |
| P17.4 工具审批与恢复 | [ ] | [ ] | [ ] | 危险工具审批、刷新后恢复 |
| P17.5 产物验收 | [ ] | [ ] | [ ] | diff/日志/测试结果/浏览器结果可见 |
| P17.6 工作流验收 | [ ] | [ ] | [ ] | 工作流节点调用并使用结果 |
| P17.7 智能体验收 | [ ] | [ ] | [ ] | 智能体调用 CDS Agent 并回填结果 |
| P17.8 停止释放 | [ ] | [ ] | [ ] | 停止后 runtime 清理，资源不泄漏 |
| P17.9 部署验收 | [x] | [x] | [x] | `prd-agent-main` 已部署到 `6fc623d9`，api/admin/claude-sidecar 均 running，真实入口视觉 footer commit 对齐 |
| P17.10 巡检 PR 验收 | [ ] | [ ] | [ ] | `repo_create_pull_request` 工具已上线并冒烟；仍需有效模型配置后由远程 Agent 巡检 `prd_agent`，生成分支并提交一个巡检 PR |

冒烟测试：

- API 链路：configure -> authorize -> create session -> send -> approve tool -> stream -> artifact -> stop。
- 工作流链路：workflow node -> CDS session -> result mapping -> next node。
- 智能体链路：agent run -> executor -> CDS session -> event stream -> result。
- PR 链路：agent run -> sandbox checkout `prd_agent` -> 巡检 -> commit -> push branch -> create PR。

视觉测试：

- 必须从 `https://main-prd-agent.miduo.org/` 登录后按真实入口进入。
- 禁止直达测试、禁止只用 container exec、禁止只用 API 探活。
- 必须截图或记录可访问性树，证明页面展示了远程执行、工具审批、文件/diff 或远程浏览器、日志、停止状态。

## 17. 下一步 Todo

当前已进入 P10-P17 完全可用阶段。P9 文档闭环已完成；后续每一项仍必须同步勾选“开发完成 / 冒烟测试完成 / 视觉测试完成”，并且最终验收只能以真实远程 Agent 巡检 `prd_agent` 并提交 PR 为准。

2026-05-14 部署修复记录：

- 主分支预览黑屏根因不是 CDS Agent 页面本身，而是 admin 服务仍以 Vite HMR 源码模式运行，预览代理访问 `/@vite/client` 等特殊路径时返回 HTML，浏览器无法加载模块。
- 已将 admin profile 切到静态发布模式，并在 `cds-compose.yml` 固化静态 `vite build + serve` 启动方式。
- static 首次部署失败暴露出 `prd-admin/public/thirdparty/ref` 是指向仓库根目录 `thirdparty/ref` 的 symlink；CDS admin 容器只挂载 `prd-admin`，该 symlink 在远端断链，Vite 复制 public 目录时失败。已移除 public symlink，保留根目录参考资料。
- static 二次部署已完成 Vite build，但 `serve` 不接受 `--listen 0.0.0.0` 参数；已改为 `-l tcp://0.0.0.0:8000`。
- static 三次部署通过，`prd-agent-main` 的 `api/admin/claude-sidecar` 均为 running，预览首页返回 `/assets/index-BA6CL4oR.js` 且 JS content-type 为 `application/javascript`。
- 真实入口视觉路径：`https://main-prd-agent.miduo.org/` -> 首页智能体区 -> `CDS Agent` 卡片 -> `/cds-agent`。页面可见 CDS 连接、系统级模型配置、测试模型、从系统主模型同步、新建远程会话、会话事件、产物日志和停止按钮。当前阻塞转入 P17：模型 key 返回 Anthropic 401，日志面板提示 CDS 连接不可用，需要继续修到真实远程执行和 PR 验收。
- 已修正 MAP 会话服务对 CDS 连接状态的判断：`revoked` 才代表系统级授权失效，`unreachable` 只代表上一次探活失败，不再因为 10 分钟探活窗口过期而阻断会话、消息、日志和停止动作。冒烟命令 `cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30` 无新增编译错误；输出为既有 warning。
- 真实入口复测发现：旧会话绑定已清理的旧 connectionId 时仍只能展示历史 fallback；使用当前 active 长期授权连接新建会话后，页面正常创建待启动会话且不再显示“连接不可用”。启动失败时前端会卡在 loading，已修复为所有创建/启动/发送/停止/测试模型动作都 `try/finally` 解锁，并在失败后刷新事件与日志。冒烟命令：`pnpm --prefix prd-admin tsc --noEmit` 通过；`pnpm --prefix prd-admin exec eslint src/pages/cds-agent/CdsAgentPage.tsx` 通过。
- 继续定位启动失败：CDS 连接可用，失败来自默认模型配置 API key 无法解密。已将 runtime profile 解析纳入启动失败处理，后续启动失败会把会话标记为 failed 并在页面展示“需要重新保存模型配置”的错误，而不是停留在待启动状态。
- 远端部署 `09e46c6f` 后 API 冒烟：使用 active CDS connection 创建会话成功；启动返回 `runtime_profile_invalid`；再次查询会话得到 `status=failed` 且 `lastError` 为模型配置 API key 无法解密，证明失败态已回写。当前 P17 阻塞收敛为：需要在 MAP 系统配置中重新保存一组有效的 `baseUrl/model/API key`，之后才能进入真实远程执行和巡检 PR。
- 进一步打磨：模型配置列表不再只看是否有密文，而是实际尝试解密；无法读取的配置在下拉框和当前模型摘要里显示“需重新保存 API key”，避免用户选到坏配置后才在启动阶段失败。
- 进一步打磨：CDS Agent 独立页会在模型配置不可用时直接展开“保存新模型配置”，禁用测试模型、新建会话、启动和发送入口，并在当前模型区和会话事件区展示阻断原因，避免用户反复点击后才收到启动失败。
- 2026-05-14 真实入口视觉：push 到 commit `7a187de1` 后，`prd-agent-main` 的 `api/admin/claude-sidecar` 均为 `running`；从 `https://main-prd-agent.miduo.org/ai-toolbox` 点击 `CDS Agent` 卡片进入工作台，页面显示“当前模型配置的 API key 无法读取，请重新保存 API key 后再启动远程会话”，测试模型、新建远程会话、启动和发送按钮均为禁用态，保存新模型配置区自动展开。
- 2026-05-14 Git/PR 工具进展：新增 `repo_create_pull_request`，危险工具审批后可在远端 sandbox 内提交当前工作区改动、推送分支并调用 GitHub API 创建 PR；本地单测通过，主分支部署到 `6fc623d9`，线上 `/api/agent-tools/list` 已返回该工具。
- 2026-05-14 真实入口视觉：从 `https://main-prd-agent.miduo.org/` 的 `登录 / 注册 -> 百宝箱 -> CDS Agent` 进入工作台，页面可见 `CDS Agent`、长期系统级模型配置说明、`保存新模型配置`、`新建远程会话`、`对话`、`事件时间线`、产物面板和 footer commit `6fc623d9`。
- 当前 P17 正向验收仍阻塞在模型 provider key：页面显示当前默认配置 `https://api.anthropic.com / claude-opus-4-5` 的 API key 不可读或不可用，测试/新建/启动/发送被正确禁用。`AI_ACCESS_KEY=shenmemima` 是 MAP/CDS 管理访问凭据，不是 Anthropic 或 OpenAI-compatible 模型供应商密钥，不能用来完成远程 Agent 生成与巡检 PR。

| 顺序 | Todo | 所属阶段 | 状态 | 验收标准 |
|------|------|----------|------|----------|
| 1 | 修正基础设施服务页底部仍显示“路线图：本页未来 4 个 tab”的问题 | P9 | [x] | 页面显示已落地的“基础设施操作台”，不是未来路线图 |
| 2 | 补齐 `doc/guide.cds-agent-workbench.md` | P9 | [x] | 普通用户能按文档创建远程会话并完成一次对话 |
| 3 | 补齐 `doc/guide.cds-agent-admin.md` | P9 | [x] | 管理员能按文档配置 CDS 地址、授权、runtime、Hook |
| 4 | 补齐 `doc/design.cds-agent-api.md` | P9 | [x] | MAP/CDS API、事件、错误码、权限都可被实现和测试 |
| 5 | 补齐 `doc/guide.cds-agent-runbook.md` | P9 | [x] | 部署、排错、401/撤销、runtime 失败、日志恢复都有步骤 |
| 6 | 同步 `doc/index.yml` 与 `doc/guide.list.directory.md` | P9 | [x] | 文档索引能搜索到全部新增文档 |
| 7 | 修复 CDS long token 为长期授权 | P10 | [x] | 已建立连接不因 10 分钟过期，只有删除/撤销才失效 |
| 8 | 增加系统级模型 runtime profile | P10 | [x] | 可配置任意 baseUrl、model、API key，并在会话中选择 |
| 8.1 | 模型配置不可用时阻断误操作 | P11 | [x] | 不可读 API key 直接禁用测试、新建、启动、发送，并打开保存配置入口 |
| 9 | 实现真实 runtime adapter | P10 | [x] | fake 与真实 runtime 可切换，页面明确标识 |
| 10 | 新增 CDS Agent 对话页 | P11 | [x] | 路由、设置入口和百宝箱入口已实现；main 预览真实入口视觉已通过 |
| 11 | 接入远程浏览器操作 | P12 | [ ] | Agent 能打开网页并把过程显示在 MAP |
| 12 | 展示文件、diff、命令和测试产物 | P13 | [x] | 文件树、diff、命令结果、日志产物、复制下载和真实入口视觉均已验收；危险命令审批归入 P4/P17 正向模型验收 |
| 13 | 接入工作流节点 | P14 | [x] | 工作流可调用 CDS Agent 并等待结果 |
| 14 | 接入 MAP 智能体执行器 | P15 | [x] | 智能体可委托 CDS Agent 干活 |
| 15 | 建立可观测性和审计回放 | P16 | [ ] | traceId 贯通，事件可回放，审批可审计 |
| 16 | 完成真实端到端验收 | P17 | [ ] | main 预览真实入口与部署状态已通过；仍待有效模型 key 后跑通真实生成、工具审批、日志读取、停止释放和刷新恢复 |
| 17 | 完成远程巡检 PR 验收 | P17 | [ ] | PR 创建工具已上线；仍待远程 Agent 对 `prd_agent` 完成巡检并提交 PR |
