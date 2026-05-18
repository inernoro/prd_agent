# CDS Agent 代码审查上手指南

> 版本：v1.2 | 日期：2026-05-18 | 状态：面向使用者的 quickstart（R0 runtime pool 正在恢复，R1/S1/S2/S3 仍需真实 provider 证据）

## 目标

这份文档回答两个问题：

- 我想让 CDS Agent 审查当前仓库或其他仓库，会经历哪些步骤。
- 当前官方 SDK、自研控制面、其他智能体分别负责什么，出问题时该看哪里。

结论先写清楚：CDS Agent 的产品目标不是继续自研 agent loop，而是保留 MAP/CDS 控制面，把代码任务的循环、上下文、Claude Code 工具和权限回调交给官方 `claude-agent-sdk` adapter。MAP/CDS 继续负责登录、仓库/分支、runtime profile、审批、事件、日志、产物和可视化调试。

## 一次代码审查会发生什么

| 阶段 | 用户动作 | 系统动作 | 你应该看到 |
| --- | --- | --- | --- |
| 1. 选择入口 | 打开 `/cds-agent` 或从 AI 百宝箱委托 `cds-agent` | MAP 创建或复用 infra agent session | sessionId、traceId、runtime adapter |
| 2. 选择目标 | 填 `gitRepository/gitRef`，或使用当前 CDS workspace | CDS/sidecar 准备 workspace；私有 GitHub 需要授权 token | workspace source、repo/ref、commit |
| 3. 选择模型 | 选择 runtime profile | MAP 解析 provider/baseUrl/model/key；key 不进入日志 | provider key gate 通过，或显示 `provider_key_missing` |
| 4. 启动 run | 发送只读审查 prompt | MAP 入队后台 job，sidecar 选择 `claude-agent-sdk` | `runtime_init`、`loopOwner=claude-agent-sdk` |
| 5. 读取/分析 | 等 Agent 审查代码 | 官方 SDK 负责上下文、工具循环和流式输出 | text delta、tool event、usage/result |
| 6. 危险动作 | 如果要运行命令、写文件、开 PR | SDK permission callback 转 MAP approval | 页面出现允许/拒绝，刷新后仍可操作 |
| 7. 结束/停止 | 等完成或点击 Stop | MAP 写 done/cancel 事件；adapter 调 SDK interrupt | done/error/cancel 结构化事件 |
| 8. 复盘 | 导出 run bundle | 页面导出 session、events、logs、diagnostics，自动脱敏 | 可提交给维护者排障 |

## 推荐使用顺序

第一次使用不要直接要求改代码和发 PR。按下面顺序验证，每一步都看 Runtime 调试面板：

1. 只读仓库摘要：只输出目录、分支、最近提交，不修改文件。
2. 只读代码审查：指出一个风险，要求给文件路径和原因。
3. 命令审批：让它尝试 `git status --short`，确认页面出现审批卡。
4. 取消测试：让它循环输出状态 2 分钟，点击 Stop，确认底层 run 停止。
5. 修改任务：只允许改一个小文件，要求运行最小测试。
6. PR 任务：确认 GitHub 权限后再让它创建分支和 PR。

## 正常上手路径

当 R0/R1 已经通过后，用户不需要理解 sidecar 或 SDK 细节，按这个顺序使用即可：

1. 打开 `/cds-agent`。
2. 在 Runtime 调试面板确认 `loopOwner=claude-agent-sdk`，`Default profile` 兼容且有 key。
3. 当前仓库审查时保留默认 workspace；其他仓库填写 `gitRepository` 和 `gitRef`。
4. 第一条 prompt 明确只读，例如“审查当前仓库稳定性风险，不修改文件，不运行危险命令”。
5. 等 assistant 输出后，检查结论是否包含文件路径、触发条件、验证方式。
6. 需要命令、编辑或 PR 时，再把任务拆成一个小改动，并通过 MAP approval 逐项确认。
7. 失败或结果重要时，导出诊断包；提交问题时只给 sessionId、traceId、事件摘要和错误码，不要提供 API key。

