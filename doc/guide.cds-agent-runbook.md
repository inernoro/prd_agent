# CDS Agent 运行手册 · 指南

> **版本**：v1.4 | **日期**：2026-05-18 | **状态**：active（官方 SDK adapter 路径已标注，商业级门禁未全部关闭）

## 服务组成

| 服务 | 职责 |
|------|------|
| `prd-admin` | CDS Agent 页面、基础设施服务配置、工具审批 |
| `prd-api` | long token 保存、会话持久化、事件代理、runtime profile 加密 |
| `cds` | 创建远程 runtime、执行消息、输出事件和日志 |
| MongoDB | 保存连接、profile、session、event、hook |
| runtime 容器或 worker | 执行官方 SDK sidecar、legacy sidecar 或 fake runtime |

命名边界：

- `claude-sdk` 是历史配置名；新的代码审查目标路径是 `claude-agent-sdk`。
- `claude-agent-sdk` 是官方 Claude Agent SDK；本仓库不自研这层 agent turn loop，只维护 thin adapter、MAP/CDS 控制面、审批、事件、日志和 workspace 入口。
- `legacy-sidecar` 是兼容 fallback，只能显式使用，不能作为“官方 SDK 已接入”的证据。
- 真实远程 official SDK run 依赖 MAP 能发现 healthy CDS sidecar runtime pool；恢复步骤见 `doc/guide.cds-agent-runtime-pool-recovery.md`。

## 部署后检查

1. `prd-api` 编译无 CS error。
2. `prd-admin` `tsc --noEmit` 通过。
3. `cds` build 通过。
4. 主分支预览域名可打开。
5. 从真实路径进入：登录 -> 左侧设置 -> 基础设施服务。
6. 授权 CDS 后状态为 `active`。
7. 使用 Anthropic 官方模板新建默认模型运行配置。
8. 确认 runtime-status 显示 `compatibleWithDesiredRuntimeAdapter=true`。
9. 从左侧导航进入 `CDS Agent`，新建会话并发送只读审查消息。
10. 跑 S1/S2/S3 smoke 后再宣称“上手可用”。

## 401 或对端不可达

症状：

- 探活显示 401。
- 页面提示对端不可达。
- 连接列表显示 `revoked`。

诊断：

1. 检查连接状态是否为 `active`。
2. 检查 MAP 保存的 long token 是否存在。
3. 检查 CDS 是否把 token 标记为 revoked。
4. 检查 MAP baseUrl 是否为 CDS 地址，不是 MAP 回跳地址。
5. 检查 CDS 授权页回跳地址是否指向 MAP。

处理：

1. 如果 token 被撤销，重新授权。
2. 如果地址错误，删除错误连接后重新配置。
3. 如果能通但显示 revoked，优先检查 MAP 状态刷新逻辑和 CDS token 状态映射。

## 模型配置失败

症状：

- 创建会话失败，提示没有模型运行配置。
- runtime 启动失败。
- 只有 fake 输出。
- 页面或 API 返回 `runtime_profile_incompatible`。

诊断：

1. 确认至少存在一个默认 runtime profile。
2. 确认 profile 使用 Anthropic/Claude-compatible 协议、baseUrl、model 和 API key。
3. 确认 API key 已保存且后端可解密。
4. 确认 runtime-status 的 `desiredRuntimeAdapter=claude-agent-sdk`。
5. 确认 `compatibleWithDesiredRuntimeAdapter=true`。
6. 确认 fake 或 OpenAI-compatible profile 没有被误当成最终验收。

处理：

