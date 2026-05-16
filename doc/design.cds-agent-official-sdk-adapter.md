# design.cds-agent-official-sdk-adapter

| 字段 | 内容 |
| --- | --- |
| 模块 | CDS Agent / MAP 控制面 / Agent Runtime |
| 日期 | 2026-05-17 |
| 状态 | Draft for implementation |
| 目标 | 保留 MAP/CDS 控制面，把自研 agent loop 压缩为官方 SDK adapter |
| 关联 | `doc/plan.cds-agent-official-sdk-migration.md`, `doc/design.cds-agent-runtime-architecture.md`, `doc/debt.claude-sdk-executor.md` |

## 1. 结论

CDS Agent 不应继续扩大本仓库自研 agent loop。目标架构是：

```text
MAP UI / Toolbox / workflow
  -> MAP session, auth, audit, approval, event store
  -> CDS workspace, branch, container, secret, preview URL
  -> Runtime adapter
       -> official Claude Agent SDK for code work
       -> official OpenAI Agents SDK for generic orchestration when needed
       -> legacy sidecar loop only as temporary fallback
```

保留自研的部分只允许是控制面和产品集成层：账号、CDS 长期授权、workspace 选择、分支/容器/密钥、审批策略、审计、事件落库、日志回放、PR/产物归档、UI 可观察性。

需要压缩的部分是：`claude-sdk-sidecar/app/agent_loop.py` 中的多轮 tool loop、tool_use/history 拼装、usage 汇总、工具选择策略、以及和官方 SDK 重复的 session / permission / hook / MCP 能力。

## 2. 官方能力对照

| 能力 | Claude Agent SDK | OpenAI Agents SDK | 当前自研 | 迁移判断 |
| --- | --- | --- | --- | --- |
| 代码仓库读取、编辑、命令、上下文管理 | 覆盖，官方文档说明 SDK 复用 Claude Code 的工具、agent loop 和上下文管理 | 需要自建工具或 sandbox | `agent_loop.py` + repo tools | CDS Agent 代码任务优先迁到 Claude Agent SDK |
| Streaming | 覆盖 | 覆盖 | SSE 自研转译 | MAP 保留统一事件 envelope，底层改为 SDK stream mapper |
| Tool permission / approval | 覆盖 permissions 和用户输入/审批路径 | 覆盖 human review/guardrail，但需应用层接入 | `approval_wait` + MAP tools | 保留 MAP 审批 UI，adapter 映射到官方 permission/human review |
| MCP | 覆盖本地、HTTP/SSE、认证、tool allowlist | 覆盖 MCP/工具编排 | 自研 `ToolBridge` | 新工具优先 MCP；只有 MAP 私有审计/PR 归档可保留 API tool |
| Hooks / policy | 覆盖 hooks | guardrails / lifecycle 可覆盖部分 | 自研事件和工具拦截 | 迁移到 SDK hook/guardrail，再转 MAP 事件 |
| Subagents / handoff | Claude SDK 有 subagents | OpenAI SDK handoffs 更通用 | Toolbox 串行 adapter | 非代码智能体可先保留 Toolbox，后续按 handoff 统一 |
| Observability | OpenTelemetry / usage | Trace/span 默认覆盖 agent、generation、tool、handoff、guardrail | Mongo event + logs | 双写：官方 trace id + MAP session event id |
| Sandbox / workspace ownership | SDK 可运行在宿主环境，CDS 仍负责容器 | OpenAI sandbox agents 可评估，但不能直接替代现有 CDS 分支模型 | CDS 自研 | CDS 继续做 workspace/control plane |

参考来源：

- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Claude Agent SDK MCP: https://code.claude.com/docs/en/agent-sdk/mcp
- OpenAI Agents SDK: https://developers.openai.com/api/docs/guides/agents
- OpenAI Agents SDK handoffs: https://openai.github.io/openai-agents-python/handoffs/
- OpenAI Agents SDK tracing: https://openai.github.io/openai-agents-python/tracing/

## 3. 当前自研边界

### 3.1 CDS Agent 需要替换的运行时核心

