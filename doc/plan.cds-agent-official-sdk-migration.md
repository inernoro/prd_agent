# plan.cds-agent-official-sdk-migration

| 字段 | 内容 |
| --- | --- |
| 模块 | CDS Agent 官方 SDK adapter 迁移 |
| 日期 | 2026-05-17 |
| 状态 | Active plan |
| 目标 | 保留 MAP/CDS 控制面，把自研 agent loop 压缩为官方 SDK adapter |
| 关联 | `doc/design.cds-agent-official-sdk-adapter.md`, `doc/design.cds-agent-runtime-architecture.md`, `doc/plan.cds-agent-workbench.md`, `doc/guide.cds-agent-runtime-pool-recovery.md` |

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

## 4. 首轮调试用例

| 用例 | Prompt | 成功标准 |
| --- | --- | --- |
| S1 repo read | “检查当前仓库结构，只输出 5 个最关键目录，不修改文件。” | 有 text delta、无 tool error、无文件变更 |
| S2 code audit readonly | “审查 CDS Agent runtime 相关代码，指出一个风险，不修改。” | 返回文件路径和风险说明 |
| S3 approval | “尝试运行一个需要审批的命令，但等待我确认。” | UI 出现 approval requested |
| S4 cancel | “循环输出状态 2 分钟。” | Stop 后底层 run 取消，事件状态一致 |
| S5 toolbox | AI 百宝箱 preferredAgents=`["cds-agent"]` | Toolbox event 中出现 CDS session/run artifact |
| S6 compatibility | PRD/defect/literary/visual 各跑一个最小动作 | 无 runtime adapter 改动引起的回归 |

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

截至 2026-05-17：