1. 优先用 Anthropic 官方模板新建或修复 runtime profile。
2. 运行 `bash scripts/smoke-cds-agent-commercial-readiness.sh` 查看 R0/A0/R1/T1/V1。
3. 配置真实 key 后，用 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` 跑 S1/S2/S3。
4. 在日志里确认请求进入 `claude-agent-sdk`，而不是 legacy/fake adapter。

## 商业级就绪门禁

面向“我怎么审自己的仓库或其他仓库”的上手流程，先读 `doc/guide.cds-agent-code-review-quickstart.md`。本 runbook 只保留运行和排障口径；不要在两份文档里维护两套门禁定义。

不要只看 `smoke-all.sh` 退出码。默认 smoke-all 会把尚未配置真实 provider 的 S1/S2/S3 识别为 readiness/skip，以便部署不断；商业级验收必须单独看 readiness pending。

远程 preview 的默认入口是：

```bash
CDS_HOST=https://cds.miduo.org bash scripts/smoke-cds-agent-one-cycle.sh
```

不要手动填 `SMOKE_TEST_HOST`，除非你明确要覆盖目标环境。脚本会从 CDS branch status 推断当前 preview host，并把 doctor、R0 alias stability、A0 官方 SDK 边界、R1、S1/S2/S3、V1、N6 的证据写入 `/tmp/cds-agent-cycle-*`。如果结果是 `blocked_r1`，不要继续 self update 或 redeploy；这表示 MAP/CDS/sidecar pool 已经到位，下一步是修 runtime profile。
如果忘记设置 `CDS_HOST`，脚本默认会打本地 `http://localhost:5000`；本地 API 没启动时 summary 会写出 `failure.kind=local_api_unreachable` 和远程 preview 的 `narrowRerunCommand`。如果远程域名在当前环境无法解析，会写出 `failure.kind=remote_dns_unreachable`。这两种都不是应用代码或部署失败，先修目标/网络再重跑同一条验证链路。

本地工具链也不要手工猜。A0 会自动选择能 import sidecar 依赖的 Python，并在报告里记录 `executableEvidence.pythonBin`；N6 会自动选择能看到 `Microsoft.NETCore.App 8.x` 的 dotnet，并在终端打印实际 `dotnet:` 路径。这样即使从登录 shell 进入，`python3` 指向缺 `fastapi` 的 Homebrew Python，或 `dotnet` 只看到 .NET 9，也不应再被误判成官方 SDK 边界或非代码兼容性失败。只有自动选择后仍失败，才看对应日志判断是否是真失败。

one-cycle 终端输出就是执行面板：`[当前/总数] phase · step` 展示当前跑到第几个任务，
phase 会标出 `local-static`、`remote-api`、`remote-container`、`provider-gated`、
`visual`；同一份进度也会写入 `cycle-summary.json.timing.steps[].stepIndex/stepTotal`，
方便页面或 CI 不解析终端日志也能复原时间线。汇总里的 `Deploy/build advice` 是是否需要重新部署的判定；`blocked_r1`、
`ready_for_provider_smokes`、`blocked_provider_smokes`、`provider_smokes_incomplete`
都不应该靠重复部署解决，先补 provider key 或跑 provider smoke。

长步骤会每 15 秒输出一次 heartbeat：包含当前 step、elapsed 秒数、日志路径和日志尾部。
heartbeat 只用于暴露进度，不会让快步骤额外等待；如果看到某一步持续输出 heartbeat，
优先看它的 phase 判断是本地测试、远程 API、容器 exec、provider 调用还是视觉截图。

注意凭据边界：`AI_ACCESS_KEY` 是 MAP/CDS API 的 `X-AI-Access-Key` 鉴权，不是 Anthropic provider key。真实 provider key 只应通过 runtime profile、页面 R1 修复入口，或 smoke 里的 `SMOKE_CDS_AGENT_ANTHROPIC_API_KEY` 提供。

| 门禁 | 证明什么 | 命令或入口 |
| --- | --- | --- |
| R0 | MAP/CDS/sidecar pool 可路由官方 SDK | `bash scripts/doctor-cds-agent-runtime.sh` |
| A0 | 默认路径仍是官方 SDK adapter，legacy loop 只显式 fallback | `bash scripts/smoke-cds-agent-official-sdk-boundary.sh` |
| R1 | 默认 profile 兼容官方 SDK 且有 key | `/cds-agent` Runtime 调试面板或 readiness audit |
| T1 | 官方模板和兼容矩阵由后端提供 | `bash scripts/smoke-cds-agent-profile-templates.sh` |
| S1 | 官方 SDK 能真实只读审查仓库 | `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-official-sdk-run.sh` |
| S2 | 危险工具能回到 MAP 审批 | `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-official-sdk-controls.sh` |
| S3 | Stop 能触达底层 SDK run | 同 S2 controls 脚本 |
| V1 | 页面可观察真实运行态 | 打开 `/cds-agent?sessionId=...` 截图 |

需要硬失败时使用：

