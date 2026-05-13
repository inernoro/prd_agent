# CDS Agent 工作台 · 计划

> **版本**：v1.0 | **日期**：2026-05-14 | **状态**：开发中

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
| P2 CDS 容器生命周期 | [ ] | [ ] | [ ] | 会话启动时创建或绑定运行实例，结束时释放 |
| P3 Agent 流式对话 | [ ] | [ ] | [ ] | 能发送 prompt 并收到流式事件 |
| P4 工具调用与权限 | [ ] | [ ] | [ ] | 能展示工具调用，支持允许/拒绝 |
| P5 MAP 测试台 UI | [ ] | [ ] | [ ] | 页面能新建会话、发消息、看过程、停止 |
| P6 Hook 配置 | [ ] | [ ] | [ ] | 支持启动前、启动后、结束前、结束后动作 |
| P7 产物与日志 | [ ] | [ ] | [ ] | 展示 diff、命令日志、容器日志、失败原因 |
| P8 端到端验收 | [ ] | [ ] | [ ] | 真页面跑完整用户路径 |

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
| P2.1 梳理 CDS 现有 executor / branch / shared-service 能力 | [ ] | [ ] | [ ] | 先复用，不重复造轮子 |
| P2.2 定义 CDS session API | [ ] | [ ] | [ ] | 若已有 API 不够，补最小接口 |
| P2.3 MAP 调 CDS 创建 session | [ ] | [ ] | [ ] | 使用 connection longToken |
| P2.4 CDS 返回 worker/container 信息 | [ ] | [ ] | [ ] | 包含 `cdsSessionId`、runtime、containerId |
| P2.5 停止会话释放容器 | [ ] | [ ] | [ ] | stop 后状态一致 |
| P2.6 异常清理 | [ ] | [ ] | [ ] | 创建失败、启动超时、停止失败 |

冒烟测试：

- MAP 创建会话后，CDS 能查到对应 session。
- 会话启动后，CDS worker/container 状态为 running 或 ready。
- 停止会话后，CDS 状态为 stopped/released。

视觉测试：

- 会话卡片显示“准备中 → 运行中 → 已停止”。
- 页面展示 CDS worker/container 标识。
- 启动失败时页面显示可读错误，不只显示 500。

### P3 Agent 流式对话

目标：用户能在 MAP 页面输入 prompt，远程 Agent 开始执行，页面看到流式响应。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P3.1 MAP 发送用户消息 | [ ] | [ ] | [ ] | 保存 user message |
| P3.2 MAP 代理调用 CDS send message | [ ] | [ ] | [ ] | 统一错误处理 |
| P3.3 CDS 转发到 Claude SDK sidecar | [ ] | [ ] | [ ] | 默认 runtime |
| P3.4 SSE 事件标准化 | [ ] | [ ] | [ ] | `text_delta`、`result`、`error` |
| P3.5 MAP 持久化 assistant message | [ ] | [ ] | [ ] | 断线后可恢复 |
| P3.6 前端流式渲染 | [ ] | [ ] | [ ] | 逐块追加，不能空白等待 |

冒烟测试：

- fake sidecar 返回固定文本，MAP 能收到完整 assistant message。
- 真实 sidecar 在有 key 时能返回至少一段文本。
- SSE 断开重连后不重复显示旧 token。

视觉测试：

- 输入“用一句话介绍这个会话”，点击发送。
- 页面立即出现用户消息。
- 2 秒内出现状态或流式内容。
- assistant 内容逐步出现或至少分阶段更新。

### P4 工具调用与权限

目标：Agent 使用工具时，用户能在 MAP 页面看到并控制。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P4.1 定义工具事件结构 | [ ] | [ ] | [ ] | `tool_call` / `tool_result` |
| P4.2 显示工具调用卡片 | [ ] | [ ] | [ ] | 工具名、参数摘要、耗时、状态 |
| P4.3 支持工具权限策略 | [ ] | [ ] | [ ] | 自动允许、每次询问、禁用 |
| P4.4 支持允许/拒绝操作 | [ ] | [ ] | [ ] | 前端按钮回写后端 |
| P4.5 支持危险命令提示 | [ ] | [ ] | [ ] | Bash/Edit/Write 等更醒目 |
| P4.6 记录审批事件 | [ ] | [ ] | [ ] | 审计可追溯 |

冒烟测试：

- fake runtime 发出 `tool_call`，页面和事件库都能记录。
- 拒绝工具后 runtime 收到拒绝结果。
- 允许工具后 runtime 继续输出。

视觉测试：

- 页面出现工具调用卡片。
- 权限按钮可点击，状态能从“等待确认”变成“已允许/已拒绝”。
- 拒绝后对话中能看到失败解释。

