# plan.cds-agent-official-sdk-migration

| 字段 | 内容 |
| --- | --- |
| 模块 | CDS Agent 官方 SDK adapter 迁移 |
| 日期 | 2026-05-18 |
| 状态 | Active plan |
| 目标 | 保留 MAP/CDS 控制面，把自研 agent loop 压缩为官方 SDK adapter |
| 关联 | `doc/design.cds-agent-official-sdk-adapter.md`, `doc/design.cds-agent-runtime-architecture.md`, `doc/plan.cds-agent-workbench.md`, `doc/guide.cds-agent-runtime-pool-recovery.md`, `doc/guide.cds-agent-code-review-quickstart.md` |

## 1. 北极星

用户上手后只需要选择仓库/分支/任务，系统就能完成代码审查或小改动，并且能清楚看到：

- 当前用的是哪个官方 SDK adapter、哪个模型、哪个 workspace。
- 正在读哪些文件、执行哪些命令、请求哪些审批。
- 失败时失败在 provider、SDK、工具、权限、仓库、测试还是 PR。
- 可以停止、重试、继续、下载日志、复现 run。

## 2. 一个周期内的最小开发计划

本周期只做“可替换运行时骨架 + 调试闭环”，不追求一次性重写所有智能体。

| 项 | 交付 | 验收 |
| --- | --- | --- |
| P1.1 Runtime adapter seam | 新增 `IAgentRuntimeAdapter` 设计对应的后端接口或等价内部抽象 | `cds-agent` 和 workflow `claude-sdk` 能共享一层 runtime contract |
| P1.2 Claude Agent SDK adapter spike | 增加官方 SDK adapter 试验实现，保留 legacy fallback | 本地 smoke 能返回 `runtime.init/text.delta/done/error` |
| P1.3 Event mapper | 官方 SDK stream -> `InfraAgentEvent` / `ToolboxRunEvent` | 事件包含 `traceId/runId/seq/source/sdkRuntime` |
| P1.4 Cancel handle | MAP session 保存底层 run/process id | UI stop 后底层 run 结束，事件有 `cancelled` |
| P1.5 Event cursor | 替换 500 条一次性回放 | 大于 500 条事件不丢，UI 可分页 |
| P1.6 Debug panel | CDS Agent 页面显示 runtime adapter、SDK health、trace id、event cursor、last error | 截图可证明不是静态页面 |
| P1.7 Compatibility smoke | Toolbox `cds-agent`、PRD/缺陷/文学/视觉 agent 各跑最小路径 | 非代码 agent 不被运行时迁移破坏 |
| P1.8 Documentation calibration | 设计、计划、债务、使用指南同步官方/自研边界 | 文档不能把历史 `claude-sdk` 或 legacy sidecar 写成“已完成官方 SDK 迁移” |

## 3. 调试顺序

每个开发周期按这个顺序走，禁止先堆 UI：

1. Runtime health：确认 official SDK 包、provider key、模型、workspaceRoot。
2. Minimal run：只让 agent 输出当前仓库根目录摘要，不允许写文件。
3. Tool run：允许 read/list/search，再允许 safe command。
4. Approval run：触发一个需要确认的危险命令，验证 MAP 审批。
5. Cancel run：启动长任务后停止，验证 SDK run 真取消。
6. Event overflow：制造 600+ 小事件，验证 cursor。
7. Toolbox run：从 AI 百宝箱调用 `cds-agent`。
8. Visual run：打开 `/cds-agent`，截图记录真实 run 状态。
9. Remote run：部署到 CDS preview，重复最小 run 和截图。

辅助诊断入口：

- `scripts/doctor-cds-agent-runtime.sh`：读取 `runtime-status?refreshDiscovery=true`，分层输出 `desiredRuntimeAdapter`、`runtimeTransport`、实例数、healthy 数、`blockers`、`nextActions` 和实例级 `/readyz` 摘要。它用于排障，不会把 `instanceCount=0` 当成脚本自身失败。
- `SMOKE_CDS_AGENT_DOCTOR_REPORT=/path/report.json scripts/doctor-cds-agent-runtime.sh`：输出机器可读诊断包，包含 `diagnosis`、`nextRecommended`、`runtime`、`aliasCheck`、默认 profile、官方模板和 adapter compatibility。one-cycle 会默认保存为 `doctor-report.json`，用于执行面板和耗时复盘。
- `scripts/smoke-cds-agent-runtime-status.sh`：验收门禁，要求 `instanceCount > 0`、`healthyCount > 0` 且至少一个实例证明 `agentAdapter/loopOwner=claude-agent-sdk`。
- `scripts/smoke-cds-agent-profile-preflight.sh`：验收门禁，要求不兼容默认 profile 在 `SendMessage` 前被 `runtime_profile_incompatible` 拦截，且不会写入用户消息或入队 runtime job；当默认 profile 已兼容 Claude/Anthropic 时跳过拦截分支。
- `scripts/smoke-cds-agent-official-sdk-run.sh`：S1 真运行入口。默认只做 official SDK runtime/profile readiness，不消耗 provider token；设置 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` 后才创建临时只读审查会话、启动 runtime、发送 prompt 并等待 assistant 消息；真调用成功后还会断言 `runtime_init.loopOwner=claude-agent-sdk`、`sdkLoopEnabled=true`、workspace repo/ref 和无危险审批，并可用 `SMOKE_CDS_AGENT_S1_REPORT` 输出证据 JSON；profile 不兼容或 readiness-only 跳过时同样输出跳过原因和默认 profile 信息。
- `scripts/smoke-cds-agent-official-sdk-controls.sh`：S2/S3 真控制入口。默认只做 readiness；设置 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` 后才触发危险工具审批、拒绝审批并确认 MAP 审计，再创建长任务会话验证 Stop。
- `scripts/smoke-cds-agent-workbench-visual.sh`：V1 authenticated 视觉入口。它不调用 provider，可使用真实登录 token、用户名密码，或 `AI_ACCESS_KEY + SMOKE_USER` 的 smoke-only 浏览器 API header 注入；脚本用 headless Chrome 打开 `/cds-agent`，等待 `Runtime 调试`、`当前执行结论`、`商业级 readiness ledger` 和 `下一周期最小闭环` 出现，并保存截图。它用于补强 `commercial-readiness` 中仅 HTTP 200 的弱 V1 证据。
- `scripts/smoke-all.sh` 默认包含上述 CDS Agent gate。无 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` 时，S1/S2/S3 脚本只做 readiness 或在默认 profile 不兼容时跳过，不会消耗 provider token；无 `SMOKE_CDS_AGENT_ACCESS_TOKEN`、无登录用户名/密码且无 `AI_ACCESS_KEY` 时，V1 authenticated visual 会记为 skipped，避免无凭据 CI 误失败。

## 4. 首轮调试用例

| 用例 | Prompt | 成功标准 |
| --- | --- | --- |
| S1 repo read | “检查当前仓库结构，只输出 5 个最关键目录，不修改文件。” | 有 text delta、无 tool error、无文件变更 |
| S2 code audit readonly | “审查 CDS Agent runtime 相关代码，指出一个风险，不修改。” | 返回文件路径和风险说明 |
| S3 approval | “尝试运行一个需要审批的命令，但等待我确认。” | UI 出现 approval requested |
| S4 cancel | “循环输出状态 2 分钟。” | Stop 后底层 run 取消，事件状态一致 |
| S5 toolbox | AI 百宝箱 preferredAgents=`["cds-agent"]` | Toolbox event 中出现 CDS session/run artifact |
| S6 compatibility | PRD/defect/literary/visual 各跑一个最小动作 | 无 runtime adapter 改动引起的回归 |

## 4.1 下一周期最小开发/调试计划

当前控制面、sidecar transport、官方 SDK loop ownership、profile 模板和不兼容 preflight 都已有 gate。下一周期不再扩大页面功能，先完成真实 provider run 的最小闭环：

| 顺序 | 工作 | 交付物 | 验收证据 |
| --- | --- | --- | --- |
| N1 | 配置真实 Claude/Anthropic runtime profile | 通过后端模板创建默认 profile，密钥只存 MAP profile | `runtime-status.defaultRuntimeProfile.compatibleWithDesiredRuntimeAdapter=true` |
| N2 | S1 只读远程审查 | 官方 SDK 在 CDS preview 中读取目标 repo/ref 并返回审查结论 | `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 scripts/smoke-cds-agent-official-sdk-run.sh` 通过 |
| N3 | S2 MAP 审批 | 危险工具请求进入 MAP approval，拒绝后回写 SDK tool result | `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 scripts/smoke-cds-agent-official-sdk-controls.sh` 的 S2 通过 |
| N4 | S3 Stop | 长任务 Stop 调到底层 SDK interrupt/cancel | controls 脚本 S3 通过，事件含 stop/cancel 证据 |
| N5 | V1 视觉证据 | `/cds-agent` 展示真实 run 的 session/trace/adapter/workspace/event/error | 远程截图，不接受空态或 mock |
| N6 | 非代码兼容回归 | PRD/defect/literary/visual 不被 sidecar pool/profile gate 阻断；候选官方 SDK 不被误标为默认可路由 | `CdsAgentRuntimeCompatibilityTests` + `InfraAgentRuntimeProfilesControllerTests` + 最小业务 smoke |

如果 N1 没完成，S1/S2/S3 脚本只能作为 readiness 或 preflight 证据，不能算真实代码审查验收。

### 4.2 单周期执行节奏

每个开发周期最多只推进一个硬门禁，按“分析 -> 设计 -> 最小实现 -> 调试 -> 视觉证据 -> 文档校准”收口：

| 环节 | 本周期必须输出 | 停止条件 |
| --- | --- | --- |
| 分析 | 明确当前 blocker 属于 profile、SDK、workspace、approval、cancel、event cursor、UI 还是非代码兼容 | blocker 不明确时不写新功能 |
| 设计 | 写清官方能力与 MAP/CDS 自研边界，说明为什么不能直接复用官方能力时才新增自研代码 | 找不到官方缺口时不扩展 legacy loop |
| 最小实现 | 只改能关闭当前 blocker 的最小代码或脚本 | 需要跨多个子系统时拆成下个周期 |
| 调试 | 本地 smoke 先过；远程 preview 再过；provider 调用必须显式 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` | readiness 失败时不做视觉验收 |
| 视觉证据 | 截图必须显示真实 `sessionId/traceId/adapter/loopOwner/workspace/last event/error` | 空态、mock、静态页面不算 |
| 文档校准 | 更新 quickstart、design、plan 中的当前状态和下一步 | 文档不得写“已完成商业级”直到 S1/S2/S3/V1 全过 |

