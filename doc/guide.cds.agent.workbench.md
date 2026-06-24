# CDS Agent 工作台用户指南

> 版本：v1.3 | 日期：2026-05-18 | 状态：active，R1/S1/S2/S3 仍需真实 provider 证据

## 先看结论

CDS Agent 工作台不是一个新的自研 Agent loop。当前目标架构是：

- MAP/CDS 保留控制面：登录、CDS branch、workspace、runtime profile、审批、事件、日志、产物、诊断包和页面调试。
- 代码仓库任务默认走官方 `claude-agent-sdk` adapter：turn loop、Claude Code 工具、上下文、stream、permission callback 交给官方 SDK。
- `legacy-sidecar` 只允许显式 fallback；未知 adapter 不能静默回退 legacy。
- `openai-agents-sdk`、`google-adk`、`codex` 当前是候选或 planned-not-routable，不能因为 profile 可保存就进入代码审查默认路径。

截至 2026-05-18，远程 preview 已证明 `R0/A0/V1/N6=pass`，但商业级可用仍阻塞在 R1：默认 profile 是 `OpenRouter DeepSeek V4 Pro / openai-compatible / deepseek/deepseek-v4-pro`，有 key 但不是 Anthropic/Claude-compatible profile。因此 S1/S2/S3 真实 provider run 不能算完成。

> 2026-05-30 更新（优雅降级，先能用）：R1 未闭合不再让用户面对空白/报错。新增 **Lite 只读审查** 降级路径（`GatewayReviewRuntimeAdapter`，走现有 LLM Gateway）：当默认 profile 不兼容 `claude-agent-sdk` 或官方 sidecar 未就绪时，会话自动改走 Lite，读取工作区代码产出**只读**审查结论（不修改文件、不执行命令、无需审批），页面顶部显示「Lite 预览 · 只读」徽章。配置 Claude/Anthropic provider 闭合 R1 后，默认路径自动回到官方 SDK，Lite 退为显式降级项。Lite 的能力边界与剩余债务见 `doc/debt.cds.agent.md`。

## 入口

正式入口是左侧导航的 `CDS Agent` 页面。系统配置和授权入口仍在 `设置 -> 基础设施服务`。

相关文档：

- `doc/guide.cds.agent.code-review-quickstart.md`：给自己或其他仓库做代码审查的操作顺序。
- `doc/design.cds.agent.official-sdk-adapter.md`：官方 SDK adapter 与 MAP/CDS 自研边界。
- `doc/plan.cds.agent.official-sdk-migration.md`：最小开发周期、验收门禁和时间线口径。
- `doc/guide.cds.agent.runtime-pool-recovery.md`：runtime pool 或 sidecar alias 异常排障。
- `doc/plan.cds.agent.workbench.md`：长期路线、下一周期 N1-N6 和“不重复部署”约束。
- `doc/guide.cds.agent.workbench.md`：当前页面怎么用、进度怎么看、失败先查哪里。

## 进度怎么看

进度事实源按优先级看三处：

| 位置 | 看什么 | 说明 |
| --- | --- | --- |
| `/cds-agent` 页面顶部 `当前执行面板` | `当前 X/Y`、`已完成/总数`、当前 step、blocking gate、下一命令、部署建议 | 面向日常协作，优先看这里 |
| `/api/infra-agent-sessions/runtime-status` 的 `diagnostics.executionPanel` | `stepIndex`、`stepTotal`、`passedSteps`、`pendingSteps`、`currentStep`、`timeline`、`nextCommand` | 面向自动化和 smoke，页面也是读这个 |
| 最新 one-cycle 证据目录 | `cycle-summary.json`、`evidence-index.md`、各 step log | 面向验收和复盘，路径由 `smoke-cds-agent-one-cycle.sh` 输出 |

当前 `executionPanel` 的含义：

- `stepIndex/stepTotal`：本周期最小闭环当前卡在第几项。
- `passedSteps/pendingSteps`：本周期已关闭和未关闭任务数。
- `currentStep`：当前应该处理的任务，例如 `N1`。
- `timeline`：N1-N6 全量步骤，不再只靠聊天或终端记忆。
- `deploymentAdvice`：是否需要部署；`blocked_r1` 时应显示不要靠重新部署解决。
- `nextCommand`：当前最窄的下一条命令，优先执行它，不要自行扩大验证范围。

截至 `c5083066`，远程 preview 的事实状态是：