| 位置 | 现状 | 处理 |
| --- | --- | --- |
| `claude-sdk-sidecar/app/agent_loop.py` | 自己管理 tool_use、tool_result、history、max turns | 迁移为 Claude Agent SDK adapter |
| `claude-sdk-sidecar/app/tool_bridge.py` | MAP 工具桥和审批等待 | 收缩为 MCP server 或 SDK permission callback 的 MAP bridge |
| `InfraAgentSessionService.RunRealRuntimeAsync` | 把 sidecar 事件转为 MAP 事件 | 保留，但只做事件 envelope 转译 |
| `ClaudeSidecarRouter` | 远程 sidecar pool 路由、SSE 解析 | 保留路由/健康检查；payload 改为 adapter 协议 |
| `CdsAgentAdapter` | Toolbox 调 CDS Agent，等待 500 条事件回放 | 改成异步 run handle + event cursor，避免同步阻塞 |

### 3.2 必须保留的 MAP/CDS 控制面

- MAP 登录态、用户 ID、组织权限、长期 CDS 授权。
- CDS project/branch/container/secret/preview URL 生命周期。
- Runtime profile：provider、model、baseUrl、key 引用、默认策略。
- Approval policy：`confirm-dangerous`、危险命令、人审记录。
- Event store：统一 `sessionId/runId/traceId/seq/type/payload`。
- Artifact store：日志、diff、测试输出、PR 链接、截图。
- Admin UI：健康状态、事件流、日志、审批、成本、失败原因。

## 4. Adapter 契约

新增运行时抽象只承接“官方 SDK 输出到 MAP 事件”的薄层，不再承接通用 agent loop：

```csharp
public interface IAgentRuntimeAdapter
{
    string RuntimeKey { get; }
    Task<RuntimeRunHandle> StartAsync(RuntimeRunRequest request, CancellationToken ct);
    IAsyncEnumerable<RuntimeEvent> StreamAsync(string runId, long afterSeq, CancellationToken ct);
    Task CancelAsync(string runId, CancellationToken ct);
    Task<RuntimeHealth> HealthAsync(CancellationToken ct);
}
```

`RuntimeRunRequest` 必须包含：

- `mapSessionId`, `traceId`, `userId`
- `workspaceRoot`, `gitRepository`, `gitRef`
- `prompt`, `systemPrompt`, `model`, `runtimeProfileId`
- `approvalPolicy`, `allowedTools`, `mcpServers`
- `secretsRef`，禁止把真实 key 写进事件

`RuntimeEvent` 统一映射：

| Event | 含义 |
| --- | --- |
| `runtime.init` | SDK 初始化、模型、workspace、tool allowlist |
| `text.delta` | 模型文本增量 |
| `tool.call` | 工具调用，含 SDK tool id 和 MAP tool id |
| `approval.requested` | 需要 MAP 人审 |
| `approval.resolved` | 人审结果 |
| `tool.result` | 工具结果摘要和 artifact 引用 |
| `trace.linked` | 官方 trace/OpenTelemetry span id |
| `usage.delta` | token、cost、duration |
| `artifact.created` | diff、log、screenshot、PR |
| `done` | final text 和 run outcome |
| `error` | 结构化错误码 |

## 5. 其他智能体兼容性

不是所有智能体都具备 CDS Agent 的“代码仓库执行”能力，也不应该全部迁成 Claude Agent SDK。

| 智能体 | 当前实现 | 是否同类功能 | 官方化方向 | 兼容风险 |
| --- | --- | --- | --- | --- |
| `cds-agent` | 远程 CDS session + sidecar + repo tools | 是，代码执行/PR/审计 | Claude Agent SDK primary，legacy fallback | 高：事件、审批、取消、workspace、PR 产物 |
| `prd-agent` | `ILlmGateway` 文本分析 | 否 | 可接 OpenAI Agents SDK trace/handoff | 低：保持输出 artifact |
| `defect-agent` | `ILlmGateway` 文本/JSON | 否 | 可接 OpenAI Agents SDK structured output/guardrail | 中：JSON 输出需 schema 校验 |
| `literary-agent` | `ILlmGateway` 文本生成 | 否 | 暂不需要 agent loop | 低 |
| `visual-agent` | 图片生成/视觉 gateway | 否 | 保留专用 media pipeline；可加 trace | 中：图片 URL、资产持久化、超时 |
| workflow/capsule `claude-sdk` | CLI Agent executor + sidecar | 是 | 同 CDS Agent 共享 adapter | 高：历史配置值和运行日志兼容 |

