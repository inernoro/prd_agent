# debt.cds.agent.sdk-executor

| 字段 | 内容 |
|---|---|
| 模块 | claude-sdk 执行器 / Python sidecar |
| 状态 | 活跃 |
| 关联 | `doc/design.claude-sdk-executor.md` |

---

## 已知工程债务

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| D-1 | `/api/agent-tools/invoke` callback controller + 内置工具注册表 | P1 | 任何想让 Claude 自主调工具的 Agent | DONE (v0.2) |
| D-2 | `ExecuteCliAgent_ClaudeSdkAsync` 写入 `llmrequestlogs`（StartAsync / MarkFirstByte / MarkDone / MarkError） | P1 | 上线前 | DONE (v0.2) |
| D-3 | admin 前端 `WorkflowNodeEditor` 没有 claude-sdk 专属配置面板（`model / systemPrompt / sidecarTag / maxTurns / tools`）。当前只能通过 raw JSON 编辑节点配置。 | P2 | 给 PM/QA 用之前必须做 | open |
| D-4 | 没有 Polly 重试 / 熔断器保护对 sidecar 的 HTTP 调用，依赖 `IHttpClientFactory` 默认行为。HostedService 健康检查能避开宕机实例，但无法处理瞬时 5xx 抖动。 | P2 | 多实例高并发场景 | open |
| D-5 | sidecar 的 callback 用 `X-Sidecar-Token` 对称鉴权（双向同 token），未走 `RequireScopeAttribute`。生产场景如果想限定哪些工具被调，需要在工具层做 scope 检查（节点配置的 tools 白名单已经形成第一道防线）。 | P3 | 高安全敏感场景 | mitigated |
| D-6 | `claude-sdk` 执行器返回的 artifact 格式硬编码为 HTML 页面（与 `builtin-llm` 看齐）。如果 Agent 输出是 JSON / Markdown / 代码 patch，artifact 类型需要根据 prompt 推断。 | P3 | 多场景 Agent 落地后 | open |
| D-7 | sidecar Dockerfile 没做多阶段构建 + 非 root 用户。镜像略大且以 root 运行。 | P3 | 上生产前 | open |
| D-8 | 未做端到端集成测试。`ClaudeSidecarRouter` 的 SSE 解析、`InstanceStateRegistry` 的并发行为、健康检查的失败计数都只有 code review，没有 xunit 覆盖。 | P2 | 推到主分支前 | open |
| D-9 | `appsettings.json` 中的 `ClaudeSdkExecutor` 段对开发者可见，可能误以为已启用。需要在 admin UI 加 "claude-sdk 状态" 卡片提示当前是否真的有 sidecar 配置。 | P3 | 与 D-3 一起做 | open |
| D-10 | 历史备注：v0.2 早期内置工具极简。当前已经扩展 repo / PR / Bridge 工具，但缺陷查询、文档读取、PR diff 结构化审查等业务工具仍需按"一个工具一个 PR"节奏扩充。 | P2 | 实际 Agent 上线前 | partially done |
| D-11 | `CDS Agent` 页面发送消息曾同步 HTTP 等待后端跑完 sidecar，再靠 3 秒轮询刷新事件；长任务可观察性不足。 | P1 | 任务超过几十秒或需要实时观察时 | partially done: SendMessage 已改为入队 runtime job，`InfraAgentRuntimeWorker` 后台执行；页面已接 `/stream?afterSeq=` SSE 续读并保留轮询兜底；真实远程 run 验证待做 |
| D-12 | `Stop` 只停止 CDS session，没有持久化 sidecar runId 并调用 `/v1/agent/cancel/{runId}`，长模型调用可能继续跑。 | P1 | 长任务、卡住任务、用户主动停止 | partially done: session 已持久化 `CurrentRuntimeRunId`，Stop 已 best-effort 调 sidecar cancel；官方 SDK 精确 interrupt 仍待 `ClaudeSDKClient` |
| D-13 | 事件列表和页面详情默认最多 500 条，长审查会话会截断后续事件；需要 afterSeq 分页、增量订阅和前端去重。 | P1 | 大型代码审查、PR 创建链路 | partially done: 后端已有 afterSeq；`/stream` 已改为长连接 SSE + keepalive；`/cds-agent` 页面已通过 JSON 分页和 SSE 双路径增量合并事件，Toolbox `cds-agent` 已游标批量读取；远程视觉/真实长会话待验证 |
| D-14 | `repo_run_command` 单次命令上限 180 秒，不适合大型测试套件；需要长命令后台化、stdout/stderr 增量事件和取消。 | P1 | dotnet test / npm build / 集成测试较慢 | open |
| D-15 | `repo_create_pull_request` 默认创建 draft PR；应改为 runtime profile 或任务级策略，低风险测试/文档修复默认 ready PR。 | P2 | 自动修复和 PR 闭环稳定后 | open |
| D-16 | 历史名 `claude-sdk` 容易让人误以为完整接入官方 Claude Code SDK / Claude Agent SDK；需要逐步把产品文案改成 `Claude sidecar runtime` 或 `CDS Agent runtime`。 | P1 | 文档、UI、对外沟通 | open |
| D-17 | 官方 Claude Agent SDK adapter 仍是 spike：虽然 adapter 已改用 `ClaudeSDKClient.interrupt()` 结构，但还没跑真实 SDK 包、provider key、workspace 和远程 CDS sidecar pool 的 smoke；外部 PATH 上的 `claude` 命令只做诊断观测，不是默认 ready gate。 | P1 | 想达到商业级取消、续跑、真实远程 smoke 时 | open |
| D-18 | 官方 Claude Code 内置 `Bash/Edit/Write` 工具还没接 MAP permission callback / approval bridge；当前默认只读，写入/命令需显式 opt-in。 | P1 | 想让 official adapter 执行修改、测试、PR 前 | partially done: 已接 `can_use_tool` -> MAP approval request/wait 骨架；真实 UI 审批和远程 official SDK run 未验证 |
| D-19 | Toolbox `cds-agent` 已能产出远程运行句柄并重新附着远程会话事件流，但真实远程 official SDK run 的审批闭环还没验证。 | P1 | 从 AI 百宝箱发起长代码任务时 | partially done: adapter 已返回 `sessionId/workbenchPath/eventStreamPath/logsPath` 句柄，Toolbox 运行页已渲染句柄卡片、“打开工作台”和“停止”按钮，并订阅远程 SSE/轮询兜底展示最近事件；等待审批的工具调用会在 Toolbox 内联显示允许/拒绝 |

---

## 偿还顺序建议

```
D-1 + D-2 同时做（一个 PR）：补 callback controller + llmrequestlogs 写入
  ↓
D-11 + D-12 + D-13 先做：后台 run、真 SSE/分页、停止取消
  ↓
D-3 + D-9 同时做：admin UI 配置面板 + 状态卡片
  ↓
D-5 + D-8：scope 验证 + xunit 集成测试
  ↓
D-4 D-6 D-7 D-14 D-15 D-16：按需补
```

---

## 历史背景

2026-05-05 v0.1 落地时为了"先把骨架跑通让用户看到形态"，主动延迟了上述 9 条。本文件即"延迟清单"，避免下一次 session 不知道这些坑。