- 远程分支：`codex/cds-agent-workbench-ui`
- 远程 runtime commit：`c5083066`
- 当前阻塞：`R1`
- 当前周期：`official-sdk-provider-closure`
- 进度口径：`N1-N6`，当前卡在 `N1`，不是部署或页面重画问题。

你可以如何协助：

| 你提供 | 我能推进什么 |
| --- | --- |
| 真实 `sk-ant-...` Anthropic key，或确认可用的 Claude-compatible provider | 关闭 R1，并继续跑 S1/S2/S3 provider smokes |
| 指定要审查的仓库和 ref，例如 `owner/repo@main` | 跑 S1 只读代码审查证据 |
| 明确是否允许一次真实 provider 调用 | 设置 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` 跑完整周期 |
| 指定期望的审批/停止场景 | 跑 S2/S3 controls，验证 MAP approval 和 Stop |
| 看到页面不清楚的地方直接指出 | 我把它沉淀到 `executionPanel` 或文档，而不是只在聊天里解释 |

## 首次使用

1. 打开 `设置 -> 基础设施服务`，确认 CDS 连接可用。
2. 打开 `CDS Agent` 页面。
3. 看 `Runtime 调试` 区，而不是先发 prompt。
4. 确认 `Loop owner=claude-agent-sdk`，`Runtime transport=sidecar-runtime-adapter`。
5. 确认默认 profile `compatibleWithDesiredRuntimeAdapter=true` 且有 API key。
6. 如果页面显示 `currentBlockingGate=R1`，先使用页面的 R1 默认 Claude profile 修复入口，或按后端 `nextCommand` 执行。
7. R1 通过后，再发只读审查 prompt。

当前阻塞态下，正确下一步不是重新部署，而是提供 Anthropic/Claude-compatible key 后运行：

```bash
SMOKE_CDS_AGENT_ANTHROPIC_API_KEY=<sk-ant-...> \
SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 \
  bash scripts/smoke-cds-agent-one-cycle.sh
```

## 代码审查流程

不要一上来要求修改和 PR。推荐三段式：

| 阶段 | 操作 | 成功判断 |
| --- | --- | --- |
| 只读巡检 | 让 Agent 读取仓库、列风险，不修改文件 | 输出包含文件路径、证据、影响和验证方式 |
| 最小修复 | 只修一个小问题，写文件和命令必须等待审批 | MAP approval 有记录，diff 可解释，测试最小 |
| PR 收口 | 在 diff 和测试可接受后再创建 PR | PR body 包含修改、测试、剩余风险 |

只读 prompt 示例：

```text
请只读审查当前仓库中最可能影响稳定性的 3 个风险。
要求：
1. 不修改文件；
2. 不运行危险命令；
3. 每个风险给出文件路径、触发条件、影响、最小验证方式；
4. 如果证据不足，说明还需要读哪些文件。
```

最小修复 prompt 示例：

```text
基于上面的第 X 个问题，做最小修复。
要求：
1. 修改前先说明计划；
2. 需要命令或写文件时等待 MAP approval；
3. 只运行最小相关测试；
4. 输出 diff 摘要和剩余风险。
```

## 审查其他仓库

其他仓库审查需要明确目标：

- `gitRepository`: `owner/repo` 或 `https://github.com/owner/repo`
- `gitRef`: 分支、tag 或 commit，例如 `main`

公开 GitHub 仓库可以由 sidecar 准备 workspace。私有仓库需要 `SIDECAR_GITHUB_TOKEN`、`GITHUB_TOKEN` 或后续 GitHub App 授权闭环。workspace 准备结果会在 `runtime_init` 事件里回显 repo/ref/commit 或错误码。

常见 workspace 错误：

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `unsupported_git_repository` | 仓库格式不支持 | 改成 `owner/repo` 或 GitHub HTTPS URL |
| `unsupported_git_ref` | ref 含不安全字符 | 使用普通 branch/tag/commit |
| `github_repository_auth_or_not_found` | 仓库不存在或私有仓库无授权 | 检查仓库名和 GitHub token/App 授权 |
| `git_ref_not_found` | 分支/tag/commit 不存在 | 更换 `gitRef` |
| `workspace_prepare_failed` | clone/fetch/cwd 准备失败 | 看 runtime error 的 workspace 字段和 sidecar 日志 |

## 页面要看什么