- UI 工作台已完成第一轮视觉升级，但它不是 runtime 完成的证明。
- 当前 `claude-sdk` runtime 是官方 `anthropic` Python SDK + 自研 sidecar loop，不是完整官方 Claude Agent SDK adapter。
- P1.1 已开始落代码：新增 `IInfraAgentRuntimeAdapter`，把现有 sidecar 包成 `LegacySidecarRuntimeAdapter`，`InfraAgentSessionService` 改为通过 runtime adapter 消费事件。
- P1.4 已有第一步：session 写入 `CurrentRuntimeRunId`，Stop 时会通过 adapter 调 sidecar `/v1/agent/cancel/{runId}` 做 best-effort 取消。
- P1.6 已接入第一版页面调试面板：`/cds-agent` 展示 runtime adapter、run id、runtime instance、事件 source、cancel 状态；事件标题也显示 adapter/source；无 active session 时也显示空态原因。
- P1.6 已补 sidecar pool 诊断入口：sidecar `/readyz` 返回当前 adapter、官方 SDK 包、外部 CLI 路径观测、workspace、allowed tools、permission mode、写工具 opt-in 和 approval bridge；MAP `GET /api/infra-agent-sessions/runtime-status` 透出 pool 诊断，页面 runtime 调试面板显示 healthy/instance 数。
- P1.2 已有第一版官方 Claude Agent SDK adapter spike：sidecar 支持 `runtimeAdapter=claude-agent-sdk` / `SIDECAR_AGENT_ADAPTER=claude-agent-sdk`，MAP 默认按请求透传 `claude-agent-sdk`，仅在显式设置 `INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER=legacy-sidecar` 时回退自研 loop；sidecar standalone 未传 `runtimeAdapter` 时仍保留 legacy fallback。
- P1.3 已补 `runtime_init` 事件映射，官方 adapter 初始化信息会进入 MAP 事件流，供调试面板和审计使用。
- P1.4 官方路径已有第一步取消语义：adapter 使用 `ClaudeSDKClient`，sidecar cancel event 会调用官方 `client.interrupt()`；下一步还要用真实 SDK 包、provider key 和 workspace 证明远程 run 能被停止。
- P1.5 已有第二步事件游标：后端 `ListEventsAsync(afterSeq, limit)` 和 `/stream?afterSeq=&limit=` 已存在，`/stream` 已改为长连接 SSE + keepalive；`/cds-agent` 页面改为 SSE 优先续读、JSON 分页兜底，并按 `seq` 去重合并事件；Toolbox `cds-agent` 回放改为游标批量读取，避免固定 500 条覆盖长任务审计。
- P1.5 已补 workflow/capsule 路径：`CapsuleExecutor` 的 CDS Agent 审批暂停和完成产物不再固定读取前 1000 条事件，改为 500 条分页、最多 20 页的 `afterSeq` 游标读取，并在日志里标记 `complete` 或 `truncated_or_stalled`，避免工作流长任务静默丢失审计上下文。
- P1.5 已补 Toolbox 证据包完整性：`CdsAgentAdapter` 的事件读取会按 seq 去重推进，遇到分页不前进会停止并标记 `truncated_or_stalled`；Toolbox 输出会显示事件数、lastSeq 和 cursor 状态，避免远程委托的证据包看起来完整但实际已截断。
- P1.6 后台运行已有第一步：`SendMessageAsync` 不再等待 sidecar runtime 跑完，而是写入用户消息、导入 CDS 事件、入队 `InfraAgentRuntimeJob`；`InfraAgentRuntimeWorker` 在后台 scope 中执行 adapter run，并把异常写回 MAP 事件。
- P1.7 Toolbox 入口已有第二步异步语义：`CdsAgentAdapter` 在创建并发送远程任务后立即产出 `CDS Agent 远程运行句柄` JSON artifact，包含 `sessionId/traceId/runtimeAdapter/currentRuntimeRunId/workbenchPath/eventStreamPath/logsPath`；Toolbox 运行页已识别该 artifact 并渲染“打开工作台”和“停止”卡片操作，同时会重新附着远程 SSE 事件流、轮询兜底展示最近事件，并对等待中的 MAP 工具审批提供内联允许/拒绝；不再把 Toolbox step 的完成误写成远程 run 已完成。
- P1.7 兼容性边界已有自动化护栏：`CdsAgentRuntimeCompatibilityTests` 同时扫描 Toolbox adapter 源码并反射检查构造函数依赖，锁定 `IInfraAgentRuntimeAdapter` / `IClaudeSidecarRouter` / `InfraAgentRuntimes` 只能出现在 `CdsAgentAdapter`，避免 PRD/缺陷/文学/视觉等非代码智能体被 sidecar runtime pool 或官方 Claude Agent SDK adapter 可用性误阻断。
- P1.7 权限边界已有第二步：官方 adapter 默认仅开放 `Read/Grep/Glob`，`Bash/Edit/Write` 必须显式 opt-in；已接 `ClaudeAgentOptions.can_use_tool`，危险内置工具会创建 MAP approval request 并等待 approval，再返回官方 `PermissionResultAllow/Deny`。
- P1.2 官方/自研 loop 边界已有机器可读标识：sidecar `/readyz.adapterDiagnostics` 和官方 adapter `runtime_init.content` 都会返回 `loopOwner/sdkLoopEnabled/mapRole/cdsRole`；`loopOwner=claude-agent-sdk` 表示 turn loop 由官方 SDK 承担，`sidecar-legacy-loop` 表示仍在 legacy fallback，避免只靠 adapter 名称猜边界。
- P1.6 页面已显式展示 loop ownership：`/cds-agent` Runtime 调试面板和复制诊断包 summary 会显示 `Loop owner / SDK loop / MAP role / CDS role`；MAP `runtime-status.instances[]` 已强类型透出 `loopOwner/sdkLoopEnabled/mapRole/cdsRole`，页面只把 `adapterDiagnosticsJson` 作为旧实例 fallback。
- P1.6 页面已补商业级就绪门禁：`/cds-agent` Runtime 调试面板会直接显示官方 loop 边界、runtime pool、模型凭据、审批桥、取消句柄、事件恢复 6 个 gate，并把 gate 结果写入可复制诊断包，避免“是否上手可用”只靠读日志或文档判断。
- P1.2 官方 SDK adapter 的 provider 解析已与 legacy sidecar loop 对齐：`claude-agent-sdk` 路径支持 `profile -> request override -> env default` 三段上游选择，`runtime_init` 只记录 `upstreamSource/baseUrlConfigured/apiKeyConfigured/protocol`，不泄露 provider key；profile 找不到会返回结构化 `upstream_resolve_failed`。
- P1.2/P1.6 官方 SDK adapter 已把 provider key 缺失前置到 adapter 边界：默认 readyz 仍允许 MAP 每次 run 通过 runtime profile/request 下发 key，但真正执行前会检查 `profile/request/env` 的有效 key；缺失时返回结构化 `provider_key_missing + nextActions`，不再把凭据配置问题伪装成 SDK runtime 执行失败。
- P1.6 MAP 后端 runtime error 归因已细化：`provider_key_missing`、`upstream_resolve_failed`、`claude_agent_sdk_not_available`、`workspace_prepare_failed`、`cancelled`、`claude_agent_sdk_result_error` 会被映射成 `recoveryKind/retryable/nextActions`，并写入会话 error 事件顶层；配置类错误不再被标成可直接重试，诊断包能直接告诉用户该修 profile、provider key、sidecar dependency 还是 workspace。
- P1.6 页面已消费后端 runtime error 归因：`/cds-agent` Runtime 调试面板新增 `错误归因` gate 和 `Runtime error` 行，复制诊断包保留最新 runtime error 的 `code/message/recoveryKind/retryable/nextActions/source/runtimeAdapter/runtimeInstance`，避免后端结构化错误仍停留在原始事件 JSON。
- P1.6 事件 schema 已校准 runtime error 契约：`/api/infra-agent-sessions/event-schema` 的 `error` 类型显式声明 `retryable/recoveryKind/nextActions/source/runtimeAdapter/runtimeInstance/content`，页面、Toolbox 和工作流可以把这些字段当作稳定诊断字段，而不是临时 payload。
- P1.6 非页面入口也已消费 runtime error 归因：Toolbox `cds-agent` 和工作流 Capsule 渲染事件时会把 error payload 摘成 `code/recoveryKind/retryable/adapter/instance/source/message/下一步`，不再把恢复建议埋在原始 JSON 里。
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
- 2026-05-17 远程 preview 已部署到 `048cfab9`，但真实 official SDK run 仍未通过：`runtime-status` 显示 `isConfigured=false / instanceCount=0 / healthyCount=0`。最新诊断已把 4 条 CDS 返回 `invalid_long_token` 的 active 连接自动标为 revoked，当前只剩 1 条有效连接 `061b88ea`，其 `/api/projects/shared-sidecar-pool-mp4anabh/instances` 返回 `empty_instances`。剩余 blocker 是生产 CDS 本体的 `/api/projects/:id/instances` 尚未暴露源码分支 sidecar 服务，因此 running 的 sidecar pool 暂时不会被 MAP 发现。更新共享 CDS 控制面需要明确批准，不能作为普通 preview 部署自动执行。
- CDS 本体已补路由级回归测试：`cds/tests/routes/remote-hosts-instances.test.ts` 用真实 `CdsPairingService` 签发 long token，经 HTTP 请求 `/api/projects/:id/instances` 证明 shared-service project 的 running branch service 会返回 `baseUrl/tags/host/port` 实例；这比 helper 单测更接近 MAP 的生产调用链。
- CDS `/api/projects/:id/instances` 响应新增 `discovery` 摘要（project kind、deployment/running deployment、branch/running branch/running branch service、preview root），MAP 在 `empty_instances` 时会把摘要拼进 runtime-status blocker；远程 MAP 已部署到 `a46f4b8d`，但生产 CDS 控制面仍未返回该摘要，进一步证明共享 CDS 本体尚未应用实例发现更新。
- 运行池恢复与官方 SDK smoke 已固化为 `doc/guide.cds-agent-runtime-pool-recovery.md`：先验证 CDS 实例发现，再跑只读、审批、取消、Toolbox 委托四个最小 smoke。该 runbook 是下一次真实验收的入口。
- 下一步应做真实 official SDK run、真实 MAP 审批、取消和远程 CDS 视觉验证；Toolbox 的远程会话重新附着已先落地，但仍需要真实长 run 和 approval run 证明闭环。

