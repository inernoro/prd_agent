# Claude SDK 执行器设计 · 设计

> **版本**：v1.0 | **日期**：2026-07-17 | **状态**：已落地

> 范围：MAP/CDS Agent 运行时与历史 `claude-sdk` 执行器兼容层

## 1. 结论

`claude-sdk` 是需要长期兼容的历史执行器标识，不是当前运行时实现的准确名称。当前默认路径是 Claude Agent SDK sidecar：官方 SDK 负责 Agent turn loop、上下文和工具调用，MAP/CDS 只负责控制面、工作区、权限、审计、事件和产物。

旧的 Anthropic Messages 自研循环仅在显式选择 `legacy-sidecar` 时加载，不得作为默认路径，也不得继续扩展。

## 2. 定位与选择

| 场景 | 应选路径 |
| --- | --- |
| 代码仓库检查、编辑、命令和多轮工具调用 | Claude Agent SDK sidecar |
| MAP/CDS 会话、审批、审计、工作区和产物 | MAP/CDS 控制面 |
| 普通文本、结构化生成和媒体业务 | `ILlmGateway` 或专用媒体网关 |
| 旧流程配置仍写 `executorType=claude-sdk` | 兼容映射到当前 sidecar runtime |
| 仅为故障诊断临时复现旧行为 | 显式 `legacy-sidecar` |

因此，`claude-sdk` 不替代 LLM Gateway；它只覆盖需要自治 Agent loop 和远程工作区的执行任务。

## 3. 职责边界

| 层 | 负责内容 | 不负责内容 |
| --- | --- | --- |
| MAP | 登录、会话、事件、审批、取消、审计和产物展示 | Agent turn loop |
| CDS | workspace、分支、容器、运行时池、密钥注入和资源生命周期 | 模型决策与工具选择 |
| runtime adapter | 请求映射、事件转译、健康路由和取消句柄 | 自己实现第二套 SDK loop |
| Claude Agent SDK | turn loop、上下文、工具调用和流式事件 | MAP 多租户与 CDS 基础设施 |
| legacy sidecar | 兼容旧 Anthropic Messages 循环 | 默认生产路径和新增能力 |

历史配置名、事件名和数据库字段可以保留兼容，但 UI 与新文档应使用“Claude Agent SDK runtime”或“Claude sidecar runtime”。

## 4. 当前架构

一次运行按以下边界流转：

1. Workflow、Capsule 或 CDS Agent 创建 MAP Run。
2. `CapsuleExecutor` 或 `InfraAgentSessionService` 选择运行时 adapter。
3. `ClaudeSidecarRouter` 从静态配置或 CDS paired runtime 中选择健康实例。
4. 主服务通过受鉴权的 HTTP/SSE 请求 sidecar。
5. sidecar 默认调用官方 `claude-agent-sdk`，在指定 workspace 内运行。
6. adapter 把 SDK 文本、工具、审批、用量、产物、完成和错误事件映射回 MAP。
7. MAP 持久化会话事实，CDS 负责 runtime 与 workspace 生命周期。

sidecar 可与主服务同一编排部署，也可由 CDS 共享运行时池提供。业务层不应依赖实例地址。

## 5. 状态与事件

运行状态至少包含 `sessionId`、`runId`、`runtimeAdapter`、runtime instance、workspace、事件游标和取消结果。事件对外保持稳定 envelope，常见类型包括：

- 初始化与就绪诊断；
- 文本增量；
- 工具调用、审批请求与工具结果；
- usage 与 trace 关联；
- diff、日志、截图、PR 等产物；
- 完成、取消和结构化错误。

真实 provider key 不写入事件、日志或产物；事件仅保存 profile 或 secret 引用。

## 6. 接口边界

### 6.1 主服务到 sidecar

主服务使用 sidecar 的运行、取消、存活和就绪端点。运行响应使用 SSE，取消必须关联真实 runtime run id，不能只停止前端订阅。

请求与事件结构分别以 C# runtime adapter 契约和 sidecar schema 为准。字段调整必须同时验证两端序列化和事件回放兼容性。

### 6.2 工具、审批与产物

新工具优先通过官方 SDK 工具或 MCP 接入。MAP 私有能力只保留薄桥接层，用于：

- 把 SDK permission request 转成 MAP 审批记录；
- 在用户决定后恢复原运行；
- 对危险操作执行 allowlist 和审计；
- 将 diff、测试日志、截图和 PR 链接登记为 MAP 产物。

不得在文档中复制工具注册代码。工具事实源是 `IAgentTool` 实现、runtime adapter 和对应测试。

## 7. 配置与部署

配置分为三类：

| 配置 | 事实源 | 要求 |
| --- | --- | --- |
| runtime adapter | sidecar 默认值和请求 profile | 缺省为 `claude-agent-sdk` |
| sidecar 发现 | `ClaudeSdkExecutor` 静态配置或 CDS paired discovery | 至少有一个健康实例 |
| provider 凭据 | MAP runtime profile 或受控环境注入 | 不得写进仓库或普通日志 |

生产环境必须配置独立 sidecar token 并使用受保护网络；`dev-skip` 只允许本地开发。远程实例必须通过 TLS 或受控内网访问。

## 8. 就绪、失败与降级

`/readyz` 应同时反映 sidecar token、官方 SDK 包、workspace 和 provider key 模式。实例不就绪时，路由器应返回明确 blocker 与 next action，而不是静默改走旧 loop。

失败处理遵循以下顺序：

1. 当前实例不可用时，在同类健康 runtime 中重路由。
2. 运行已开始后保留 run id、最后事件游标和诊断信息。
3. 取消操作尽力发送到底层 SDK，并把结果写回会话。
4. 只有显式配置 `legacy-sidecar` 才允许旧循环；不得自动降级。

## 9. 当前状态与剩余边界

已落地事实：

- 默认 adapter 常量为 `claude-agent-sdk`；
- sidecar 对官方 SDK 依赖、workspace 和 loop owner 提供就绪诊断；
- legacy loop 使用延迟导入且必须显式选择；
- MAP 已保存 runtime adapter、run id、实例和取消状态；
- 静态 sidecar 与 CDS paired runtime 均可参与发现。

剩余迁移和商业化门禁记录在 `doc/debt.cds.agent.sdk-executor.md` 与 `doc/plan.cds.agent.official-sdk-migration.md`，不在本设计里维护执行清单。

## 10. 关联文档

- `doc/design.cds.agent.official-sdk-adapter.md`
- `doc/design.cds.agent.runtime-architecture.md`
- `doc/design.cds.agent.managed-runtime-fact-source.md`
- `doc/guide.cds.agent.sdk-quickstart.md`
- `doc/debt.cds.agent.sdk-executor.md`
