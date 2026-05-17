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

### 2.1 官方优先决策表

后续每个 CDS Agent 能力都先过这张表，避免再次把 SDK 已经负责的运行时能力写回自研 loop：

| 问题 | 结论 | 代码归属 |
| --- | --- | --- |
| 官方 SDK 是否已经提供 agent turn loop、上下文管理、工具调用、streaming？ | 是，则本仓库不能再实现第二套 loop | `claude_agent_sdk` / `agents` |
| 官方 SDK 是否已经提供 permission / human review / guardrail？ | 是，则 MAP 只提供审批 UI、策略和审计记录 | SDK callback + MAP approval bridge |
| 官方 SDK 是否已经提供 trace / usage / result metadata？ | 是，则 MAP 只保存 trace link 和脱敏摘要 | SDK trace + MAP event envelope |
| 官方 SDK 是否不负责多租户账号、CDS branch、workspace、secret、preview URL？ | 是，这些必须保留自研控制面 | MAP/CDS |
| 官方 SDK 是否无法表达现有产品产物，例如 PR 链接、截图、审计包？ | 是，只保留产品 adapter，不扩大 runtime loop | MAP artifact/event store |
| 能力是否只服务非代码文本/图片 agent？ | 是，优先保持现有 gateway，逐步接 trace/guardrail | `ILlmGateway` / media pipeline |

一个实现如果同时做“选择下一步工具、维护多轮消息、解释 tool result、决定是否继续思考”，默认就是 agent loop。除非官方 SDK 没有对应能力，否则应删除或收缩。

### 2.2 最小自研面

目标状态下，CDS Agent 自研代码只保留这些薄层：

- `RuntimeProfileResolver`：把 MAP 里的 provider/model/key ref/baseUrl 解析成 SDK 可用配置，禁止把密钥写入事件。
- `WorkspaceResolver`：把 CDS project/branch/repo/ref 准备成 SDK `cwd`，并输出 commit/workspace 证据。
- `PermissionBridge`：把 SDK permission request 映射成 MAP approval request，再把用户 decision 返回 SDK。
- `EventMapper`：把 SDK message/trace/usage/tool/error 映射成稳定的 MAP event schema。
- `RunHandleStore`：保存 official SDK session/run id、cancel handle、trace id 和 event cursor。
- `ArtifactCollector`：收集 diff、测试日志、截图、PR 链接和可导出的诊断包。

除此之外的 loop、工具选择、history 拼装、usage 聚合、MCP 协议翻译都应优先使用官方实现。

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

### 5.1 兼容性结论

- `cds-agent` 和 workflow/capsule 的历史 `claude-sdk` 是同一类问题：代码仓库运行、工具、审批、取消、长事件流。它们应共享 official SDK runtime adapter。
- PRD/缺陷/文学/视觉 agent 不是同一类问题：它们的核心价值在结构化输出、媒体管线或业务 prompt，不应该因为 CDS Agent 迁移而依赖 sidecar pool。
- OpenAI Agents SDK 更适合作为非代码 agent 的 orchestration / handoff / tracing 试点；Claude Agent SDK 更适合代码仓库执行。两者都不能替代 MAP/CDS 的账号、权限、workspace、审计和部署控制面。
- 兼容性测试必须证明“非代码 agent 不因为 official SDK sidecar 不健康而失败”。这比简单编译更重要，因为历史问题通常来自 DI 或全局 worker 依赖被误接到所有 agent。

兼容策略：