如果第 2 步没通过，先不要发审查 prompt；应该先看页面“当前执行结论”的 `currentBlockingGate`、`blockingReason`、`deploymentAdvice` 和 `nextCommand`，再运行 `bash scripts/doctor-cds-agent-runtime.sh` 或页面的 R1 修复入口。

当前远程 preview 的最新 runtime pool 证据是：`BRANCH_LOCAL_SIDECAR_CLEAN=contaminated:4`、`REMOTE_HOST_AVAILABLE=missing`、`SHARED_POOL_RUNNING=missing`，目标仍是 `commercialComplete=false`。也就是说，现在第一阻塞不是继续 redeploy preview，也不是先修默认 profile，而是先恢复 R0 runtime pool：清理 `prd-agent` 业务项目里的 branch-local `claude-agent-sdk-runtime-v2-prd-agent` 残留，登记至少一个 enabled remote host，并让 `shared-sidecar-pool-mp4anabh` 跑出 healthy official SDK instance。证据入口是 `CDS_HOST=https://cds.miduo.org bash scripts/collect-cds-agent-runtime-pool-evidence.sh`，当前进度见 `doc/status.cds-agent-current-progress.md`，结构性原因见 `doc/report.cds-agent-runtime-pool-contamination-2026-05-18.md`。

R0 恢复后，下一层仍是 R1 provider profile。此前远程默认 profile 是 `OpenRouter DeepSeek V4 Pro / openai-compatible / deepseek/deepseek-v4-pro`，它有 key，但不是 Anthropic/Claude-compatible profile，因此官方 `claude-agent-sdk` 路径会在运行前拦截。`runtime-status.defaultRuntimeProfile` 会给出结构化原因：`compatibilityReasonCode=openai-compatible-non-claude-model`，并附带 `compatibilityNextActions`。不要把这个 profile 当作“上手就能审查代码”的完成态；R0 恢复后再用页面 R1 修复入口或 `CDS_HOST=https://cds.miduo.org SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=<sk-ant-...> SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-one-cycle.sh` 把默认 profile 切到官方 Anthropic 模板并收集 S1/S2/S3 证据。

页面上如果出现历史会话的 approval、cancel 或 assistant 事件，也不能直接算作 S1/S2/S3 商业证据。前端现在要求 `defaultProfileReady && officialLoopReady` 后，才允许当前页面事件作为 provider gate 证据；R1 未过时，S1/S2/S3 必须保持 WAIT/pending。

## 最小可用闭环

面向日常使用时，先把"能打开页面"和"能真实审查代码"分开判断：

| 阶段 | 目的 | 入口 | 必须看到的证据 |
| --- | --- | --- | --- |
| R0 控制面 | 验证 MAP/CDS/sidecar pool 已连通 | `bash scripts/doctor-cds-agent-runtime.sh` | `instanceCount > 0`、`healthyCount > 0`、`loopOwner=claude-agent-sdk` |
| R1 profile | 验证默认模型能走官方 SDK | Runtime 调试面板或 `runtime-status` | `compatibleWithDesiredRuntimeAdapter=true` 且 profile 有 API key；不通过时必须有 `compatibilityReasonCode` 和 `compatibilityNextActions` |
| S1 只读审查 | 证明官方 SDK 真能读仓库并输出结论 | `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-official-sdk-run.sh` | assistant 消息、repo/ref/workspace 证据、无文件变更 |
| S2 审批 | 证明危险动作回到 MAP 人审 | `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-official-sdk-controls.sh` | `tool_call.status=waiting`、拒绝后有 `tool_result.source=map-tool-approval` |
| S3 停止 | 证明 Stop 不是只改数据库状态 | 同 S2 controls 脚本 | Stop 请求后 session 进入 stopped/stopping，并有 cancel/interrupt 事件 |
| V1 视觉 | 证明页面显示真实运行态 | 打开 `/cds-agent?sessionId=...` 并截图 | 页面显示真实 sessionId、traceId、adapter、loop owner、workspace、last event/error |