这个节奏的目的不是拖慢开发，而是避免再次出现“页面变好看了，但真实 official SDK run、审批、停止和 profile 兼容性没有闭环”的问题。

### 4.3 官方 adapter 决策门

新增或切换任何智能体 adapter 前，先回答下面四个问题；回答不清楚时只允许保留 planned 状态，不允许接到默认路径：

| 问题 | Claude Agent SDK | OpenAI Agents SDK | Google ADK | Codex-like |
| --- | --- | --- | --- | --- |
| 是否官方提供 agent loop / stream / tool 调用？ | 是 | 是 | 是 | 待确认本项目可路由契约 |
| 是否天然覆盖代码仓库读写、命令和 Claude Code 工具？ | 是 | 否，需要自建工具/sandbox | 否，需要自建工具/sandbox | 待实现 |
| 是否能直接承接 MAP approval / cancel / event cursor？ | 需要 adapter bridge | 需要 adapter bridge | 需要 adapter bridge | 待设计 |
| 当前是否允许进入 CDS Agent 默认代码审查路径？ | 是，R1 profile 通过后 | 否，先做非代码编排试点 | 否，先做非代码编排试点 | 否，`planned-not-routable` |

非代码智能体如果接 OpenAI Agents SDK 或 Google ADK，必须先证明两个事实：

- 现有 PRD/缺陷/文学/视觉最小业务路径不依赖 CDS sidecar pool。
- 新 SDK 的 trace、handoff、guardrail 不改变现有 artifact schema 和用户可见输出。

## 5. 商业级可用性门槛

| 维度 | 本周期最低门槛 | 最终门槛 |
| --- | --- | --- |
| 可观察性 | UI 显示 run id、trace id、adapter、last event、last error | OpenTelemetry/官方 trace 与 MAP event 双向关联 |
| 可调试性 | 每次失败有结构化错误码和下一步 | 一键导出 run bundle |
| 可用性 | 只读代码审查可跑通 | 审查、修改、测试、PR 全链路稳定 |
| 方便性 | 用户不用理解 sidecar 细节 | 选择仓库/分支/任务即可运行 |
| 稳定性 | cancel、event cursor、fallback 可用 | 多租户隔离、超时、重试、幂等全部覆盖 |

## 6. 非自研收益预估

迁移后可删除或收缩的代码主要在 Python sidecar loop、工具选择、history 管理、usage 汇总、MCP/permission 重复实现。

| 区域 | 当前问题 | 迁移收益 |
| --- | --- | --- |
| `agent_loop.py` | 自己实现多轮循环，容易偏离官方行为 | 大部分替换为 SDK query/run 调用 |
| `tool_bridge.py` | 同时承接工具协议、审批等待、MAP 回调 | 收缩为 MAP permission/MCP bridge |
| sidecar schemas | 自定义事件和工具 schema 膨胀 | 只保留 MAP event envelope |
| approval polling | 易超时、难取消 | 接 SDK permission/human review callback |
| observability | 自己拼日志和 usage | 复用 SDK trace/usage，再映射到 MAP |

保守估计，本周期完成 adapter seam 后不会立刻大量删代码；等 Claude Agent SDK adapter 跑通并覆盖 S1-S5 后，sidecar 运行时相关代码可减少约 30%-50%。如果后续工具全部 MCP 化，长期可减少 50%-70% 的自研运行时代码，并显著降低维护成本。

## 7. 不再踩的坑

- 不把 runtime 历史名当官方 SDK 接入事实。
- 不先做静态好看的页面，再补功能。
- 不把所有智能体都塞进代码 Agent。
- 不让 UI stop 只改数据库状态。
- 不用固定 500 条事件当审计边界。
- 不让 Toolbox worker 同步等待一个长 run。
- 不在文档里写“已完成商业级”直到真实远程 run 通过。

## 8. 当前状态

本节是迁移时间线，包含若干 2026-05-17 的历史诊断。当前 2026-05-18 的权威结论是：
R0 runtime pool、A0 official SDK adapter boundary、V1 authenticated visual、N6 非代码兼容均已有通过证据；
R1/S1/S2/S3 仍未完成，真实 blocker 是默认 runtime profile 仍为
`OpenRouter DeepSeek V4 Pro / openai-compatible / deepseek/deepseek-v4-pro`，不能作为
`claude-agent-sdk` 的默认 Anthropic/Claude-compatible profile。不要再把历史
`instanceCount=0` / `empty_instances` 记录当作当前主阻塞。

截至 2026-05-18：