```bash
SMOKE_CDS_AGENT_REQUIRE_COMMERCIAL=1 bash scripts/smoke-cds-agent-commercial-readiness.sh
```

截至 2026-05-18，远程 preview 的最新无 provider one-cycle 证据是 `/tmp/cds-agent-cycle-20260518123129`：`status=blocked_r1`、`commercialComplete=false`、`R0=pass`、`A0=pass`、`V1=pass`、`N6=pass`、`R1/S1/S2/S3=pending`，总耗时 79s，最慢步骤是 V1 视觉 30s、R0 sidecar alias 12s、runtime doctor 10s，并已生成 `/tmp/cds-agent-cycle-20260518123129/evidence-index.md` 和 `/tmp/cds-agent-cycle-20260518123129/workbench-visual.png`。目标审计 `/tmp/cds-agent-goal-audit-next-command-host-remote-drift.json` 结论仍是 `goalStatus=not_complete`，`cycleFreshness=fresh`、`gitStatus=match`，远程 runtime 相对当前 HEAD 只有 compatible non-runtime drift，并明确给出 `do not self update`、`Do not redeploy for this state`。当前默认 profile 是 `OpenRouter DeepSeek V4 Pro / openai-compatible / deepseek/deepseek-v4-pro`，有 key 但不兼容 `claude-agent-sdk`；下一条有效命令是：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=<sk-ant-...> \
SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 \
  bash scripts/smoke-cds-agent-one-cycle.sh