没有 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` 时，S1/S2/S3 脚本只是 readiness gate 或跳过真调用；它们通过只能证明控制面没有明显配置错误，不能证明"上手就能审查代码"。

R1 的修复路径以 `GET /api/infra-agent-sessions/runtime-status?refreshDiscovery=true` 返回的 `diagnostics.runtimeProfileRepairPlan` 为准。页面上的 “R1 默认 Claude profile” 卡片、复制诊断包和 readiness smoke 都应消费这个后端字段；不要在前端或文档里另写一套默认模型、协议或下一步判断。

同一个接口还会返回 `diagnostics.debugCommands`，页面的“调试命令”区域直接展示这些后端生成的命令。日常排障优先按该列表执行：先跑 doctor / R1 dry-run；拿到真实 Anthropic/Claude-compatible key 后再跑 R1 test-before-promote；R1 通过后才显式打开 provider 调用跑 one-cycle。

`diagnostics.executionPanel` 是当前执行结论的机器事实源：它给出 `status`、`commercialComplete`、`currentBlockingGate`、`blockingReason`、`nextCommand` 和 gate 计数。页面的“当前执行结论”和 readiness smoke 都应优先消费这个字段；如果 `currentBlockingGate=R0`，下一步应先跑 doctor；如果是 `R1`，再跑 R1 dry-run/test-before-promote，避免跳过真实阻塞。页面还会把这个结论折成三格执行判定：`部署判定`、`命令性质`、`Provider 调用`。R1 dry-run 应显示“不需要重新部署 / R1 dry-run / 不会触发真实 provider 调用”；provider one-cycle 才应显示“显式 opt-in 后才调用 provider”。

同一个 execution panel 还会给出 `deploymentAdvice`。它的用途是减少无意义构建/部署：runtime pool 缺 remote host、shared pool 没 running instance、branch-local sidecar contamination 都不靠普通 preview redeploy 解决；`blocked_r1` 或 `profile-blocked` 不靠 redeploy 解决，应该保存 Anthropic/Claude-compatible profile；S1/S2/S3 pending 不靠 redeploy 解决，应该显式打开 provider smoke；只有代码改动、远程容器网络/鉴权变化、视觉证据或 promotion 需要重新部署。

需要给人类或 CI 留证据时，doctor 可以输出机器可读报告：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_DOCTOR_REPORT=/tmp/cds-agent-doctor.json \
  bash scripts/doctor-cds-agent-runtime.sh
```

报告里的 `diagnosis` 是当前结论，`nextRecommended` 是下一步动作，`aliasCheck` 证明 API 容器访问 sidecar 是否稳定，`defaultProfile.compatibleWithDesiredRuntimeAdapter` 判断 R1 是否仍阻塞。若 R1 阻塞，`defaultProfile.compatibilityReasonCode` 和 `defaultProfile.compatibilityReason` 是唯一应该展示给人的原因，不要再用前端字符串猜测。这样每次排障都能明确时间花在 runtime pool、profile、provider 真调用、视觉截图还是非代码兼容回归。

如果要回答“这个长期目标是否已经完成”，不要只看某个页面或某次脚本退出码，先跑目标审计：

```bash
CDS_AGENT_GOAL_AUDIT_REPORT=/tmp/cds-agent-goal-audit.json \
  bash scripts/audit-cds-agent-goal.sh
```