| 区域 | 用途 | 不通过时 |
| --- | --- | --- |
| 当前执行结论 | 后端 `executionPanel` 事实源，显示 status、blocking gate、next command、deployment advice | 按 `currentBlockingGate` 处理，不要跳步 |
| Runtime 调试 | 显示 adapter、loop owner、profile、runtime pool、workspace、last error | 先跑 doctor 或 R1 repair |
| Readiness ledger | 显示 R0/A0/R1/S1/S2/S3/V1/N6 | WAIT/pending 不能当完成 |
| 下一周期最小闭环 | 后端 `nextCyclePlan`，用于限定本周期只推进一个硬门禁 | 阻塞项没过时不扩 UI 功能 |
| 调试命令 | 后端 `debugCommands`，可直接复制执行 | 优先执行 blocked 命令 |
| 事件流 | 观察 init/text/tool/approval/result/done/error | 旧会话事件不能证明当前 provider gate |

页面使用 SSE 增量续读，并有 JSON 分页兜底；不再把固定 500 条回放当审计边界。Toolbox 的 CDS Agent 卡片表示“远程运行句柄已创建”，真实状态仍以 `/cds-agent?sessionId=...` 的事件和诊断为准。

## 商业级验收门禁

| Gate | 含义 | 证据 |
| --- | --- | --- |
| R0 | MAP/CDS 能发现并路由到 official SDK runtime pool | doctor、runtime-status、sidecar alias smoke |
| A0 | 自研 loop 已压缩为官方 SDK adapter，legacy 只显式 fallback | official SDK boundary smoke |
| R1 | 默认 runtime profile 兼容 `claude-agent-sdk` 且有 key | profile repair/test-before-promote |
| S1 | 官方 SDK 真实只读审查仓库并输出结论 | provider run smoke |
| S2 | 危险工具进入 MAP approval，拒绝/允许能回写 SDK | controls smoke |
| S3 | Stop 能 interrupt/cancel 底层 SDK run | controls smoke |
| V1 | 页面截图显示真实 session/trace/adapter/workspace/event/error | visual smoke |
| N6 | PRD/缺陷/文学/视觉等非代码 agent 不被 CDS sidecar 迁移误伤 | non-code compatibility smoke |

没有 `SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1` 时，S1/S2/S3 脚本只是 readiness 或跳过真调用，不能证明“上手就能审查代码”。

## 失败先看哪里

| 现象 | 优先查看 |
| --- | --- |
| 页面打开但不能跑 | 当前执行结论的 `currentBlockingGate`、`blockingReason`、`deploymentAdvice` |
| R1 pending | 默认 profile 是否 Anthropic/Claude-compatible，是否有 key |
| `provider_key_missing` | runtime profile 或 request/env provider key |
| `runtime_profile_incompatible` | 当前 profile 协议/模型不适合 `claude-agent-sdk` |
| `claude_agent_sdk_not_available` | sidecar 镜像依赖和 `claude-agent-sdk` 安装 |
| workspace 失败 | `workspaceErrorCode`、repo/ref/commit、GitHub 授权 |
| 审批不出现 | MAP approval bridge、`can_use_tool`、工具 allowlist |
| Stop 后还输出 | `CurrentRuntimeRunId`、sidecar cancel、SDK interrupt 事件 |
| S1/S2/S3 pending | 先确认 R1，再显式打开 provider smoke |

## 不要反复部署的情况

这些状态不靠重新 build/deploy 解决：

- `blocked_r1`
- 默认 profile 不兼容或缺 key
- S1/S2/S3 因未开启 provider call 而 pending
- 页面已经能显示 R0/A0/V1/N6，但 provider gate 未过

需要部署或 self update 的情况：

- API/admin/runtime 代码有运行时变更。
- sidecar alias、容器网络、鉴权或 secret 变更。
- 视觉页面本身发生变更，需要远程截图验证。
- profile 修复后需要 promotion 验证且远程状态滞后。

## 当前未完成项

目标尚未完成，不能把系统宣称为商业级可用。剩余硬证据是：

- R1：创建并验证 Anthropic/Claude-compatible 默认 profile。
- S1：远程 official SDK 只读代码审查真实通过。
- S2：真实 MAP approval 进入并回写 SDK。
- S3：Stop 真实 interrupt SDK run。
- V1：通过真实 run 截图展示 sessionId、traceId、adapter、loop owner、workspace 和最新事件。

完成前，正确的产品表述是：控制面、官方 SDK adapter 边界、可观察性面板和验证脚本已经具备；真实 provider 代码审查闭环仍需 R1/S1/S2/S3 证据。