### P5 MAP 测试台 UI

目标：在“基础设施服务”页面做出可用的 Agent 测试台，不只是协议按钮。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P5.1 页面布局 | [ ] | [ ] | [ ] | 连接区、会话区、对话区、事件区 |
| P5.2 会话列表 | [ ] | [ ] | [ ] | 运行中、已停止、失败分组 |
| P5.3 新建会话弹窗 | [ ] | [ ] | [ ] | runtime、model、工具策略、hook profile |
| P5.4 对话输入框 | [ ] | [ ] | [ ] | 支持发送、禁用态、错误态 |
| P5.5 停止会话按钮 | [ ] | [ ] | [ ] | 二次确认可选 |
| P5.6 事件时间线 | [ ] | [ ] | [ ] | 状态、日志、工具调用统一时间线 |
| P5.7 空状态引导 | [ ] | [ ] | [ ] | 没连接、连接失效、无会话分别提示 |
| P5.8 响应式检查 | [ ] | [ ] | [ ] | 宽屏和窄屏不重叠 |

冒烟测试：

- 前端类型检查通过。
- 页面加载时不会因无连接、失效连接、空会话崩溃。
- mock 数据下会话区和事件区可渲染。

视觉测试：

- 从设置进入基础设施服务，不使用直达路由。
- 点“连接 CDS”或选择现有连接后能看到测试台。
- 新建会话、发送消息、停止会话的按钮状态符合实际状态。

### P6 Hook 配置

目标：允许用户配置启动前、启动后、结束前、结束后动作，先支持安全的最小能力。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P6.1 Hook 数据结构 | [ ] | [ ] | [ ] | `beforeStart` / `afterStart` / `beforeStop` / `afterStop` |
| P6.2 Hook profile 保存 | [ ] | [ ] | [ ] | 可复用配置 |
| P6.3 Hook 执行事件 | [ ] | [ ] | [ ] | 每个 hook 有开始、成功、失败 |
| P6.4 超时和失败策略 | [ ] | [ ] | [ ] | 阻断或继续可配置 |
| P6.5 UI 编辑器 | [ ] | [ ] | [ ] | 简单 textarea + 预设模板 |
| P6.6 安全提示 | [ ] | [ ] | [ ] | 明确命令运行位置和权限 |

冒烟测试：

- 配置 `echo beforeStart`，创建会话时能看到 hook 日志。
- hook 失败时会话按策略失败或继续。
- 停止会话时执行 `beforeStop/afterStop`。

视觉测试：

- 新建会话弹窗能选择 hook profile。
- 时间线显示 hook 执行结果。
- hook 失败时错误文案可读。

### P7 产物与日志

目标：用户不只看到最终文本，还能看 Agent 干活证据。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P7.1 容器日志面板 | [ ] | [ ] | [ ] | stdout/stderr 分流或标记 |
| P7.2 Agent 事件持久化 | [ ] | [ ] | [ ] | 刷新后可恢复 |
| P7.3 命令输出折叠 | [ ] | [ ] | [ ] | 长日志不撑爆页面 |
| P7.4 失败诊断摘要 | [ ] | [ ] | [ ] | 提取最后错误和建议 |
| P7.5 文件/diff 产物入口 | [ ] | [ ] | [ ] | 第一版可只读展示 |
| P7.6 下载/复制结果 | [ ] | [ ] | [ ] | 文本、日志、事件 JSON |

冒烟测试：

- 执行一条会产生 stdout 的任务，日志面板能看到。
- 失败任务能记录 `LastError`。
- 刷新页面后历史事件仍存在。

视觉测试：

- 日志面板可展开/折叠。
- 长日志不会遮挡输入框和按钮。
- 失败状态从会话列表到详情页一致。

### P8 端到端验收

目标：用真实用户路径证明第一版完成。

任务：

| 项 | 开发完成 | 冒烟测试完成 | 视觉测试完成 | 说明 |
|----|----------|--------------|--------------|------|
| P8.1 主分支部署到 CDS | [ ] | [ ] | [ ] | api/admin running |
| P8.2 从设置进入基础设施服务 | [ ] | [ ] | [ ] | 不用直达路由 |
| P8.3 建立或选择 active CDS 连接 | [ ] | [ ] | [ ] | 失效连接不能参与测试 |
| P8.4 新建 Agent 会话 | [ ] | [ ] | [ ] | 页面显示运行状态 |
| P8.5 发送 prompt | [ ] | [ ] | [ ] | 页面流式展示 |
| P8.6 查看工具/日志 | [ ] | [ ] | [ ] | 至少一个事件可见 |
| P8.7 停止会话 | [ ] | [ ] | [ ] | CDS 侧资源释放 |
| P8.8 刷新恢复 | [ ] | [ ] | [ ] | 会话历史仍可见 |
| P8.9 负向测试 | [ ] | [ ] | [ ] | 失效连接、CDS 401、runtime 失败 |