它会本地验证 A0 official SDK adapter 边界和 N6 非代码/候选 SDK 兼容性，并读取最新 one-cycle `cycle-summary.json`。输出里的 `goalStatus=not_complete` 是正常的保护状态：只要 R1/S1/S2/S3/V1 仍缺少当前证据，就不能把系统宣称为商业级完成；`executionPanel.nextCommand` 和 `deploymentAdvice` 才是下一步动作来源。R1 阻塞时，终端会打印 `R1 profile reason`，JSON 报告会在 `requirements.providerReadiness.compatibilityReasonCode`、`compatibilityReason` 和 `compatibilityNextActions` 写出同一组结构化原因。长步骤会输出 heartbeat，并受 `CDS_AGENT_GOAL_AUDIT_STEP_TIMEOUT_SECONDS` 约束，默认 90s，避免目标审计卡死。one-cycle 证据默认 24h 内有效；超过 `CDS_AGENT_GOAL_CYCLE_MAX_AGE_SECONDS` 会标成 `cycleFreshness=stale`，不能用于证明目标完成。git commit 不完全相等时，audit 会检查 diff：如果只有 docs、smoke/audit/doctor/preflight/verify/index 脚本和测试等 non-runtime drift，会标成 `compatible_non_runtime_drift`，不用重跑远程 one-cycle；如果出现前端页面、API、runtime、配置等 runtime drift，会标成 `CYCLE_GIT_MATCH=runtime_mismatch`，必须为当前 commit 重跑 `scripts/smoke-cds-agent-one-cycle.sh`。如果普通 sandbox 内的 N6 报 `MSB1025`、`NamedPipeServerStream`、`System.Net.Sockets.SocketException`、`Permission denied` 或命中审计超时，按 `infra_failed` 处理，使用有 dotnet 权限的本地环境重跑，不要把它解读成非代码 Agent 兼容性失败。

完整一周期检查优先用：

```bash
CDS_HOST=https://cds.miduo.org bash scripts/smoke-cds-agent-one-cycle.sh
```

脚本会自动推断当前远程 preview host；不要为了远程 preview 手动填 `SMOKE_TEST_HOST`。但在当前 runtime pool 恢复阶段，优先跑更窄的只读证据采集：

```bash
CDS_HOST=https://cds.miduo.org \
CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 \
  bash scripts/collect-cds-agent-runtime-pool-evidence.sh
```

最新 runtime pool evidence 示例是 `/tmp/cds-agent-runtime-pool-evidence-20260518152052`：总耗时约 14s，清楚显示 7 个 branch-local sidecar 污染、0 个 remote host、shared pool 没有 running instance。这个证据比反复 one-cycle 更适合当前阶段，因为它直接回答“为什么又侵犯 MAP”和“下一步是否需要部署”。

A0/N6 的本地工具链已经做了自检：A0 会自动选择能 import `fastapi`、`pydantic`、`starlette` 的 Python，并在报告中记录 `pythonBin`；N6 会自动选择能看到 .NET 8 runtime 的 dotnet，并在终端打印 `dotnet:`。如果登录 shell 里的 `python3` 或 `dotnet` 指向错误版本，先看脚本打印的实际解释器路径，不要把依赖缺失当成 CDS Agent 功能失败。

R1 的自动化入口是 `bash scripts/smoke-cds-agent-r1-profile-repair.sh`。默认不写远程状态，只验证后端修复计划、Anthropic 官方模板和“缺 API key 不创建半成品 profile”的保护；如果要真正修复远程默认 profile，显式提供 `SMOKE_CDS_AGENT_ANTHROPIC_API_KEY` 后再运行同一个脚本。脚本和页面都会调用后端 `POST /api/infra-agent-runtime-profiles/templates/{templateId}/default-profile`，由后端创建非默认 Anthropic 候选 profile，调用 `/test` 验证上游可用，成功后才提升为默认 profile，并复查 `commercialReadiness.R1=pass`。页面的“保存配置 + 设为默认”和“更新当前配置 + 设为默认”都走同样的 test-before-promote 流程；测试失败时会清理候选 profile，不会覆盖当前默认配置。
设置 `SMOKE_CDS_AGENT_R1_REPORT=/tmp/cds-agent-r1.json` 时，dry-run 也会输出当前默认 profile、后端修复计划、缺 key 保护结果和不含真实密钥的下一条命令，方便把 R1 阻塞放进诊断包。报告里的 `nextCommands` 会拆开三种动作：`dryRun` 只复查保护，`repairOnly` 只执行 R1 test-before-promote，`repairAndProviderCycle` 才会在 R1 后继续收集 S1/S2/S3 provider 证据。