```

如果 `scripts/audit-cds-agent-goal.sh` 或 N6 在普通 sandbox 内出现 `MSB1025`、`NamedPipeServerStream`、
`System.Net.Sockets.SocketException`、`Permission denied`，这不是非代码 Agent 兼容性失败，而是
MSBuild named pipe/socket 权限不足。目标审计的长步骤默认 90s 超时，命中权限错误或超时都会标成
`N6=infra_failed`；应在有 dotnet 权限的本地环境重跑 audit，再判断 N6 是否真的失败。需要调试超时本身时，
可以临时设置 `CDS_AGENT_GOAL_AUDIT_STEP_TIMEOUT_SECONDS=<seconds>` 和
`CDS_AGENT_GOAL_AUDIT_HEARTBEAT_SECONDS=<seconds>`。

目标审计还会检查 one-cycle 摘要的新鲜度和代码归属。默认 `CDS_AGENT_GOAL_CYCLE_MAX_AGE_SECONDS=86400`；
超过该时间的 `cycle-summary.json` 会被标为 `cycleFreshness=stale`，并加入 `missingOrUnproved`。
新生成的 one-cycle summary 会写入本地 git branch/commit；如果 summary commit 和当前 HEAD 不一致，
审计会用 diff 判断 drift 类型。只有 docs、`.claude`、`.github`、`e2e`、测试、以及
`scripts/smoke-*`/`audit-*`/`doctor-*`/`preflight-*`/`verify-*` 这类 non-runtime drift 时，标为
`compatible_non_runtime_drift`，不要求重跑远程 one-cycle；出现页面/API/runtime/config 等 runtime drift 时，
标为 `runtime_mismatch` 并要求为当前 commit 重跑。stale 或 runtime mismatch 证据可以用来排障，但不能用来宣称目标完成。

CDS GitHub webhook 会把纯文档、changelog、`.claude`、GitHub metadata、`e2e`、`cds/tests`、
前端 `__tests__`、以及 `scripts/smoke-*`/`audit-*`/`doctor-*`/`preflight-*`/`verify-*`/`index-*`
归为 non-runtime change。已有 preview 分支收到这类 push 时只刷新 commit 元数据，不应触发
api/admin/runtime 重新部署；如果看到这类提交仍在 building，优先检查 change-impact 分类。

## 会话无法恢复

症状：

- 刷新后消息丢失。
- 事件重复或乱序。
- stream 断开后无法续读。

诊断：

1. 查询 session 是否存在。
2. 查询 events 是否按 `seq` 递增。
3. 使用 `GET /events?afterSeq=` 验证续读。
4. 检查前端是否按最后一个 seq 恢复，而不是重新覆盖全部消息。

处理：

1. 修复事件写入顺序。
2. 修复前端去重。
3. 对异常 session 保留日志，不要直接删除。

## 页面看起来卡住

症状：

- 用户点击发送后按钮长时间 busy。
- 页面不是逐字实时变化，或 SSE 断开后只靠兜底刷新。
- 后端已经返回，但运行状态长时间停在 queued/running。

诊断：

1. 当前 CDS Agent 页面是 SSE 优先，失败时按 `afterSeq` JSON 分页兜底。
2. `SendMessageAsync` 只负责写入消息并入队后台 runtime job，不应同步等待完整 Agent 执行。
3. 检查 `/events?afterSeq=` 是否仍在增长；如果事件增长，说明任务还在执行，不是页面完全失效。
4. 如果一直没有 runtime 事件，先查 `/api/infra-agent-sessions/runtime-status?refreshDiscovery=true`，确认 runtime pool 是否 healthy。

处理：

1. 让用户把大任务拆成“只读巡检 -> 最小修复 -> 创建 PR”三段。
2. 如果任务超过预期，先查看 sidecar 日志、runtime profile timeout 和 runtime-status blockers。
3. 如果 SSE 断开但分页正常，优先修前端订阅/代理超时；如果分页也没有事件，优先修后台 job 或 runtime pool。

## 停止后仍疑似运行

症状：

- 用户点击停止后，页面显示 stopped，但 sidecar 日志仍有输出。
- 模型 provider 仍有 token 消耗。

诊断：

1. 当前 `Stop` 会停止 MAP session，并通过 adapter best-effort 调 sidecar cancel。
2. session 已持久化 `CurrentRuntimeRunId`；official SDK 路径必须通过 S3 smoke 验证是否调用到底层 interrupt/cancel。

处理：

1. 记录 sessionId、traceId、sidecar 名称和时间窗口。
2. 必要时在 sidecar 侧按 runId 或日志排查。
3. 如果 MAP 状态停止但 sidecar 仍输出，按 `doc/guide.cds-agent-runtime-pool-recovery.md` 的 S3 cancel smoke 定位。

## 工具审批卡住

症状：

- 会话一直 running，但没有后续输出。
- 工具调用显示 waiting。

诊断：

1. 查看最新事件是否为 `tool_call`。
2. 检查工具风险等级。
3. 检查前端审批 API 是否成功返回。

处理：

1. 用户在页面允许或拒绝工具。
2. 如果审批失败，重试审批 API。
3. 如果 runtime 没有收到审批结果，检查 MAP 到 CDS 的审批代理。

## PR 验收失败

症状：

- Agent 只给建议，没有提交 PR。
- 远程仓库没有分支。
- PR 链接为空。

诊断：

1. 检查 runtime 是否具备 GitHub token。
2. 检查 sandbox 是否能 clone 或访问 `prd_agent`。
3. 检查 git 用户名、邮箱、remote 权限。
4. 检查分支是否推送成功。
5. 检查 PR 创建命令或 GitHub API 调用结果。

处理：

1. 补齐 CDS 项目级 GitHub 凭据。
2. 使用只读 git 命令确认访问权限。
3. 让 Agent 先提交一个最小文档或测试修复 PR 验证链路。

## 审查其他仓库失败

症状：

- Agent 明明要求审查其他 repo，但事件里仍读取 `prd_agent`。
- PR 创建到错误仓库。

诊断：

1. 检查 runtime 环境变量：`AGENT_WORKSPACE_ROOT`、`AGENT_WORKSPACE_GITHUB_REPOSITORY`、`AGENT_WORKSPACE_GIT_REF`。
2. 检查 sandbox 里实际 `git remote get-url origin` 和当前分支。
3. 检查 runtime profile 是否复用了默认 workspace。

处理：

1. 先用只读 prompt 要求 Agent 输出 `git status --short`、`git remote get-url origin`、`git branch --show-current`。
2. 确认仓库和分支正确后，再允许写文件、跑测试、创建 PR。

## 回滚

如果发布后 CDS Agent 页面不可用：

1. 暂停 `CDS Agent` 导航入口或保留 `wip` 标记。
2. 保留 `设置 -> 基础设施服务` 探活和授权功能。
3. 回滚 prd-api 会话代理改动前，先导出 `infra_agent_sessions` 和事件集合。
4. CDS runtime adapter 可独立回滚到 fake，但页面必须显示 fake 状态。