1. `IAgentAdapter` 不立即删除；它是 Toolbox 层产品契约。
2. 新增 `IAgentRuntimeAdapter` 只服务运行时，先接 `cds-agent` 和 workflow `claude-sdk`。
3. `ToolboxRunEvent` 和 `InfraAgentEvent` 保持对前端兼容，新增字段只能放在 metadata/payload。
4. 旧 runtime 名 `claude-sdk` 保持配置兼容，但 UI/文档必须显示为 `Claude sidecar runtime` 或 `Claude Agent SDK adapter`。
5. OpenAI Agents SDK 先用于非代码智能体的 trace/handoff 试点，不替代 CDS sandbox。
6. `CdsAgentRuntimeCompatibilityTests` 固化该边界：非代码 Toolbox adapter 不能依赖 `IInfraAgentRuntimeAdapter`、`IClaudeSidecarRouter` 或 `InfraAgentRuntimes`。

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
- `SidecarRuntimeAdapter` 只表示 MAP 到 sidecar 的传输层：路由、SSE 映射和取消。真实 turn loop 由请求里的 `runtimeAdapter` 决定，默认走 `claude-agent-sdk`，仅显式配置时回退 sidecar legacy loop。
- `InfraAgentSessionService` 不再直接消费 `IClaudeSidecarRouter.RunStreamAsync`，而是消费 runtime adapter。
- session 开始持久化 `CurrentRuntimeRunId` 和 `RuntimeAdapter`，为 UI debug panel、真实 cancel、trace 关联做准备。
- `ClaudeSidecarRouter.CancelRunAsync` 已补 best-effort cancel，当前会广播到可路由 sidecar；后续官方 SDK adapter 需要改成精确取消官方 run/session。
- `/cds-agent` 页面已显示 runtime adapter、run id、runtime instance、event source 和 cancel 状态；无 active session 时也保留空态诊断。当前本地截图只证明 UI 渲染，仍需真实远程 run 截图验证这些字段来自运行时事件。

2026-05-17 第二轮实现新增官方 SDK adapter spike，但仍是可选路径：