下一周期 N1-N6 的最小闭环以同一个接口返回的 `diagnostics.nextCyclePlan` 为准。它会明确每一步的状态、阻塞项、验收证据和停止条件；页面 Runtime 调试区只展示该计划，不能把文档里的表格复制成另一套前端逻辑。

N6 的最小自动化入口是 `bash scripts/smoke-cds-agent-non-code-compatibility.sh`。它不消耗 provider token，会验证 PRD/Defect/Literary/Visual 等非代码 Toolbox agent 没有注入 CDS sidecar runtime pool 或 Claude sidecar 依赖，并用 fake gateway 跑过各自的最小业务动作；同时会跑 runtime adapter 兼容矩阵测试，确认 `codex`、`openai-agents-sdk`、`google-adk` 等候选官方 SDK 仍是 `planned-not-routable`，不会因为页面能保存 profile 就进入代码审查默认路径。

## 给自己或其他仓库做审查

一次正常审查建议按这个流程走：

| 步骤 | 操作 | 成功判断 |
| --- | --- | --- |
| 1. 选择目标 | 当前仓库留空 workspace，其他仓库填写 `gitRepository` 和 `gitRef` | Runtime init 回报 repo/ref/commit 或明确 workspace source |
| 2. 选择 profile | 使用 Anthropic 官方模板创建默认 runtime profile | Runtime 调试不再显示 `runtime_profile_incompatible` |
| 3. 先只读 | Prompt 明确"不要修改、不要开 PR" | 只出现 read/search 类工具或纯文本输出 |
| 4. 看证据 | 检查文件路径、风险说明、事件流、usage、workspace | 结论能追溯到具体 repo/ref 和文件 |
| 5. 再放开动作 | 需要命令/编辑/PR 时打开对应工具和审批 | 每个危险动作都有 MAP approval 记录 |
| 6. 导出复盘 | 失败或重要结果导出诊断包 | 包含 session、trace、events、logs、adapter/profile，不含 API key |

最小 prompt 建议先从只读开始，不要一步到位要求修改和 PR：

```text
请只读审查 <owner/repo>@<ref> 中最可能影响稳定性的 3 个风险。
要求：
1. 不修改文件；
2. 不运行危险命令；
3. 每个风险给出文件路径、触发条件、影响、最小验证方式；
4. 如果证据不足，明确说明还需要读哪些文件。
```

如果要让它改代码，把任务缩到一个文件或一个小 bug：

```text
在完成只读分析后，只修复你认为风险最高且影响范围最小的一个问题。
要求：
1. 修改前说明计划；
2. 需要命令或写文件时等待 MAP approval；
3. 只运行最小相关测试；
4. 输出 diff 摘要和剩余风险。
```

## 审查当前仓库

在本仓库或已准备好的 CDS workspace 中，prompt 可以这样写：

```text
请只读审查当前仓库中 CDS Agent runtime 相关代码，指出 3 个最可能影响稳定性的风险。
要求：
1. 不修改文件；
2. 不运行危险命令；
3. 每个风险给出文件路径、触发条件、建议验证方式。
```

通过标准：

- Runtime 调试显示 `runtimeAdapter=claude-agent-sdk`。
- Loop owner 显示 `claude-agent-sdk`，不是 `sidecar-legacy-loop`。
- 事件里有 `runtime_init/text_delta/done`。
- 没有文件变更，也没有未审批的危险工具。

## 审查其他仓库

填写：

- `gitRepository`: `owner/repo` 或 `https://github.com/owner/repo`
- `gitRef`: 分支、tag 或 commit，例如 `main`

公开仓库可直接准备 workspace。私有仓库需要 sidecar 环境有 `SIDECAR_GITHUB_TOKEN` 或 `GITHUB_TOKEN`，或者后续接入 GitHub App 授权选择器。

常见 workspace 错误：

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `unsupported_git_repository` | 仓库格式不支持 | 改成 `owner/repo` 或 GitHub HTTPS URL |
| `unsupported_git_ref` | ref 含不安全字符 | 使用普通 branch/tag/commit |
| `github_repository_auth_or_not_found` | 仓库不存在或私有仓库无授权 | 检查仓库名和 GitHub token/App 授权 |
| `git_ref_not_found` | 分支/tag/commit 不存在 | 更换 `gitRef` |
| `workspace_target_conflict` | workspace 目录冲突 | 清理或更换 workspace root |