验证记录：

- `dotnet build prd-api/src/PrdAgent.Core/PrdAgent.Core.csproj --no-restore` 通过；仅有既有 nullable/unused warning。
- `dotnet build prd-api/src/PrdAgent.Infrastructure/PrdAgent.Infrastructure.csproj --no-restore` 顺序重跑通过；仅有既有 MailKit NU1902。
- `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-restore --filter FullyQualifiedName~CapsuleExecutorCdsAgentEventCursorTests` 通过，2 个测试；覆盖 workflow/capsule 的 CDS Agent 事件游标跨页读取和无进展防死循环。
- `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-restore --filter FullyQualifiedName~CdsAgentAdapterTests` 通过，10 个测试；覆盖 Toolbox CDS Agent runtime pool gate、事件游标跨页读取、完整性摘要和无进展防死循环。本轮在普通沙箱内因 MSBuild named pipe 权限失败，已在授权沙箱外重跑通过。
- `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-restore --filter FullyQualifiedName~CdsAgentRuntimeCompatibilityTests` 通过，7 个测试；通过源码扫描和构造函数反射双护栏锁定非代码 Toolbox agent 不依赖 CDS sidecar/runtime pool。
- `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-restore --filter "FullyQualifiedName~InfraAgentSessionsControllerTests|FullyQualifiedName~InfraAgentSessionServiceRuntimeAdapterTests"` 通过，17 个测试；锁定 MAP 默认请求 `claude-agent-sdk`、允许显式 `INFRA_AGENT_SIDECAR_RUNTIME_ADAPTER=legacy-sidecar` 回退，并验证 runtime-status 暴露 `desiredRuntimeAdapter`。
- `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-restore --filter "FullyQualifiedName~CdsAgentRuntimeCompatibilityTests|FullyQualifiedName~CdsAgentAdapterTests"` 通过，15 个测试；覆盖 CDS Agent runtime adapter gate，并锁定非代码 Toolbox agent 不依赖 CDS sidecar/runtime pool。
- `dotnet test prd-api/tests/PrdAgent.Tests/PrdAgent.Tests.csproj --no-restore --filter FullyQualifiedName~DynamicSidecarRegistryTests` 通过，13 个测试；覆盖 MAP/CDS sidecar discovery、empty instances、invalid token 收敛、per-request provider key readiness、sidecar `/readyz.blockers/nextActions` 透传、official SDK adapter 诊断文案和 loop ownership 强类型字段。
- `npm --prefix prd-admin run tsc` 通过；覆盖 `runtime-status.instances[].readyzBlockers/readyzNextActions`、loop ownership 强类型字段和 Runtime 就绪门禁前端类型兼容。
- `python3 -m unittest claude-sdk-sidecar/tests/test_sidecar_readiness.py claude-sdk-sidecar/tests/test_official_agent_sdk_adapter.py` 通过，14 个测试；覆盖 sidecar `/readyz` 默认支持 runtime profile/per-request provider key、可选 env key 强校验、可操作 `blockers/nextActions`，以及官方 SDK adapter 事件/审批/取消、provider override、profile 失败结构和 `ResultMessage` 安全元信息透传。
- `python3 -m py_compile claude-sdk-sidecar/app/main.py claude-sdk-sidecar/app/agent_loop.py claude-sdk-sidecar/app/official_agent_sdk.py claude-sdk-sidecar/app/schemas.py` 通过。本轮增量也重跑了 `python3 -m py_compile claude-sdk-sidecar/app/official_agent_sdk.py claude-sdk-sidecar/app/main.py claude-sdk-sidecar/app/schemas.py`。
- `python3 -m unittest discover -s claude-sdk-sidecar/tests` 通过；该测试使用 fake `claude_agent_sdk`，只验证 adapter 事件映射和 cancel/interrupt 结构，不代表真实 Claude 端到端调用通过。
- `python3 -m unittest discover -s claude-sdk-sidecar/tests` 最新通过 23 个测试；覆盖私有 GitHub token 不进入 clone URL/runtime event/diagnostic，只通过 Git 临时 config env 用于 clone/fetch。
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