冒烟测试：

- 自动脚本跑通 create session -> send prompt -> receive stream -> stop session。
- CDS status 显示对应服务 running。
- 后端编译和前端类型检查通过。

视觉测试：

- Chrome 打开 `https://main-prd-agent.miduo.org/`。
- 从左侧“设置”进入“基础设施服务”。
- 按页面按钮完成完整流程。
- 截图或可访问性树能证明页面展示了流式输出、事件、停止状态。

## 7. API 详细清单

### 7.1 MAP API

| API | 方法 | 阶段 | 状态 |
|-----|------|------|------|
| `/api/infra-agent-sessions` | GET | P1 | [ ] |
| `/api/infra-agent-sessions` | POST | P1 | [ ] |
| `/api/infra-agent-sessions/{id}` | GET | P1 | [ ] |
| `/api/infra-agent-sessions/{id}/start` | POST | P2 | [ ] |
| `/api/infra-agent-sessions/{id}/messages` | POST | P3 | [ ] |
| `/api/infra-agent-sessions/{id}/events` | GET | P3 | [ ] |
| `/api/infra-agent-sessions/{id}/stream` | GET | P3 | [ ] |
| `/api/infra-agent-sessions/{id}/tool-approvals/{approvalId}` | POST | P4 | [ ] |
| `/api/infra-agent-sessions/{id}/stop` | POST | P2 | [ ] |
| `/api/infra-agent-sessions/{id}/logs` | GET | P7 | [ ] |
| `/api/infra-agent-hook-profiles` | GET/POST | P6 | [ ] |

### 7.2 CDS API

| API | 方法 | 阶段 | 状态 |
|-----|------|------|------|
| `/api/projects/{projectId}/agent-sessions` | POST | P2 | [ ] |
| `/api/projects/{projectId}/agent-sessions/{id}` | GET | P2 | [ ] |
| `/api/projects/{projectId}/agent-sessions/{id}/messages` | POST | P3 | [ ] |
| `/api/projects/{projectId}/agent-sessions/{id}/stream` | GET | P3 | [ ] |
| `/api/projects/{projectId}/agent-sessions/{id}/tool-approvals/{approvalId}` | POST | P4 | [ ] |
| `/api/projects/{projectId}/agent-sessions/{id}/stop` | POST | P2 | [ ] |
| `/api/projects/{projectId}/agent-sessions/{id}/logs` | GET | P7 | [ ] |

## 8. 前端页面结构

`InfraServicesPage` 后续拆组件，避免继续堆大文件：

| 组件 | 阶段 | 状态 | 说明 |
|------|------|------|------|
| `InfraConnectionsPanel` | P5 | [ ] | 现有连接列表拆出 |
| `AgentWorkbenchPanel` | P5 | [ ] | 测试台外壳 |
| `AgentSessionList` | P5 | [ ] | 会话列表 |
| `AgentSessionComposer` | P5 | [ ] | prompt 输入 |
| `AgentMessageStream` | P3/P5 | [ ] | 流式消息 |
| `AgentEventTimeline` | P4/P7 | [ ] | 状态、工具、日志 |
| `ToolApprovalCard` | P4 | [ ] | 工具审批 |
| `HookProfileEditor` | P6 | [ ] | hook 配置 |
| `AgentLogsPanel` | P7 | [ ] | 容器/运行日志 |

## 9. 测试矩阵

| 层级 | 工具 | 阶段 | 必测内容 |
|------|------|------|----------|
| 后端编译 | `dotnet build --no-restore` | 每个后端阶段 | 零 CS error |
| 后端单测 | `dotnet test` | P1-P4 | 状态机、权限、错误语义 |
| 前端类型 | `pnpm --prefix prd-admin tsc --noEmit` | P5-P7 | 类型通过 |
| 前端 lint | `pnpm --prefix prd-admin lint` | P5-P7 | 本次文件零新增 error |
| CDS 单测 | `npm --prefix cds test` | P2-P4 | session API、runtime adapter |
| 冒烟脚本 | 待新增 | P3/P8 | create -> send -> stream -> stop |
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
- 但 Agent 工作台尚未开始，不能声明达到 Claude Code Web 或 Codex Web 的任务执行能力。
- 下一步从 P1 开始，先补 MAP 会话 API 骨架，再逐阶段推进。