## 官方 SDK 与自研边界

| 部分 | 归属 | 当前策略 |
| --- | --- | --- |
| Agent turn loop、上下文管理、Claude Code 内置工具 | 官方 `claude-agent-sdk` | 默认目标路径 |
| MAP session、审计、审批、事件、日志、run bundle | 本仓库 | 必须保留 |
| CDS workspace、分支、容器、preview、secret | 本仓库 CDS 控制面 | 必须保留 |
| `SidecarRuntimeAdapter` | 本仓库薄传输层 | 只做 MAP 到 sidecar 的路由/SSE/cancel 映射 |
| `legacy-sidecar` | 兼容 fallback | 只在显式配置时使用 |
| PRD/缺陷/文学/视觉智能体 | 非代码 agent | 先不迁到 Claude Agent SDK，避免被代码 runtime pool 影响 |

`claude-agent-sdk` 不是本仓库自研。当前 adapter 代码是本仓库写的接入层，用来把官方 SDK 的事件、权限、取消和结果映射进 MAP/CDS。

当前项目里 “SDK” 的归属口径如下：

| 名称 | 是否官方 | 当前项目是否已可路由 | 用途 |
| --- | --- | --- | --- |
| `claude-agent-sdk` | 是，Anthropic/Claude 官方 Agent SDK | 是，CDS Agent 默认目标路径，但要求 Anthropic/Claude-compatible profile | 代码仓库审查、编辑、命令、权限回调 |
| `openai-agents-sdk` | 是，OpenAI 官方 Agents SDK | 否，当前为 planned-not-routable | 未来可评估非代码 agent 的 handoff、guardrail、trace |
| `google-adk` | 是，Google Agent Development Kit | 否，当前为 planned-not-routable | 未来可评估 Gemini/Google 生态编排 |
| `legacy-sidecar` | 否，本仓库历史自研 loop | 只允许显式 fallback | 历史兼容，不再扩大能力 |
| `SidecarRuntimeAdapter` | 否，本仓库薄传输层 | 是 | MAP 到 sidecar 的路由、SSE、cancel、诊断映射 |

判断原则：如果官方 SDK 已经提供 loop、工具调用、上下文、stream、permission 或 trace，本仓库只写 adapter bridge；只有账号、CDS workspace、审批审计、事件持久化、run bundle 和 UI 调试继续自研。

模型配置里的 “Anthropic 官方模板” 来自 MAP 后端 `GET /api/infra-agent-runtime-profiles/templates`，不是页面硬编码。它会预填 Anthropic Messages 协议、官方 baseUrl、Claude Sonnet 模型和资源默认值；用户仍需手动填入自己的 API key 并保存为 runtime profile。保存时如果草稿仍匹配模板，页面会调用 `POST /api/infra-agent-runtime-profiles/templates/{templateId}/profiles`，后端按模板创建 profile，缺 API key 会直接返回 `api_key_required`。

Adapter 兼容性来自 MAP 后端 `GET /api/infra-agent-runtime-profiles/adapter-compatibility`。当前代码审查默认只把 `claude-agent-sdk` 当作可路由官方 SDK 路径；`legacy-sidecar` 是显式 fallback；`codex` 仍是 planned-not-routable，不代表页面选择 `runtime=codex` 后就已经接入官方 Codex 能力。判断时先看 `routableByDefault` 和 `missingAdapterContracts`，再看 `supportedProfileProtocols`：OpenAI-compatible profile 只能说明模型协议可用，不能自动证明 run/event/tool approval/cancel/workspace/artifact 这些 adapter contract 已经落地。

## 其他智能体兼容性口径

CDS Agent 迁移官方 SDK 时，不能把非代码智能体也绑到 sidecar runtime pool：