- UI 工作台已完成第一轮视觉升级，但它不是 runtime 完成的证明；当前 V1 只证明页面可观察性口径存在，不能替代 provider run。
- 默认代码审查路径已从历史 `claude-sdk`/legacy sidecar loop 校准为官方 `claude-agent-sdk` adapter；legacy loop 只允许显式 fallback。
- P1.1 已开始落代码：新增 `IInfraAgentRuntimeAdapter`，把现有 sidecar 包成 `SidecarRuntimeAdapter`，`InfraAgentSessionService` 改为通过 runtime adapter 消费事件。
- P1.4 已有第一步：session 写入 `CurrentRuntimeRunId`，Stop 时会通过 adapter 调 sidecar `/v1/agent/cancel/{runId}` 做 best-effort 取消。
- P1.6 已接入第一版页面调试面板：`/cds-agent` 展示 runtime adapter、run id、runtime instance、事件 source、cancel 状态；事件标题也显示 adapter/source；无 active session 时也显示空态原因。
- P1.6 已补 sidecar pool 诊断入口：sidecar `/readyz` 返回当前 adapter、官方 SDK 包、外部 CLI 路径观测、workspace、allowed tools、permission mode、写工具 opt-in 和 approval bridge；MAP `GET /api/infra-agent-sessions/runtime-status` 透出 pool 诊断，页面 runtime 调试面板显示 healthy/instance 数。
- P1.2 已有第一版官方 Claude Agent SDK adapter spike：sidecar 支持 `runtimeAdapter=claude-agent-sdk` / `SIDECAR_AGENT_ADAPTER=claude-agent-sdk`，MAP 默认按请求透传 `claude-agent-sdk`，仅在显式设置 `INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER=legacy-sidecar` 或 `SIDECAR_AGENT_ADAPTER=legacy-sidecar` 时回退自研 loop；sidecar standalone 未传 `runtimeAdapter` 时也默认走官方 `claude-agent-sdk`。
- P1.3 已补 `runtime_init` 事件映射，官方 adapter 初始化信息会进入 MAP 事件流，供调试面板和审计使用。
- P1.4 官方路径已有第一步取消语义：adapter 使用 `ClaudeSDKClient`，sidecar cancel event 会调用官方 `client.interrupt()`；下一步还要用真实 SDK 包、provider key 和 workspace 证明远程 run 能被停止。
- P1.5 已有第二步事件游标：后端 `ListEventsAsync(afterSeq, limit)` 和 `/stream?afterSeq=&limit=` 已存在，`/stream` 已改为长连接 SSE + keepalive；`/cds-agent` 页面改为 SSE 优先续读、JSON 分页兜底，并按 `seq` 去重合并事件；Toolbox `cds-agent` 回放改为游标批量读取，避免固定 500 条覆盖长任务审计。
- P1.5 已补 workflow/capsule 路径：`CapsuleExecutor` 的 CDS Agent 审批暂停和完成产物不再固定读取前 1000 条事件，改为 500 条分页、最多 20 页的 `afterSeq` 游标读取，并在日志里标记 `complete` 或 `truncated_or_stalled`，避免工作流长任务静默丢失审计上下文。
- P1.5 已补 Toolbox 证据包完整性：`CdsAgentAdapter` 的事件读取会按 seq 去重推进，遇到分页不前进会停止并标记 `truncated_or_stalled`；Toolbox 输出会显示事件数、lastSeq 和 cursor 状态，避免远程委托的证据包看起来完整但实际已截断。
- P1.6 后台运行已有第一步：`SendMessageAsync` 不再等待 sidecar runtime 跑完，而是写入用户消息、导入 CDS 事件、入队 `InfraAgentRuntimeJob`；`InfraAgentRuntimeWorker` 在后台 scope 中执行 adapter run，并把异常写回 MAP 事件。
- P1.7 Toolbox 入口已有第二步异步语义：`CdsAgentAdapter` 在创建并发送远程任务后立即产出 `CDS Agent 远程运行句柄` JSON artifact，包含 `sessionId/traceId/runtimeAdapter/currentRuntimeRunId/workbenchPath/eventStreamPath/logsPath`；Toolbox 运行页已识别该 artifact 并渲染“打开工作台”和“停止”卡片操作，同时会重新附着远程 SSE 事件流、轮询兜底展示最近事件，并对等待中的 MAP 工具审批提供内联允许/拒绝；不再把 Toolbox step 的完成误写成远程 run 已完成。
- P1.7 兼容性边界已有自动化护栏：`CdsAgentRuntimeCompatibilityTests` 同时扫描 Toolbox adapter 源码并反射检查构造函数依赖，锁定 `IInfraAgentRuntimeAdapter` / `IClaudeSidecarRouter` / `InfraAgentRuntimes` 只能出现在 `CdsAgentAdapter`，避免 PRD/缺陷/文学/视觉等非代码智能体被 sidecar runtime pool 或官方 Claude Agent SDK adapter 可用性误阻断。
- P1.7 权限边界已有第二步：官方 adapter 默认仅开放 `Read/Grep/Glob`，`Bash/Edit/Write` 必须显式 opt-in；已接 `ClaudeAgentOptions.can_use_tool`，危险内置工具会创建 MAP approval request 并等待 approval，再返回官方 `PermissionResultAllow/Deny`。
- P1.2 官方/自研 loop 边界已有机器可读标识：sidecar `/readyz.adapterDiagnostics`、官方 adapter `runtime_init.content` 和显式 legacy fallback 的首条 `runtime_init` 都会返回 `loopOwner/sdkLoopEnabled/mapRole/cdsRole`；`loopOwner=claude-agent-sdk` 表示 turn loop 由官方 SDK 承担，`sidecar-legacy-loop` + `fallback=explicit` 表示仍在 legacy fallback，避免只靠 adapter 名称猜边界。
- P1.6 页面已显式展示 loop ownership：`/cds-agent` Runtime 调试面板和复制诊断包 summary 会显示 `Loop owner / SDK loop / MAP role / CDS role`；MAP `runtime-status.instances[]` 已强类型透出 `loopOwner/sdkLoopEnabled/mapRole/cdsRole`，页面只把 `adapterDiagnosticsJson` 作为旧实例 fallback。
- P1.6 页面已补商业级就绪门禁：`/cds-agent` Runtime 调试面板会直接显示官方 loop 边界、runtime pool、模型凭据、审批桥、取消句柄、事件恢复 6 个 gate，并把 gate 结果写入可复制诊断包，避免“是否上手可用”只靠读日志或文档判断。
- P1.2 官方 SDK adapter 的 provider 解析已与 legacy sidecar loop 对齐：`claude-agent-sdk` 路径支持 `profile -> request override -> env default` 三段上游选择，`runtime_init` 只记录 `upstreamSource/baseUrlConfigured/apiKeyConfigured/protocol`，不泄露 provider key；profile 找不到会返回结构化 `upstream_resolve_failed`。
- P1.2/P1.6 官方 SDK adapter 已把 provider key 缺失前置到 adapter 边界：默认 readyz 仍允许 MAP 每次 run 通过 runtime profile/request 下发 key，但真正执行前会检查 `profile/request/env` 的有效 key；缺失时返回结构化 `provider_key_missing + nextActions`，不再把凭据配置问题伪装成 SDK runtime 执行失败。
- P1.6 MAP 后端 runtime error 归因已细化：`provider_key_missing`、`upstream_resolve_failed`、`claude_agent_sdk_not_available`、`workspace_prepare_failed`、`cancelled`、`claude_agent_sdk_result_error` 会被映射成 `recoveryKind/retryable/nextActions`，并写入会话 error 事件顶层；配置类错误不再被标成可直接重试，诊断包能直接告诉用户该修 profile、provider key、sidecar dependency 还是 workspace。
- P1.6 页面已消费后端 runtime error 归因：`/cds-agent` Runtime 调试面板新增 `错误归因` gate 和 `Runtime error` 行，复制诊断包保留最新 runtime error 的 `code/message/recoveryKind/retryable/nextActions/source/runtimeAdapter/runtimeInstance`，避免后端结构化错误仍停留在原始事件 JSON。
- P1.6 事件 schema 已校准 runtime error 契约：`/api/infra-agent-sessions/event-schema` 的 `error` 类型显式声明 `retryable/recoveryKind/nextActions/source/runtimeAdapter/runtimeInstance/content`，页面、Toolbox 和工作流可以把这些字段当作稳定诊断字段，而不是临时 payload。
- P1.6 非页面入口也已消费 runtime error 归因：Toolbox `cds-agent` 和工作流 Capsule 渲染事件时会把 error payload 摘成 `code/recoveryKind/retryable/adapter/instance/source/message/下一步`，不再把恢复建议埋在原始 JSON 里。
- P1.2/P1.6 本地 official adapter smoke 已补 provider key 前置诊断：`claude-sdk-sidecar/smoke.sh` 默认启动 `claude-agent-sdk` adapter，校验 `readyz` 的 `sdkInstalled/loopOwner`，无 `ANTHROPIC_API_KEY` 时发起一次 run 并要求 SSE 中出现 `provider_key_missing`，有 key 时再跑真实 Anthropic 流式调用。这样最小调试入口不再把“没 key”当作跳过，而是验证 MAP/UI 依赖的结构化错误链路。
- P1.6 MAP 传输层命名已从 `legacy-sidecar-adapter` 收敛为 `sidecar-runtime-adapter`：诊断里的 transport 只表示 MAP 到 sidecar 的路由/SSE/cancel 边界，真正的 turn loop 归属必须看 `runtimeAdapter=claude-agent-sdk` 与 `loopOwner=claude-agent-sdk`，避免用户看到 transport 名称就误判仍在自研 loop。
- P1.6 官方 SDK 结果观测性已有第一步：`ResultMessage` 的安全元信息（如 `subtype/session_id/model/stop_reason/total_cost_usd/duration_ms/num_turns`）会进入 sidecar `usage/done.content.sdkResult`，MAP 运行日志会保留该 `content`，方便真实 run 接通后定位 SDK session、失败 subtype、成本和耗时；不采集 prompt/result 正文或密钥。
- P1.6 远程诊断新增实际阻塞定位：`runtime-status` 的 pool diagnostics 会透出 CDS discovery 为 0 的原因；后台 discovery 会把不可解密的历史 infra connection 标记为 revoked，遇到 CDS 返回 `invalid_long_token` 时也会触发探活并收敛为 revoked，避免旧授权每 10 秒重复污染 runtime pool 诊断。
- P1.6 诊断已从“字符串解释”升级为“可操作恢复路径”：`runtime-status` 现在返回 `blockers` 和 `nextActions`，页面 Runtime 调试区直接显示阻塞项与下一步，避免用户只看到 `instanceCount=0` 或 `/readyz 503` 却不知道该更新 CDS 控制面、重新授权，还是修 sidecar 的 `ANTHROPIC_API_KEY` / `claude-agent-sdk` / workspace。
- P1.6 无实例诊断已补默认路径：`runtime-status.diagnostics` 现在返回 `desiredRuntimeAdapter=claude-agent-sdk` 和 `runtimeTransport`，`/cds-agent` 页面在 sidecar pool 为 0 时也能显示 MAP 期望走官方 SDK adapter，而不是让用户误以为系统仍默认 legacy。
- P1.6 已把诊断上移到 runtime adapter 边界：`IInfraAgentRuntimeAdapter` 现在暴露 `Blockers` 和 `NextActions`，`Start/SendMessage` 与 Toolbox `cds-agent` 在 runtime pool 不可用时会返回同一套可操作恢复建议，而不是只给 `instances/healthy` 计数。
- P1.6 sidecar 自检也已可操作并透传到 MAP：`/readyz` 现在返回 `blockers/nextActions`，直接说明缺 `SIDECAR_TOKEN`、`ANTHROPIC_API_KEY`、`claude_agent_sdk` 或 workspaceRoot，并观测外部 `claudeCliPath`；在默认 `runtime-profile-or-env` provider key 模式下提示 provider key 可由 MAP runtime profile/per-request 下发；MAP `runtime-status.instances[].readyzBlockers/readyzNextActions` 会保留这些原生建议，并合并进页面/Toolbox 使用的 pool `blockers/nextActions`。
- P1.6 页面诊断包已补实例级 readyz 摘要：`/cds-agent` Runtime 调试面板显示 `Readyz blocker/Readyz next`，复制的诊断包包含压缩后的 `sidecarInstances[]`（ready/http/adapter/provider key/readyz blockers/actions/error），方便用户提交可排障证据而不暴露 token/key。
- P1.6 已修正 sidecar readiness 的 provider key 语义：sidecar `/readyz` 默认采用 `runtime-profile-or-env`，允许 MAP runtime profile 在每次请求中下发 provider key；只有显式 `SIDECAR_PROVIDER_KEY_MODE=env` 时才把缺少 `ANTHROPIC_API_KEY` 作为 ready blocker，避免官方 SDK runtime pool 因“可按请求下发的 key 不在 sidecar env 中”被误判不健康。
- P1.3/P1.6 runtime request 契约继续收缩为 adapter 边界：MAP 现在会把 `mapSessionId/traceId` 透传到 sidecar；会话级 `workspaceRoot/gitRepository/gitRef` 已进入 API、session view、`/cds-agent` 新建表单和 runtime start status 事件。官方 SDK adapter 会优先使用 request `workspaceRoot` 作为 `ClaudeAgentOptions.cwd`，并在 `runtime_init` 中回报 `workspaceSource/gitRepository/gitRef`，为“审核当前仓库/其他仓库”的 workspace 选择和证据包关联打基础；当前还没有自动 clone/checkout 和 GitHub 授权选择器，因此真实其他仓库审核仍需下一轮 CDS workspace 准备闭环。
- P1.3/P1.6 sidecar workspace 准备已有第一版：official SDK adapter 在没有 request `workspaceRoot` 但有 `gitRepository/gitRef` 时，会在 `SIDECAR_WORKSPACES_ROOT` 下 shallow clone/fetch GitHub 仓库，并把准备好的目录作为 `ClaudeAgentOptions.cwd`；`runtime_init.workspace` 会记录 repo/ref/commit/workspaceRoot。当前只支持 `owner/repo` 或 `https://github.com/owner/repo` 的 GitHub 仓库，不处理私有仓库授权、非 GitHub host 和长期 workspace GC，这些仍是下一轮商业化补强项。
- P1.3/P1.6 私有 GitHub 仓库准备已有最小路径：sidecar 会读取 `SIDECAR_GITHUB_TOKEN`（或回退 `GITHUB_TOKEN`），通过 Git 临时 config env 给 `clone/fetch` 注入 HTTP authorization header；token 不写入 clone URL、remote config、`runtime_init` 或诊断包。仍未完成的是 UI 侧 token 来源选择、GitHub App 安装授权和非 GitHub host。
- P1.6 workspace 准备补强：同一 repo/ref 的 clone/fetch 已加 sidecar 进程内异步锁；`readyz.adapterDiagnostics.workspacePreparation` 会暴露 workspace root、git 是否安装、支持的仓库格式、私有仓库授权是否已配置和锁策略。仍未完成的是跨进程/多副本分布式锁、GitHub App 安装授权选择、workspace GC 和真实远程 run 验证。
- P1.6 workspace 诊断贯通：`privateRepositoryAuthConfigured` 已从 sidecar `/readyz.adapterDiagnostics.workspacePreparation` 进入 MAP `runtime-status.instances[].workspacePreparation`、`/cds-agent` Runtime 调试行和复制诊断包；只暴露布尔值，不泄露 `SIDECAR_GITHUB_TOKEN` / `GITHUB_TOKEN`。
- P1.6 workspace 失败也已结构化：official SDK adapter 保留外层 `workspace_prepare_failed`，同时在事件 content 中返回 `workspaceErrorCode/nextActions/privateRepositoryAuthConfigured`，区分 unsupported repo/ref、GitHub auth/not-found、ref not found 和 workspace target conflict；token 不进入错误 content。
- P1.6 页面已把 workspace 失败从原始事件上提到 Runtime 调试：`/cds-agent` 会从事件流提取最新 `workspaceErrorCode`、第一条 `nextActions`、repo/ref 和私有仓库授权布尔值，显示为 `Workspace error` 行并写入复制诊断包。
- P1.6 MAP 事件映射已保留 runtime error content：`InfraAgentRuntimeEventType.Error` 会把 sidecar 的结构化 `ev.Content` 写入 MAP error event，避免 official SDK adapter 产出的 workspace/provider/SDK 细分错误在进入页面前丢失。
- P1.6 页面诊断解析也已兼容字符串/对象两种 event `content` 形态，避免 runtime error 或 `runtime_init` 的结构化 payload 因序列化层差异无法被 `Workspace error`、loop ownership 或诊断包读取。
- P1.6 S3/S4 smoke 证据包补强：`/cds-agent` Runtime 调试会从事件流提炼 approval request/decision 数量、未被 decision 覆盖的 pending 数量、最新 approvalId/decision，以及 stop request/runtime cancel request/SDK cancelled 事件证据，并写入复制诊断包，减少靠人工翻 timeline 判断审批和取消是否闭环。
- P1.6 S4 取消语义校准：official SDK adapter 只有在 MAP cancel event 已触发时才把 SDK `error_during_execution` 归为 `cancelled`；未取消时的 SDK error subtype 会返回 `claude_agent_sdk_result_error` 并保留安全 `sdkResult` 元数据，避免普通 SDK 执行错误被误报为取消成功。
- P1.6 运行池恢复补了一条显式旁路：当共享 CDS discovery 仍返回空实例时，`runtime-status.nextActions` 会提示配置 `ClaudeSdkExecutor:Enabled=true` 和静态 `ClaudeSdkExecutor:Sidecars[0].BaseUrl/Token` 指向健康的 `claude-agent-sdk` sidecar；runbook 已写明这只是 S1 smoke/恢复路径，不替代共享 CDS runtime pool。
- 2026-05-17 远程 preview 已部署到 `d7449a49`，但真实 official SDK run 仍未通过：此前 `runtime-status` 显示 `isConfigured=false / instanceCount=0 / healthyCount=0`。最新诊断已把 4 条 CDS 返回 `invalid_long_token` 的 active 连接自动标为 revoked，当前只剩 1 条有效连接 `061b88ea`，其 `/api/projects/shared-sidecar-pool-mp4anabh/instances` 返回 `empty_instances`。剩余 blocker 是生产 CDS 本体的 `/api/projects/:id/instances` 尚未暴露源码分支 sidecar 服务，因此 running 的 sidecar pool 暂时不会被 MAP 发现。更新共享 CDS 控制面需要明确批准，不能作为普通 preview 部署自动执行。
- CDS 本体已补路由级回归测试：`cds/tests/routes/remote-hosts-instances.test.ts` 用真实 `CdsPairingService` 签发 long token，经 HTTP 请求 `/api/projects/:id/instances` 证明 shared-service project 的 running branch service 会返回 `baseUrl/tags/host/port` 实例；这比 helper 单测更接近 MAP 的生产调用链。
- CDS `/api/projects/:id/instances` 响应新增 `discovery` 摘要（project kind、deployment/running deployment、branch/running branch/running branch service、preview root），MAP 在 `empty_instances` 时会把摘要拼进 runtime-status blocker；远程 MAP 已部署到 `a46f4b8d`，但生产 CDS 控制面仍未返回该摘要，进一步证明共享 CDS 本体尚未应用实例发现更新。
- 运行池恢复与官方 SDK smoke 已固化为 `doc/guide.cds-agent-runtime-pool-recovery.md`：先验证 CDS 实例发现，再跑只读、审批、取消、Toolbox 委托四个最小 smoke。该 runbook 是下一次真实验收的入口。
- `doc/guide.cds-agent-code-review-quickstart.md` 已补面向使用者的代码审查上手路径：当前仓库/其他仓库如何填、每个阶段发生什么、官方 SDK 与 MAP/CDS 自研边界、失败先看哪里，以及哪些证据还没达到商业级验收。
- 下一步应做真实 official SDK run、真实 MAP 审批、取消和远程 CDS 视觉验证；Toolbox 的远程会话重新附着已先落地，但仍需要真实长 run 和 approval run 证明闭环。