- `claude-sdk-sidecar/app/official_agent_sdk.py` 使用官方 `claude-agent-sdk` 的 `ClaudeSDKClient`、`tool()`、`create_sdk_mcp_server()` 和 `ClaudeAgentOptions`，把 MAP 工具桥包装为 in-process MCP server。
- sidecar 支持 `runtimeAdapter=claude-agent-sdk` 或 `SIDECAR_AGENT_ADAPTER=claude-agent-sdk` 选择官方路径；standalone 默认仍为 `legacy-sidecar`。
- MAP 后端默认透传 `claude-agent-sdk`，保留 `INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER=legacy-sidecar` 显式 fallback 和现有 `SidecarRuntimeAdapter` 传输层。
- 新增 `runtime_init` 事件映射，MAP 会把 adapter、allowed tools、permission mode、cwd 等初始化信息落为 `InfraAgentEventTypes.Log`，用于 UI 调试和审计。
- 当前 spike 已改为 `ClaudeSDKClient` 结构，sidecar cancel event 会调用官方 `client.interrupt()` 并把结果映射为 `error_code=cancelled`。这只是 adapter 层取消闭环；跨进程精确定位、会话恢复和远程真实 run 仍需下一轮验证。
- 本机尚未安装 `claude_agent_sdk`，所以真实 official SDK run 需要先完成 SDK 依赖、provider key、workspace 权限配置后验证；外部 PATH 上的 `claude` 命令只做诊断观测，官方 Python SDK 包自身携带 CLI 能力，不作为默认 ready gate。
- 新增 `claude-sdk-sidecar/tests/test_official_agent_sdk_adapter.py`，用 fake SDK 验证 `runtime_init/text_delta/usage/done` 和 `cancel -> interrupt -> usage/error(cancelled)` 两条结构路径。
- `/cds-agent` 页面事件刷新已改为 `afterSeq` 增量拉取并按 seq 去重合并；前端也已接入 `/stream?afterSeq=&limit=` 作为 SSE 续读路径，失败时回退 JSON 分页。后端 `/stream` 已改为长连接 SSE + keepalive；Toolbox `cds-agent` 回放也从固定 500 条改为游标批量读取。下一步应做远程真实长会话验证。
- sidecar `/readyz` 现在返回 adapter diagnostics：official SDK 包、外部 CLI 路径观测、workspaceRoot、allowed tools、permission mode、写工具 opt-in、approval bridge。MAP 通过 `/api/infra-agent-sessions/runtime-status` 透出 sidecar pool 诊断，页面可看到 runtime pool healthy/instance 数，避免把 SDK 或 workspace 缺失伪装成模型调用失败。
- Toolbox `cds-agent` 入口已改为异步委托语义：创建 MAP/CDS session、发送任务、入队 runtime job 后立即产出 `CDS Agent 远程运行句柄` artifact，并给出 `/cds-agent?sessionId=...`、event stream、events、logs 路径。Toolbox 运行页会把该 artifact 渲染为远程运行卡片和“打开工作台”操作。Toolbox step 表示“委托已创建”，真实远程 run 状态仍由 MAP session 和 `/cds-agent` 工作台观察。
- `SendMessageAsync` 已从同步等待 runtime run 改为后台 job 模式：HTTP 请求写入用户消息、导入 CDS 事件、追加 `runtime job queued` 日志并入队；`InfraAgentRuntimeWorker` 从 `IInfraAgentRuntimeJobQueue` 消费后调用 runtime adapter，异常会写回 MAP error 事件。
- 官方 adapter 默认只开放 `Read/Grep/Glob` 只读内置工具，`permission_mode=default`。`Bash/Edit/Write` 必须通过 `CLAUDE_AGENT_SDK_ALLOWED_TOOLS` 显式 opt-in，且 `runtime_init` 会记录 `builtinWriteToolsEnabled` 和具体工具名。
- 第一版官方 permission bridge 已接入 `ClaudeAgentOptions.can_use_tool`：只读内置工具直接 allow；`Bash/Edit/Write` 会向 MAP `POST /api/agent-tools/approvals/{runId}/{approvalId}/request` 创建 `tool_call` 审批事件，再复用 `/wait` 等待 MAP approval，最后返回 `PermissionResultAllow` 或 `PermissionResultDeny`。这仍需要真实 UI 审批和远程 official SDK run 验证。
- Runtime request 的 MAP/session/workspace 上下文已开始进入 sidecar 协议：`mapSessionId/traceId/workspaceRoot/gitRepository/gitRef` 可随 run 下发，官方 SDK adapter 会把 request `workspaceRoot` 映射到 `ClaudeAgentOptions.cwd`，并在 `runtime_init` 中回报 workspace 来源和 repo/ref。`/cds-agent` 新建会话已能录入 repo/ref/workspace 并在审计摘要、诊断包和 runtime start 事件中回显；产品级“选择任意仓库/分支后自动准备 workspace”还需要下一轮 CDS clone/checkout 与 GitHub 授权闭环。
- Official SDK adapter 的 workspace 准备不实现 agent loop：当 MAP 未下发 `workspaceRoot` 但下发 `gitRepository/gitRef` 时，sidecar 只负责把 GitHub 仓库 shallow clone/fetch 到 `SIDECAR_WORKSPACES_ROOT`，把 resulting path 传给 `ClaudeAgentOptions.cwd`，再把后续读代码、上下文管理、工具循环交回官方 Claude Agent SDK。当前实现限制为 GitHub `owner/repo`/`https://github.com/owner/repo`，私有仓库 token、非 GitHub host 和 workspace GC 仍需后续补齐。
- Workspace 准备已具备进程内锁和 readyz 诊断：同一 repo/ref 在单个 sidecar 进程内不会并发 clone/fetch；`readyz.adapterDiagnostics.workspacePreparation` 报告 workspace root、git 可用性、支持的仓库格式和锁策略。多副本分布式锁、私有仓库凭据和 workspace GC 仍属于 CDS 控制面后续能力。

依赖校准：

- 临时安装真实 `claude-agent-sdk` 验证到当前解析版本 `0.2.82`，并确认 `ClaudeSDKClient`、`ClaudeAgentOptions`、`tool()`、`create_sdk_mcp_server()` 的签名与 adapter 使用方式匹配。
- `claude-agent-sdk` 依赖链需要 `pydantic>=2.11`，因此 sidecar requirements 已从 `pydantic==2.9.2` 升到 `2.13.4`。
- 为避免 pip 把 `starlette` 解到与 `fastapi==0.115.0` 不兼容的 `1.0.0`，requirements 固定 `starlette==0.38.6` 和 `sse-starlette==3.0.3`。
- Anthropic 官方 profile 模板由 MAP 后端 `GET /api/infra-agent-runtime-profiles/templates` 暴露，前端只按模板 id 套用。模型 id、协议、baseUrl 和资源默认值都应在后端模板里维护，避免 UI、脚本和运行前兼容性校验各自保存一份 provider 事实。