| 智能体 | 是否应依赖 Claude Agent SDK sidecar | 当前要求 |
| --- | --- | --- |
| CDS Agent | 是 | 代码仓库任务默认走 `claude-agent-sdk`，MAP/CDS 只保留控制面 |
| workflow/capsule `claude-sdk` | 是 | 继续兼容历史 runtime 名，但共享 runtime adapter 和事件 cursor |
| PRD Agent | 否 | 继续走文本/结构化输出链路，不能因为 sidecar pool 不健康而失败 |
| Defect Agent | 否 | 继续走 JSON/schema 业务链路，后续可接 guardrail/trace，不接代码工具 loop |
| Literary Agent | 否 | 保持文本生成链路，不引入代码 workspace 和审批依赖 |
| Visual Agent | 否 | 保持媒体管线、资产持久化和超时策略，不接代码 sidecar |

当前用 `CdsAgentRuntimeCompatibilityTests` 锁非代码 agent 依赖边界：只有 `CdsAgentAdapter` 可以依赖 `IInfraAgentRuntimeAdapter`、`IClaudeSidecarRouter` 或 `InfraAgentRuntimes`。`InfraAgentRuntimeProfilesControllerTests` 锁候选官方 SDK 的路由边界：未补齐 run/event/tool approval/cancel/workspace/artifact 契约和 S1/S2/S3 证据前，`codex`、`openai-agents-sdk`、`google-adk` 只能是 `planned-not-routable`。新增其他智能体能力时，如果需要官方 SDK，也应先说明它是"代码执行型"还是"非代码编排型"，再决定用 Claude Agent SDK、OpenAI Agents SDK、普通 gateway 或媒体管线。

## 失败先看哪里

| 现象 | 优先查看 |
| --- | --- |
| 页面打开但不能跑 | Runtime 调试面板的 blockers/nextActions |
| `instanceCount=0` | CDS sidecar runtime pool 发现，参考 `doc/guide.cds-agent-runtime-pool-recovery.md` |
| `provider_key_missing` | runtime profile 或 sidecar `ANTHROPIC_API_KEY` |
| `claude_agent_sdk_not_available` | sidecar 镜像依赖和 `claude-agent-sdk` 安装 |
| workspace 失败 | error content 的 `workspaceErrorCode` |
| 审批不出现 | MAP approval bridge 和 `/api/agent-tools/approvals/...` |
| Stop 后还输出 | `CurrentRuntimeRunId`、sidecar cancel、SDK interrupt 事件 |
| Toolbox 看似完成但远程还在跑 | 这是正常异步委托；打开 run handle 对应的 `/cds-agent?sessionId=...` |

## 当前未完成的商业级验收

截至 2026-05-18，代码已具备官方 SDK adapter seam、结构化诊断、事件游标、异步 Toolbox 句柄、run bundle 导出、runtime pool smoke、sidecar alias 稳定性 smoke、profile preflight gate、doctor JSON 报告、S1 official SDK run 脚本入口和 S2/S3 control 脚本入口。远程 preview 已能证明 `desiredRuntimeAdapter=claude-agent-sdk`、`runtimeTransport=sidecar-runtime-adapter`、`loopOwner=claude-agent-sdk`、`aliasCheck.status=stable`。

但仍不能宣称完全完成，原因是远程 preview 的真实 official SDK run 还缺这些证据：

- 配置真实 Claude/Anthropic-compatible runtime profile 和 API key。
- 远程 S1 只读 run 用该 profile 真实通过。
- 远程 S2 MAP 审批真实通过。
- 远程 S3 Stop 能真实 interrupt SDK run。
- `/cds-agent` 截图显示真实运行态字段，而不是静态或空态。

配置真实 profile 后，先跑：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=<sk-ant-...> \
SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 \
  bash scripts/smoke-cds-agent-one-cycle.sh
```

如果只想拆开看失败点，再分别跑：

```bash
CDS_HOST=https://cds.miduo.org SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-official-sdk-run.sh
CDS_HOST=https://cds.miduo.org SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-official-sdk-controls.sh
```

完成这些后，才可以把“上手即用”从诊断可用推进到商业级可用。