兼容策略：

1. `IAgentAdapter` 不立即删除；它是 Toolbox 层产品契约。
2. 新增 `IAgentRuntimeAdapter` 只服务运行时，先接 `cds-agent` 和 workflow `claude-sdk`。
3. `ToolboxRunEvent` 和 `InfraAgentEvent` 保持对前端兼容，新增字段只能放在 metadata/payload。
4. 旧 runtime 名 `claude-sdk` 保持配置兼容，但 UI/文档必须显示为 `Claude sidecar runtime` 或 `Claude Agent SDK adapter`。
5. OpenAI Agents SDK 先用于非代码智能体的 trace/handoff 试点，不替代 CDS sandbox。

## 6. 关键风险

| 风险 | 影响 | 控制 |
| --- | --- | --- |
| 官方 SDK 工具名和现有 MAP tool 名不一致 | 事件和审批回放断裂 | 建 tool id 映射表，事件保存两套 id |
| Cancel 缺失 | UI 停止按钮只停 MAP session | adapter 必须持久化 official run id / process id |
| 同步等待 | Toolbox 卡住 worker | Start 返回 run handle，事件用 cursor 拉取 |
| 事件超过 500 条 | 审计丢失 | 后端分页 cursor；UI 分段加载 |
| SDK trace 泄露敏感内容 | 合规风险 | 默认 MAP 自有 trace，官方 trace 只存 id；敏感 payload 可关闭 |
| 多 provider 兼容 | OpenAI/Claude/第三方模型能力不同 | runtime profile 标注 provider capability |
| 视觉测试无效 | 页面好看但功能失败 | 每个周期必须绑定一个真实 run 状态和截图 |

## 7. Definition of Done

第一阶段不能用“页面能打开”作为完成标准。必须同时满足：

- 能用官方 Claude Agent SDK adapter 跑一个真实 repo inspection smoke。
- MAP UI 能看到 init/text/tool/approval/result/done/error 全链路。
- Stop 能真正取消底层 SDK run。
- 事件分页不丢超过 500 条的运行。
- Toolbox 调 `cds-agent` 不阻塞后台 worker 到运行结束。
- 文档不再把历史 `claude-sdk` 误写成完整官方 SDK 接入。
- 远程 CDS 预览截图能显示真实运行状态，而不是静态 mock。

## 8. Implementation Notes

2026-05-17 第一轮实现只建立 seam，不声称已完成官方 SDK 迁移：

- `IInfraAgentRuntimeAdapter` 已成为 MAP/CDS runtime 边界。
- `LegacySidecarRuntimeAdapter` 先把现有 sidecar 协议藏在 adapter 后面，作为官方 SDK adapter 上线前的 fallback。
- `InfraAgentSessionService` 不再直接消费 `IClaudeSidecarRouter.RunStreamAsync`，而是消费 runtime adapter。
- session 开始持久化 `CurrentRuntimeRunId` 和 `RuntimeAdapter`，为 UI debug panel、真实 cancel、trace 关联做准备。
- `ClaudeSidecarRouter.CancelRunAsync` 已补 best-effort cancel，当前会广播到可路由 sidecar；后续官方 SDK adapter 需要改成精确取消官方 run/session。
- `/cds-agent` 页面已显示 runtime adapter、run id、runtime instance、event source 和 cancel 状态；无 active session 时也保留空态诊断。当前本地截图只证明 UI 渲染，仍需真实远程 run 截图验证这些字段来自运行时事件。

2026-05-17 第二轮实现新增官方 SDK adapter spike，但仍是可选路径：

