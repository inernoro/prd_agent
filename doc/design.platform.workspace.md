# CLI Agent 工作空间 · 设计

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

## 管理摘要

- **解决的问题**：不同 CLI Agent 的输入、输出和运行方式不一致，用户难以获得统一的多轮生成与预览体验。
- **核心方案**：把工作空间定义为持久化会话、执行器配置和最新网页产物的组合，所有执行器统一输出事件流。
- **当前状态**：工作空间模型、创建与查询 API、SSE 对话、CLI Agent 执行器复用和 HostedSite 发布均已落地。
- **边界**：平台负责接入、持久化、展示和控制，不重建外部 Agent 的内核或终端界面。

## 问题背景

CLI Agent 可能通过本地模型、Docker、HTTP API、脚本或专用 SDK 执行。直接为每种 Agent 建一套页面和协议，会造成重复实现，也会让用户在不同工具之间切换操作习惯。

工作空间提供统一外壳：用户持续发送修改意见，执行器完成一轮任务，平台记录消息、保存产物并返回预览。执行器差异被封装在适配层，前端只处理统一状态和事件。

## 设计目标

1. 同一工作空间支持多轮迭代，并把上一轮 HTML 作为下一轮上下文。
2. 所有执行器共享创建、查询、对话和删除协议。
3. 长任务通过 SSE 持续展示阶段、日志、产物和预览。
4. 网页产物统一发布到 HostedSite，工作空间只保存引用和最新 HTML。
5. 每个请求都按当前用户隔离，不允许跨用户读取或修改。

## 核心决策

| 决策 | 说明 |
|------|------|
| 工作空间是组合能力 | 复用消息、CLI Agent 执行器和 HostedSite，不另建 Agent 内核 |
| 一轮对话一次执行 | 用户消息触发一轮执行，成功后写回 assistant 消息和预览 |
| 执行器配置持久化 | 创建时保存执行器、框架、风格和规范类型 |
| 输出统一事件化 | 执行器内部差异转换为阶段、日志、预览、完成或错误事件 |
| 最新产物递进 | 下一轮把最新 HTML 和用户反馈作为输入，支持连续修改 |

## 数据设计

### Workspace

| 字段组 | 主要字段 | 用途 |
|--------|----------|------|
| 身份 | `Id`、`UserId`、`Name` | 所有权与展示名称 |
| 执行器 | `ExecutorType`、`DockerImage`、`ApiEndpoint`、`ContainerId` | 执行方式和专用配置 |
| 生成配置 | `Framework`、`Style`、`Spec` | 页面生成约束 |
| 运行状态 | `Status`、`RoundCount`、`ErrorMessage` | 当前阶段和轮次 |
| 历史 | `Messages` | 用户与 Agent 的多轮消息 |
| 产物 | `LatestSiteId`、`LatestPreviewUrl`、`LatestHtmlOutput` | 最新网页及下一轮上下文 |
| 时间 | `CreatedAt`、`LastActiveAt` | 排序和活跃度 |

状态使用 `idle`、`running`、`completed`、`error`。当前对话成功后回到 `idle`，表示可继续输入下一轮。

### WorkspaceMessage

每条消息记录角色、内容、轮次、时间。Agent 消息可额外关联 HostedSite、预览地址和变更文件数，使历史记录能够回到对应产物。

## 运行流程

1. 用户创建工作空间并选择执行器与生成配置。
2. 用户发送指令，后端校验所有权并把状态改为 `running`。
3. 后端把工作空间配置转换为 CLI Agent 工作流节点。
4. 最新 HTML 作为前序产物，当前消息作为用户反馈，交给 `CapsuleExecutor`。
5. 执行器持续向客户端发送阶段和日志事件。
6. HTML 产物发布为 HostedSite，并返回预览事件。
7. 后端保存 Agent 消息、轮次、最新 HTML 和预览信息，状态恢复为 `idle`。
8. 失败时保存错误信息并发送错误事件，历史工作空间仍可查询。

## 执行器适配

当前统一分发入口支持以下类型：

| 类型 | 典型用途 |
|------|----------|
| `builtin-llm` | 使用平台 LLM 直接生成 |
| `docker` | 在容器中执行 CLI Agent |
| `api` | 调用外部 HTTP Agent |
| `script` | 执行受控脚本 |
| `lobster` | 接入 Lobster 执行器 |
| `claude-sdk` | 通过 Claude Agent SDK sidecar 执行 |

新增执行器时，应复用 `ExecuteCliAgentAsync` 的统一输入、产物槽位和事件委托，不应增加新的工作空间 API。

## API 与事件

| 方法 | 路径 | 用途 |
|------|------|------|
| `POST` | `/api/workspaces` | 创建工作空间 |
| `GET` | `/api/workspaces` | 分页列出当前用户工作空间 |
| `GET` | `/api/workspaces/{id}` | 获取详情、消息与最新预览 |
| `POST` | `/api/workspaces/{id}/chat` | 启动一轮执行并返回 SSE |
| `DELETE` | `/api/workspaces/{id}` | 删除当前用户工作空间 |

对话流至少包含 `phase`、`preview`、`done`、`error`。具体执行器还可发送 `cli-agent-phase`、日志或产物事件；前端应按事件类型增量渲染，不能让用户面对静止等待。

## 安全与边界

- 所有工作空间查询和写入同时匹配 `Id` 与当前 `UserId`。
- 外部执行器的命令、网络和文件权限由对应适配器控制，工作空间模型不扩大权限。
- HostedSite 发布失败不应抹掉执行结果，但必须在日志中保留可诊断信息。
- 本设计不提供通用文件编辑器、完整终端模拟或多 Agent 自主编排。

## 事实来源

| 文件 | 职责 |
|------|------|
| `prd-api/src/PrdAgent.Core/Models/Workspace.cs` | 工作空间与消息模型 |
| `prd-api/src/PrdAgent.Api/Controllers/Api/WorkspacesController.cs` | API、SSE、持久化与发布流程 |
| `prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs` | CLI Agent 执行器统一分发 |
| `prd-api/src/PrdAgent.Core/Models/CapsuleTypeRegistry.cs` | 执行器输入输出槽位定义 |
| `prd-api/src/PrdAgent.Core/Interfaces/IHostedSiteService.cs` | 网页产物发布契约 |
| `claude-sdk-sidecar/` | Claude SDK 执行环境与 workspace 准备 |