验证记录：

- `dotnet build prd-api/src/PrdAgent.Core/PrdAgent.Core.csproj --no-restore` 通过；仅有既有 nullable/unused warning。
- `dotnet build prd-api/src/PrdAgent.Infrastructure/PrdAgent.Infrastructure.csproj --no-restore` 顺序重跑通过；仅有既有 MailKit NU1902。
- `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-restore --filter FullyQualifiedName~CapsuleExecutorCdsAgentEventCursorTests` 通过，2 个测试；覆盖 workflow/capsule 的 CDS Agent 事件游标跨页读取和无进展防死循环。
- `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-restore --filter FullyQualifiedName~CdsAgentAdapterTests` 通过，10 个测试；覆盖 Toolbox CDS Agent runtime pool gate、事件游标跨页读取、完整性摘要和无进展防死循环。本轮在普通沙箱内因 MSBuild named pipe 权限失败，已在授权沙箱外重跑通过。
- `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-restore --filter FullyQualifiedName~CdsAgentRuntimeCompatibilityTests` 通过，8 个测试；通过源码扫描、构造函数反射和 fake gateway 最小业务路径三重护栏锁定非代码 Toolbox agent 不依赖 CDS sidecar/runtime pool，且 PRD/Defect/Literary/Visual adapter 仍能跑通各自最小动作。
- `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-restore --filter "FullyQualifiedName~InfraAgentSessionsControllerTests|FullyQualifiedName~InfraAgentSessionServiceRuntimeAdapterTests"` 通过，17 个测试；锁定 MAP 默认请求 `claude-agent-sdk`、允许显式 `INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER=legacy-sidecar` 回退，并验证 runtime-status 暴露 `desiredRuntimeAdapter`。
- `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-restore --filter "FullyQualifiedName~CdsAgentRuntimeCompatibilityTests|FullyQualifiedName~CdsAgentAdapterTests"` 通过，15 个测试；覆盖 CDS Agent runtime adapter gate，并锁定非代码 Toolbox agent 不依赖 CDS sidecar/runtime pool。
- `dotnet test prd-api/tests/PrdAgent.Tests/PrdAgent.Tests.csproj --no-restore --filter FullyQualifiedName~DynamicSidecarRegistryTests` 通过，13 个测试；覆盖 MAP/CDS sidecar discovery、empty instances、invalid token 收敛、per-request provider key readiness、sidecar `/readyz.blockers/nextActions` 透传、official SDK adapter 诊断文案和 loop ownership 强类型字段。
- `npm --prefix prd-admin run tsc` 通过；覆盖 `runtime-status.instances[].readyzBlockers/readyzNextActions`、loop ownership 强类型字段和 Runtime 就绪门禁前端类型兼容。
- `python3 -m unittest claude-sdk-sidecar/tests/test_sidecar_readiness.py claude-sdk-sidecar/tests/test_official_agent_sdk_adapter.py` 通过，14 个测试；覆盖 sidecar `/readyz` 默认支持 runtime profile/per-request provider key、可选 env key 强校验、可操作 `blockers/nextActions`，以及官方 SDK adapter 事件/审批/取消、provider override、profile 失败结构和 `ResultMessage` 安全元信息透传。
- `python3 -m py_compile claude-sdk-sidecar/app/main.py claude-sdk-sidecar/app/agent_loop.py claude-sdk-sidecar/app/official_agent_sdk.py claude-sdk-sidecar/app/schemas.py` 通过。本轮增量也重跑了 `python3 -m py_compile claude-sdk-sidecar/app/official_agent_sdk.py claude-sdk-sidecar/app/main.py claude-sdk-sidecar/app/schemas.py`。
- `python3 -m unittest discover -s claude-sdk-sidecar/tests` 通过；该测试使用 fake `claude_agent_sdk`，只验证 adapter 事件映射和 cancel/interrupt 结构，不代表真实 Claude 端到端调用通过。
- `python3 -m unittest discover -s claude-sdk-sidecar/tests` 最新通过 23 个测试；覆盖私有 GitHub token 不进入 clone URL/runtime event/diagnostic，只通过 Git 临时 config env 用于 clone/fetch。
- `bash claude-sdk-sidecar/smoke.sh` 已升级为 official SDK adapter smoke：默认校验 `claude-agent-sdk` 包、`loopOwner=claude-agent-sdk`、无 token 401、无 provider key 时的 `provider_key_missing` SSE error；设置 `ANTHROPIC_API_KEY` 后才继续真实 Anthropic run。
- 2026-05-17 本地重跑 `bash claude-sdk-sidecar/smoke.sh` 通过结构性 official adapter smoke：`/readyz` 返回 `sdkInstalled=true`、`sdkVersion=0.2.82`、`agentAdapter=claude-agent-sdk`、`loopOwner=claude-agent-sdk`、默认只读工具 `Read/Grep/Glob`、`approvalBridge=sdk-can-use-tool`；无 `ANTHROPIC_API_KEY` 时 `/v1/agent/run` 返回结构化 `provider_key_missing` 和 MAP runtime profile 修复建议。该证据仍不等同真实 Anthropic run，设置 provider key 后还需跑 S1/S2/S3。
- 2026-05-17 远程 preview 重跑 `scripts/smoke-cds-agent-runtime-status.sh`：鉴权、`runtime-status`、`desiredRuntimeAdapter=claude-agent-sdk`、`runtimeTransport=sidecar-runtime-adapter` 均通过，但在 `instanceCount=0` 失败。真实 blocker 为 `paired-connections total=12 activeCds=1 usable=1 ... emptyEndpoints=1 endpointsWithInstances=0; paired-empty-endpoints 061b88ea shared-sidecar-pool-mp4anabh empty_instances; configured-cds disabled`，下一步仍是更新共享 CDS 控制面的 `/api/projects/{id}/instances` 或配置静态 official SDK sidecar 旁路。
- 2026-05-17 新增并验证 `scripts/doctor-cds-agent-runtime.sh`：远程 preview 输出 `desiredRuntimeAdapter=claude-agent-sdk runtimeTransport=sidecar-runtime-adapter instanceCount=0 healthyCount=0`，诊断结论为 `MAP/CDS 控制面未发现可路由 sidecar 实例`；该脚本用于日常排障，`scripts/smoke-cds-agent-runtime-status.sh` 继续作为必须发现 official SDK sidecar 的硬验收门禁。
- 2026-05-17 `cds-compose.yml` 已补 preview 内置 `claude-sidecar` 服务和 api 静态 `CLAUDE_SIDECAR_BASE_URL=http://claude-sidecar:7400` 旁路。这样当前项目 preview 可在共享 CDS discovery 为空时直接发现本分支 official SDK sidecar；sidecar 默认 `SIDECAR_AGENT_ADAPTER=claude-agent-sdk`、`SIDECAR_PROVIDER_KEY_MODE=runtime-profile-or-env`，provider key 仍由 MAP runtime profile/request 下发。`python3 .claude/skills/cds/cli/cdscli.py verify .` 通过，`npm --prefix cds test -- compose-parser` 通过 33 个测试。已向 CDS 提交 pending import `007a3bce52ba`，摘要显示 `addedProfiles=["api","admin","claude-sidecar"]`，当前状态 `pending`，批准 URL：`https://cds.miduo.org/project-list?pendingImport=007a3bce52ba`；批准并应用后才能 redeploy 验证 `instanceCount > 0`。
- 2026-05-17 pending import `007a3bce52ba` 已通过 API 批准并应用，远程 redeploy 后 `claude-sidecar-prd-agent`、`api-prd-agent`、`admin-prd-agent` 均为 running；`scripts/doctor-cds-agent-runtime.sh` 显示 `instanceCount=1 healthyCount=0`，说明静态 sidecar discovery 已生效，但 api 使用 `http://claude-sidecar:7400` 访问失败：`Resource temporarily unavailable (claude-sidecar:7400)`。已将静态 URL 校准为 CDS scoped profile alias `http://claude-sidecar-prd-agent:7400`，需要再次 import/redeploy 验证 `/readyz`。
- 2026-05-17 pending import `836eb163eb8d` 已批准并应用，远程 redeploy 后 `scripts/doctor-cds-agent-runtime.sh` 和 `scripts/smoke-cds-agent-runtime-status.sh` 均通过：`instanceCount=1 healthyCount=1`，实例 `env-sidecar` 返回 `agentAdapter=claude-agent-sdk loopOwner=claude-agent-sdk sdkLoopEnabled=true`。这证明 MAP/CDS 控制面 + sidecar transport + official SDK loop ownership 已在 preview 打通。
- 2026-05-17 远程 one-cycle 复跑发现 `claude-sidecar-prd-agent` DNS 返回两个 A 记录，其中一个旧实例仍返回旧版 `/readyz` 503。sidecar 当前容器本机 `/readyz` 为 `ready=true`、`providerKeyRequiredForReady=false`；API 容器通过 scoped alias 命中旧实例时 R0 偶发失败。为稳定 preview 验收，`cds-compose.yml` 将内置 sidecar profile 临时改名为 `claude-agent-sidecar`，API 静态 URL 改为 `http://claude-agent-sidecar-prd-agent:7400`，避免复用污染的旧 alias。长期仍应由 CDS 清理 stale service alias。
- 2026-05-18 远程 one-cycle 再次发现 `claude-agent-sidecar-prd-agent` alias 也残留旧实例：API 容器连续 curl 同一 hostname 时会交替命中旧 `/readyz` 503 和新 `/readyz` 200。为避免 Docker/CDS 旧 alias 污染继续影响验收，preview 内置 sidecar profile 再次改名为 `claude-agent-sdk-runtime`，API 静态 URL 改为 `http://claude-agent-sdk-runtime-prd-agent:7400`。这是预览环境稳定性补丁；长期修复仍应在 CDS 控制面清理 stale service alias / stale DNS endpoint。
- 2026-05-18 新增 `scripts/smoke-cds-agent-sidecar-alias-stability.sh`：通过 `cdscli branch exec` 从远程 API 容器内连续访问 `claude-agent-sdk-runtime-prd-agent:7400/readyz`，逐次断言 `ready=true`、`agentAdapter=claude-agent-sdk`、`loopOwner=claude-agent-sdk`。该脚本专门防止 R0 只在 MAP 外部通过、但容器内 DNS alias 仍交替命中新旧 sidecar 的回归。
- 2026-05-18 后续远程部署确认 `claude-agent-sdk-runtime-prd-agent` alias 也出现隐藏 stale endpoint：`getent hosts` 同时返回 `172.20.0.8` 和旧版 `172.20.0.17`，后者 `/readyz` 仍是 legacy minimal 响应。短期把 preview sidecar service alias 迁到 `claude-agent-sdk-runtime-v2-prd-agent`，API 与 alias smoke 同步使用新 alias；长期仍需要 CDS 控制面提供 orphan Docker endpoint 清理能力，避免靠改名绕开残留。
- 2026-05-18 `smoke-cds-agent-sidecar-alias-stability.sh` 已接入 `smoke-cds-agent-one-cycle.sh` 和 `smoke-all.sh`：远程环境设置 `CDS_HOST` 时作为 R0 后置稳定性 gate 运行；本地或无 CDS_HOST 环境会显式 skipped，避免普通本地 smoke 因无法 exec 远程 API 容器而误失败。
- 2026-05-18 `scripts/doctor-cds-agent-runtime.sh` 已支持 `SMOKE_CDS_AGENT_DOCTOR_REPORT` 机器可读诊断包；远程验证显示 `diagnosis=runtime pool 已具备 official SDK adapter 最小运行前置条件`、`aliasCheck.status=stable`、`uniqueHosts=1`、`readySamples=3/3`、`officialLoopSamples=3/3`，同时默认 profile 仍是 `OpenRouter DeepSeek V4 Pro / openai-compatible / deepseek/deepseek-v4-pro` 且 `compatibleWithDesiredRuntimeAdapter=false`。
- 2026-05-18 `scripts/smoke-cds-agent-one-cycle.sh` 已把 doctor 作为第一步，并在 `cycle-summary.json` 中写入 doctor 结论、下一步建议、报告路径、逐步耗时和最慢步骤；同时新增 `commercialGates`，把脚本退出码和真实商业 gate 分开。`A0` gate 固化官方 SDK adapter 边界，防止默认路径回退到自研 loop。当前预期状态仍是 `blocked_r1`，`commercialGates.A0=pass`、`commercialGates.S1/S2S3=pending`，下一条有效动作是用 Anthropic 官方模板创建并验证默认 runtime profile。
- 2026-05-18 `scripts/smoke-lib.sh` 与 `scripts/smoke-cds-agent-one-cycle.sh` 已补远程 preview host 推断：设置 `CDS_HOST=https://cds.miduo.org` 且不显式设置 `SMOKE_TEST_HOST` 时，脚本会优先通过 `cdscli branch status` 读取 `previewSlug`，取不到时按 branch id 确定性推导 preview slug，避免本地网络瞬断时误打 `localhost:5000`。最新 one-cycle 证据目录为 `/tmp/cds-agent-cycle-20260518124425`，总耗时 90s，最慢步骤为 V1 authenticated workbench visual 29s、N6 non-code compatibility 18s、R0 sidecar alias stability 13s；结果 `status=blocked_r1`、`commercialComplete=false`、failed=0、skipped=0，商业 gate 为 `R0=pass`、`A0=pass`、`V1=pass`、`N6=pass`、`R1/S1/S2S3=pending`。这证明当前不需要继续重复部署来修 runtime pool 或页面可观察性，下一步只应修默认 Anthropic/Claude-compatible profile 并跑真实 provider smokes。
- 2026-05-18 A0 边界证据已从纯静态 grep 升级为静态检查 + sidecar 路由单测 + adapter / helper / bridge-total 行数预算：`scripts/smoke-cds-agent-official-sdk-boundary.sh` 会运行 `claude-sdk-sidecar/tests/test_sidecar_readiness.py`，并在 JSON 报告中写入 `executableEvidence.routingTestStatus=pass`、`officialLoopOwnerEvidence.officialAdapterWithinBudget=true`、`bridgeSupportWithinBudget=true` 和 `bridgeTotalWithinBudget=true`。workspace/git 准备逻辑已从 `official_agent_sdk.py` 抽到 `workspace.py`，SDK block/event 映射已抽到 `sdk_events.py`，provider/profile/env 三段上游解析已抽到 `upstream.py`，MAP tool MCP server 和 permission callback 已抽到 `sdk_tooling.py`，官方 SDK adapter 从 673 行降到 261 行，默认预算收紧到 adapter 320 行、support helpers 650 行、bridge total 850 行。A0 报告同时扫描 `official_agent_sdk.py`、`sdk_tooling.py`、`upstream.py`、`sdk_events.py`、`workspace.py`，禁止这些 helper 重新引入 raw Anthropic client、OpenAI-compatible chat loop 或 legacy `run_agent`。这证明 `_adapter_for` 默认路由到 `claude-agent-sdk`，`legacy-sidecar` 只能显式 fallback，且官方 SDK adapter 继续保持薄接入层，不能继续膨胀成第二套自研 loop。
- 2026-05-18 A0 helper 级护栏已补齐：新增 `claude-sdk-sidecar/tests/test_official_sdk_helpers.py`，直接覆盖 `sdk_events.py`、`upstream.py`、`sdk_tooling.py`、`workspace.py` 四个官方 SDK bridge helper 的关键边界，包括 SDK dict/object block 归一化、ResultMessage 标量元信息过滤、provider key 缺失结构化 nextActions、MAP MCP tool handler 闭包、写工具审批桥接、GitHub URL/ref 归一化和 token 只走 Git extraheader。该测试发现并修复了两个真实问题：dict 形态 `tool_result` 未映射、`https://github.com/owner/repo.git` 会被错误归一化成 `repo.git.git`。最新本地证据：`python3 -m unittest discover -s claude-sdk-sidecar/tests` 通过 41 个测试；`SMOKE_CDS_AGENT_BOUNDARY_REPORT=/tmp/cds-agent-boundary-helper-tests.json bash scripts/smoke-cds-agent-official-sdk-boundary.sh` 通过，adapter `261/320`、support helpers `506/650`、bridge total `767/850`、legacy loop `425`。
- 2026-05-18 `/cds-agent` 远程专业模式已验证最新 ledger 口径：在 R1 阻塞时页面显示 `4/8 passed`，`R0/A0/T1/V1=PASS`，`R1/S1/S2/S3=WAIT/pending`。页面 provider gate 派生逻辑已收紧为 `defaultProfileReady && officialLoopReady` 后才允许当前页面事件作为 S1/S2/S3 证据；旧会话的 assistant、approval、cancel 事件会被解释为“旧会话事件不能证明当前 provider gate”，不能再把 S2/S3 顶成 PASS。
- 2026-05-18 `diagnostics.executionPanel.deploymentAdvice` 已下沉到 MAP runtime-status 并显示在 `/cds-agent` 当前执行结论中：R1/profile-blocked 不靠 redeploy 解决，S1/S2/S3 pending 不靠 redeploy 解决，只有代码变更、远程容器网络/鉴权、视觉证据或 promotion 才需要新的 deploy/build。`scripts/smoke-cds-agent-one-cycle.sh` 同步输出 phase、step index、slowest steps 和 deploy/build advice，用于解释时间花在本地、远程 API、容器 exec、provider 调用还是视觉截图。
- 2026-05-18 R1 最新阻塞原因已精确到 profile 且结构化：远程默认 profile 为 `OpenRouter DeepSeek V4 Pro`，`runtime=claude-sdk`、`protocol=openai-compatible`、`model=deepseek/deepseek-v4-pro`、`hasApiKey=true`，但 `compatibleWithDesiredRuntimeAdapter=false`，`compatibilityReasonCode=openai-compatible-non-claude-model`。官方目标模板为 `anthropic-official-claude-sonnet-4`，`protocol=anthropic`、`baseUrl=https://api.anthropic.com`、`model=claude-sonnet-4-20250514`。有效下一步命令是 `CDS_HOST=https://cds.miduo.org SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=<sk-ant-...> SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-one-cycle.sh`；没有 provider key 时继续跑 S1/S2/S3 只会得到 readiness/pending，不应宣称商业完成。
- 2026-05-18 `fe51afb0` 已把 profile 兼容性判断从 bool/warning 升级为 `InfraAgentRuntimeProfileCompatibilityDecision`，统一输出 `compatible`、`reasonCode`、`reason` 和 `nextActions`。`runtime-status.defaultRuntimeProfile`、`runtimeProfileRepairPlan.currentProfile`、doctor、readiness smoke 和 `/cds-agent` Profile reason 均消费同一事实源，避免前端、脚本、文档各自猜测 OpenRouter/DeepSeek 为什么不能走官方 Claude Agent SDK。
- 2026-05-18 `CDS_HOST=https://cds.miduo.org python3 .claude/skills/cds/cli/cdscli.py self update --branch codex/cds-agent-workbench-ui` 已把远程控制面对齐到 `fe51afb0`。本次必要 self update 的主要耗时为 `tsc_cds=95947ms`，后端 build 3s，预重启总耗时 108s；依赖安装和 web build 均跳过。后续如果只是 R1/provider 阻塞，不应重复 self update。
- 2026-05-18 最新远程 one-cycle 证据 `/tmp/cds-agent-cycle-20260518091314`：11/11 script steps passed，`status=blocked_r1`，`commercialComplete=false`，`R0/A0/V1/N6=pass`，`R1/S1/S2S3=pending`，总耗时 106s。最慢步骤为 V1 visual 33s、N6 17s、R0 sidecar alias 13s。目标审计 `/tmp/cds-agent-goal-audit-fe51afb-current.json` 显示 `cycle git match=match`，仍只阻塞在 R1/S1/S2/S3。
- 2026-05-18 CDS 控制面已补 stale app alias 清理逻辑，用于后续从根上减少 preview 旧 endpoint 残留；当前远程 preview 的直接稳定证据仍以 `claude-agent-sdk-runtime-v2-prd-agent` alias 和 alias smoke/doctor alias check 为准。
- 2026-05-17 S1 只读 run 已进入真实 official SDK adapter 路径：session `89698f778f944c1696a2b0f8913645f4` 事件包含 `sidecar_runtime_started`、`runtimeAdapter=claude-agent-sdk`、`runtimeTransport=sidecar-runtime-adapter`、`runtimeRunId=infra-agent-89698f778f944c1696a2b0f8913645f4-edb9dd8d321d458a9e170f979b4e69b4`、workspace clone 到 `/tmp/claude-sidecar-workspaces/...`、`loopOwner=claude-agent-sdk`、`workspacePrepared=true`、`apiKeyConfigured=true`。但该 run 没完成代码审查，官方 SDK 返回 `There's an issue with the selected model (deepseek/deepseek-v4-pro). It may not exist or you may not have access to it. Run --model to pick a different model.`，说明下一 blocker 是 runtime profile 模型与 Claude Agent SDK 的兼容性，而不是 sidecar pool。
- `scripts/doctor-cds-agent-runtime.sh` 已增加默认 runtime profile 结构化兼容性提示：当 `desiredRuntimeAdapter=claude-agent-sdk` 但默认模型不含 `claude`/`anthropic` 时，doctor 会打印 `Profile compatibility reason: code=openai-compatible-non-claude-model` 和后端返回的原因文本。远程重跑通过，并正确提示当前默认 profile `OpenRouter DeepSeek V4 Pro / deepseek/deepseek-v4-pro` 与 official Claude Agent SDK 路径不兼容。
- MAP `runtime-status` 已上移默认 runtime profile 兼容性诊断：响应新增 `diagnostics.defaultRuntimeProfile`，包含默认 profile 的 runtime/protocol/model/hasApiKey、`compatibleWithDesiredRuntimeAdapter`、`warning`、`compatibilityReasonCode`、`compatibilityReason` 和 `compatibilityNextActions`；当 `claude-agent-sdk` 搭配非 Claude/Anthropic 形态默认模型时，`nextActions` 会提示选择 Claude/Anthropic 兼容 profile 或改走普通 OpenAI-compatible gateway。`/cds-agent` 页面 Runtime 调试面板已显示 `Default profile`、`Profile warning` 与 `Profile reason`。
- `/cds-agent` 页面 runtime pool gate 已校准为以当前可路由 healthy 实例为准：当 `instanceCount > 0 && healthyCount > 0` 时不再把旧 CDS discovery metrics 的 shared pool empty 当作阻塞提示。远程 preview 部署到 `1fb8158b4` 后，`scripts/doctor-cds-agent-runtime.sh` 和 `scripts/smoke-cds-agent-runtime-status.sh` 均通过；登录态截图 `/tmp/cds-agent-authenticated-after-pool-fix.png` 证明 stale `shared sidecar pool 当前没有 running branch service` 提示已消失，同时仍保留 `Official SDK adapter` 与当前 `deepseek/deepseek-v4-pro` 模型失败证据。
- official SDK 路径的 runtime profile 兼容性已从“运行后报错”前移为“运行前拦截”：前端 `/cds-agent` 会在新建/启动/发送前阻止 `claude-agent-sdk + 非 Claude/Anthropic profile`，后端 `InfraAgentSessionService` 在 `Start/Send/runtime job` 三处复用同一兼容性判断并返回 `runtime_profile_incompatible`，避免继续创建 MAP 消息、排队 runtime job 后才让官方 SDK 抛模型错误。
- `/cds-agent` 模型配置区已补 Anthropic 官方模板入口：当默认 OpenAI-compatible profile 被拦截时，用户可以一键预填 `protocol=anthropic`、`baseUrl=https://api.anthropic.com`、Claude Sonnet 系列模型、资源策略和默认勾选项，然后只补 API key 保存；该入口不绕过兼容性校验，也不把 key 写入前端持久状态。
- runtime profile 模板事实源已从页面常量下沉到 MAP API：`GET /api/infra-agent-runtime-profiles/templates` 返回官方 Anthropic Claude Agent SDK 推荐模板，`/cds-agent` 加载后端模板再套用。后续如果要支持 Codex、OpenAI-compatible gateway fallback 或其他智能体 profile 模板，应扩展该 API，而不是继续在前端硬编码模型、协议和 baseUrl。
- 官方模板创建入口已从“前端提交完整 profile 字段”收敛为“后端按模板创建”：`POST /api/infra-agent-runtime-profiles/templates/{templateId}/profiles` 只接受可选名称、API key 和是否默认，runtime/protocol/baseUrl/model/resource 默认值全部由后端模板决定；缺 API key 会返回 `api_key_required`，避免保存半成品 profile。
- adapter 兼容边界已机器可读：`GET /api/infra-agent-runtime-profiles/adapter-compatibility` 声明 `claude-agent-sdk` 为默认支持路径、`legacy-sidecar` 为显式 fallback、`codex` 为 planned-not-routable，并把普通 `deepseek/*` 这类 OpenAI-compatible profile 标成不适合官方 Claude SDK。`/cds-agent` Runtime 调试区会展示该矩阵，`smoke-cds-agent-profile-templates.sh` 会校验它，防止后续接其他智能体时把“可保存 profile”误解成“已有可路由官方 adapter”。
- R1 默认 profile 修复路径已下沉到 MAP runtime-status：`diagnostics.runtimeProfileRepairPlan` 返回当前 profile、目标 Anthropic 官方模板和下一步动作；`/cds-agent` 页面只展示该计划并调用后端模板套用入口，readiness smoke 也断言该字段，避免 UI、文档和后端各自维护一套 R1 判断。新增 `POST /api/infra-agent-runtime-profiles/templates/{templateId}/default-profile` 作为后端 test-before-promote 事实入口：它先用官方模板创建非默认 Anthropic 候选 profile，调用 profile `/test` 验证上游可用后再提升为默认，测试失败会删除候选 profile。`scripts/smoke-cds-agent-r1-profile-repair.sh` 和 `/cds-agent` 页面保存/更新默认 profile 均调用该入口，避免坏 key 覆盖当前默认配置，并在有 key 时复查 `commercialReadiness.R1=pass`。
- 下一周期 N1-N6 最小闭环也已下沉到 MAP runtime-status：`diagnostics.nextCyclePlan` 返回周期名、整体状态、每项交付/证据/阻塞项和停止条件；`/cds-agent` Runtime 调试区、复制诊断包和 commercial readiness smoke 均消费它，避免计划只存在文档中而页面无法指导用户继续调试。
- 当前执行结论也已下沉到 MAP runtime-status：`diagnostics.executionPanel` 返回 `status`、`commercialComplete`、`currentBlockingGate`、`blockingReason`、`nextCommand` 和 gate 计数；页面“当前执行结论”优先消费这个字段。命令选择按阻塞门收敛：R0 先 doctor，R1 再 profile repair，S1/S2/S3 才进入 provider cycle，避免跳过真实阻塞去反复部署或跑错 smoke。
- N6 非代码兼容已补独立 smoke：`scripts/smoke-cds-agent-non-code-compatibility.sh` 运行 `CdsAgentRuntimeCompatibilityTests` 和 `InfraAgentRuntimeProfilesControllerTests`，覆盖源码扫描、构造函数反射、fake gateway 最小业务路径，以及 `codex`/`openai-agents-sdk`/`google-adk` 候选官方 SDK 的 `planned-not-routable` 兼容矩阵，证明 PRD/Defect/Literary/Visual 等非代码 Toolbox agent 不依赖 `IInfraAgentRuntimeAdapter`、`IClaudeSidecarRouter`、`InfraAgentRuntimes` 或 `ClaudeSidecar`，且其他官方 SDK 候选不会被误路由到代码审查默认路径。`scripts/smoke-all.sh` 已将它纳入默认套件，避免 CDS Agent 迁移时误伤其他智能体。
- `scripts/smoke-cds-agent-profile-preflight.sh` 已固化运行前拦截验收：远程不兼容默认 profile 会创建临时 idle session，调用 SendMessage 得到 400 / `runtime_profile_incompatible`，消息列表保持 0 条，然后归档临时 session。该 smoke 防止以后回归成“先写用户消息/入队 runtime job，再让官方 SDK 报模型错误”。
- `scripts/smoke-cds-agent-official-sdk-run.sh` 已固化 S1 真运行验收入口：无 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` 时只做 readiness；默认 profile 不兼容时默认跳过、`SMOKE_CDS_AGENT_REQUIRE_COMPATIBLE=1` 时失败。配置真实 Claude/Anthropic profile 后，该脚本就是远程 S1 只读审查的第一条硬证据入口。
- `scripts/smoke-cds-agent-official-sdk-controls.sh` 已固化 S2/S3 验收入口：有 provider key 后先等官方 SDK 产生 MAP approval request，再通过 MAP 拒绝并确认 `tool_result.source=map-tool-approval`；随后跑长任务并调用 Stop。该脚本默认不发 prompt，避免无 key 环境误消耗 provider token。
- `claude-sdk-sidecar/tests/test_sidecar_readiness.py` 覆盖 `/readyz` 背后的 adapter diagnostics：legacy 默认 ready、official 缺 SDK 包时报告 missing、外部 `claude` PATH 命令缺失不阻塞、写工具 opt-in 时报告 `builtinWriteToolsEnabled`。
- `PYTHONPATH=/tmp/codex-sidecar-req-check-2:claude-sdk-sidecar python3 ...` 真实 SDK shape check 通过，`runtime_init` 显示 `approvalBridge=sdk-can-use-tool`、默认 tools 为 `Read/Grep/Glob`、`permissionMode=default`。
- 临时安装真实 `claude-agent-sdk` 到 `/tmp/codex-claude-agent-sdk` 后，API 形状验证通过：`ClaudeSDKClient`、`ClaudeAgentOptions`、`tool()`、`create_sdk_mcp_server()` 可导入且签名匹配当前 adapter 用法。
- `python3 -m pip install --target /tmp/codex-sidecar-req-check-2 -r claude-sdk-sidecar/requirements.txt` 通过；验证组合为 `fastapi 0.115.0`、`starlette 0.38.6`、`pydantic 2.13.4`、`claude_agent_sdk 0.2.82`。
- 真实 run smoke 仍未执行：还需要 provider key、真实 workspace 和远程 CDS sidecar 环境；外部 PATH 上的 `claude` 命令只做诊断观测，官方 Python SDK 包自身携带 CLI 能力，不作为默认 ready gate。
- `npm --prefix prd-admin run tsc` 通过。
- `/cds-agent` 的会话详情刷新已改为稳定 `useCallback`，SSE 兜底轮询和切换会话的 hook 依赖已收敛；`npm exec eslint src/pages/cds-agent/CdsAgentPage.tsx` 在 `prd-admin` 目录通过，消除了该页面既有 hook dependency warning。
- 远程 preview `prd-agent-codex-cds-agent-workbench-ui` 已部署到 `048cfab9 fix: revoke invalid cds sidecar tokens`，API/Admin 服务均为 `running`；远程 `GET /api/infra-agent-sessions/runtime-status` 成功返回诊断，active CDS 连接已从 5 条收敛到 1 条，sidecar pool 仍为 0 实例且原因是有效连接返回 `empty_instances`。
- `CdsAgentAdapter` 异步句柄改造后，`dotnet build prd-api/src/PrdAgent.Api/PrdAgent.Api.csproj --no-restore --no-dependencies` 通过；`/cds-agent?sessionId=...` 前端直达选中会话的类型检查通过。
- `ToolRunner` 已保存 `step_artifact` 事件中的 artifact，并识别 `kind=cds-agent-run-handle` 渲染 CDS Agent 远程运行卡片；卡片可调用 `stopInfraAgentSession` 请求停止 MAP/CDS session；`npm --prefix prd-admin run tsc` 通过。
- `dotnet build prd-api/src/PrdAgent.Core/PrdAgent.Core.csproj --no-restore` 通过。
- `npm --prefix cds test -- remote-hosts-helpers remote-hosts-instances` 通过，14 个测试；其中 `remote-hosts-instances` 需要监听 `127.0.0.1` 临时端口，本地验证按沙箱外执行。
- `npm --prefix cds run build` 通过。
- `dotnet test prd-api/tests/PrdAgent.Tests/PrdAgent.Tests.csproj --no-restore --filter FullyQualifiedName~DynamicSidecarRegistryTests` 通过，12 个测试；覆盖 MAP 解析 CDS `discovery(...)` 摘要并透出到 `paired-empty-endpoints`。
- `dotnet build prd-api/src/PrdAgent.Infrastructure/PrdAgent.Infrastructure.csproj --no-restore` 通过，仅有既有 MailKit NU1902。
- 本地视觉冒烟通过：Vite `http://127.0.0.1:8011/cds-agent`，截图 `/tmp/cds-agent-runtime-debug-auth.png` 显示 `Runtime 调试` 面板和 `Adapter/Mode/Run ID/Instance/Source/Cancel` 字段。该截图使用本地临时登录态，后端 API 未启动，因此只验证页面渲染和空态，不证明真实远程 run。
- `git diff --check` 通过。
- API 项目构建阻塞定位：`dotnet msbuild prd-api/src/PrdAgent.Api/PrdAgent.Api.csproj /pp:/tmp/prd-api-preprocessed.xml /p:BuildProjectReferences=false` 可完成，说明项目文件展开正常；`/t:Restore` 卡在 `Determining projects to restore...`，`/t:ResolveReferences` 也卡住，问题集中在 NuGet/project reference resolution 阶段。
- `dotnet build prd-api/src/PrdAgent.Api/PrdAgent.Api.csproj --no-restore`、`--no-dependencies` 和 `dotnet msbuild ... /t:CoreCompile` 在本机仍只有 MSBuild banner、无项目输出，已停止；Api DI 注册、`InfraAgentRuntimeWorker`、`AgentToolsController` permission endpoint 和 `CdsAgentAdapter` API 层编译仍需排查构建卡住原因后复验。