- `claude-sdk-sidecar/app/official_agent_sdk.py` 使用官方 `claude-agent-sdk` 的 `ClaudeSDKClient`、`tool()`、`create_sdk_mcp_server()` 和 `ClaudeAgentOptions`，把 MAP 工具桥包装为 in-process MCP server。
- sidecar 支持 `runtimeAdapter=claude-agent-sdk` 或 `SIDECAR_AGENT_ADAPTER=claude-agent-sdk` 选择官方路径；默认仍为 `legacy-sidecar`。
- MAP 后端支持通过 `INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER=claude-agent-sdk` 透传选择项，保留现有 `LegacySidecarRuntimeAdapter` 作为 fallback。
- 新增 `runtime_init` 事件映射，MAP 会把 adapter、allowed tools、permission mode、cwd 等初始化信息落为 `InfraAgentEventTypes.Log`，用于 UI 调试和审计。
- 当前 spike 已改为 `ClaudeSDKClient` 结构，sidecar cancel event 会调用官方 `client.interrupt()` 并把结果映射为 `error_code=cancelled`。这只是 adapter 层取消闭环；跨进程精确定位、会话恢复和远程真实 run 仍需下一轮验证。
- 本机尚未安装 `claude_agent_sdk`，所以真实 official SDK run 需要先完成依赖、Claude Code CLI、provider key、workspace 权限配置后验证。
- 新增 `claude-sdk-sidecar/tests/test_official_agent_sdk_adapter.py`，用 fake SDK 验证 `runtime_init/text_delta/usage/done` 和 `cancel -> interrupt -> usage/error(cancelled)` 两条结构路径。
- `/cds-agent` 页面事件刷新已改为 `afterSeq` 增量拉取并按 seq 去重合并；前端也已接入 `/stream?afterSeq=&limit=` 作为 SSE 续读路径，失败时回退 JSON 分页。后端 `/stream` 已改为长连接 SSE + keepalive；Toolbox `cds-agent` 回放也从固定 500 条改为游标批量读取。下一步应做远程真实长会话验证。
- sidecar `/readyz` 现在返回 adapter diagnostics：official SDK 包、Claude CLI、workspaceRoot、allowed tools、permission mode、写工具 opt-in、approval bridge。MAP 通过 `/api/infra-agent-sessions/runtime-status` 透出 sidecar pool 诊断，页面可看到 runtime pool healthy/instance 数，避免把 SDK/CLI 缺失伪装成模型调用失败。
- Toolbox `cds-agent` 入口已改为异步委托语义：创建 MAP/CDS session、发送任务、入队 runtime job 后立即产出 `CDS Agent 远程运行句柄` artifact，并给出 `/cds-agent?sessionId=...`、event stream、events、logs 路径。Toolbox 运行页会把该 artifact 渲染为远程运行卡片和“打开工作台”操作。Toolbox step 表示“委托已创建”，真实远程 run 状态仍由 MAP session 和 `/cds-agent` 工作台观察。
- `SendMessageAsync` 已从同步等待 runtime run 改为后台 job 模式：HTTP 请求写入用户消息、导入 CDS 事件、追加 `runtime job queued` 日志并入队；`InfraAgentRuntimeWorker` 从 `IInfraAgentRuntimeJobQueue` 消费后调用 runtime adapter，异常会写回 MAP error 事件。
- 官方 adapter 默认只开放 `Read/Grep/Glob` 只读内置工具，`permission_mode=default`。`Bash/Edit/Write` 必须通过 `CLAUDE_AGENT_SDK_ALLOWED_TOOLS` 显式 opt-in，且 `runtime_init` 会记录 `builtinWriteToolsEnabled` 和具体工具名。
- 第一版官方 permission bridge 已接入 `ClaudeAgentOptions.can_use_tool`：只读内置工具直接 allow；`Bash/Edit/Write` 会向 MAP `POST /api/agent-tools/approvals/{runId}/{approvalId}/request` 创建 `tool_call` 审批事件，再复用 `/wait` 等待 MAP approval，最后返回 `PermissionResultAllow` 或 `PermissionResultDeny`。这仍需要真实 UI 审批和远程 official SDK run 验证。

依赖校准：

- 临时安装真实 `claude-agent-sdk` 验证到当前解析版本 `0.2.82`，并确认 `ClaudeSDKClient`、`ClaudeAgentOptions`、`tool()`、`create_sdk_mcp_server()` 的签名与 adapter 使用方式匹配。
- `claude-agent-sdk` 依赖链需要 `pydantic>=2.11`，因此 sidecar requirements 已从 `pydantic==2.9.2` 升到 `2.13.4`。
- 为避免 pip 把 `starlette` 解到与 `fastapi==0.115.0` 不兼容的 `1.0.0`，requirements 固定 `starlette==0.38.6` 和 `sse-starlette==3.0.3`。
