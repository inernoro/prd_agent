# CDS Agent P4-5 writable / PR / KB apply 试用计划

日期：2026-05-19

## 结论

P4-5 完成。写入能力进入试用前的边界、审批门禁、差异产物、失败回滚和验收门槛已经收口。当前远端默认路径仍然只读；不默认开放代码写入、知识库 apply、PR 或 commit。

推荐下一阶段采用“灰度写入试用”而不是直接发布写入能力：先在受控仓库和受控知识库上启用 `code-writable-confirm` / KB draft-diff-apply 路径，所有写入都必须走 MAP approval，并产生 diff、trace、artifact 和可回滚证据。

## 当前已具备的本地能力

| 能力 | 状态 | 当前证据 |
| --- | --- | --- |
| KB draft workspace | 本地已实现 | `kb_draft_create/read/list/discard`；`scripts/smoke-cds-agent-kb-draft-workspace.sh` |
| KB diff/apply/reject | 本地已实现 | `kb_diff/kb_apply/kb_reject`；`kb_apply` 必须 MAP approval；`scripts/smoke-cds-agent-kb-diff-apply.sh` |
| 工作流审批暂停 | 本地已实现 | `waiting_approval`、审批通过/拒绝、超时 `timed_out`；`scripts/smoke-cds-agent-workflow-approval.sh` |
| 代码 writable profile | 本地已实现 | `code-writable-confirm`；默认只读不暴露代码写工具；`scripts/smoke-cds-agent-writable-profile.sh` |
| Phase 2 验收包 | 已归档 | `doc/report.cds-agent-phase2-acceptance-2026-05-19.md` / `.pdf` |

## 不开放为默认路径

| 能力 | 默认状态 | 原因 |
| --- | --- | --- |
| `repo_write_file` | 不开放 | 必须有明确 writable profile、MAP approval、diff 和回滚点 |
| `repo_run_command` | 不开放 | 命令执行风险高，必须限制命令集、超时和工作目录 |
| `repo_create_pull_request` | 不开放 | 需要 GitHub 权限、分支策略、PR 模板和失败回滚 |
| `kb_apply` | 不开放 | 会写正式知识库，必须人工审批和乐观并发校验 |
| `kb_reject` | 不开放给默认只读 | 只应由草稿 owner 或审批人操作 |
| commit/main branch write | 禁止 | 写入必须先走 draft/diff/PR，不能直写 main |

## 试用分层

| 层级 | 目标 | 可用工具 | 验收重点 |
| --- | --- | --- | --- |
| W0 只读基线 | 保持当前商业级最小可用 | `kb_list/search/read`、repo readonly、trace/export | 不回退 P4-2 provider one-cycle |
| W1 KB draft 试写 | Agent 只生成草稿，不写正式知识库 | `kb_draft_create/read/list/discard`、`kb_diff` | 原文不变，diff 可读，discard 可用 |
| W2 KB apply 灰度 | 人工审批后应用一条知识库草稿 | `kb_apply`、`kb_reject` | `approvalId` 必填，hash 冲突拒绝，事件可复盘 |
| W3 代码小改动灰度 | 在受控分支写一个小文件并生成 diff | `repo_write_file`、受限 `repo_run_command` | 仅 `code-writable-confirm` 暴露，默认只读拒绝 |
| W4 PR 灰度 | 从受控分支创建 PR，不自动 merge | `repo_create_pull_request` | PR 链接、diff、测试输出进入 artifacts |
| W5 commit/apply 扩展 | 后续阶段评估 | 暂不开放 | 需要组织权限、回滚自动化和审计策略 |

## 进入条件

| 条件 | 必须满足 |
| --- | --- |
| 分支策略 | 只允许在受控 trial branch 写入，禁止 main 直写 |
| 用户权限 | session user 必须拥有目标 repo/KB 权限 |
| profile | 代码写入必须显式选择 `code-writable-confirm` |
| approval | `kb_apply`、代码写工具、PR 创建必须有 MAP approval |
| diff | 写入前后必须产出 unified diff 或等价 artifact |
| trace | 必须有 `sessionId`、`traceId`、tool event、approval event |
| rollback | 必须能通过 draft、previousHash、branch diff 或 revert 操作恢复 |
| timeout | 写入和命令执行必须有明确 timeout，不允许无限等待 |

## 审批门禁

| 工具 | 风险 | 审批要求 | 自动拒绝条件 |
| --- | --- | --- | --- |
| `kb_draft_create` | draft write | 可自动，仅写草稿集合 | 无 session user、无 KB 读权限、内容为空 |
| `kb_diff` | readonly | 不需要 | draft 不存在或无权限 |
| `kb_apply` | formal KB write | 必须 MAP approval | 缺 `approvalId`、非 owner、`baseContentHash/baseUpdatedAt` 冲突 |
| `kb_reject` | draft state change | 需要 draft owner 权限 | draft 非 active、无权限 |
| `repo_write_file` | code write | 必须 MAP approval + `code-writable-confirm` | 默认只读、无 profile、路径越界 |
| `repo_run_command` | command execution | 必须 MAP approval + 命令白名单 | 默认只读、危险命令、超时、工作目录越界 |
| `repo_create_pull_request` | external write | 必须 MAP approval + GitHub 权限 | 无 diff、无 branch、无 token、PR 创建失败 |

## 差异与产物要求

| 写入类型 | 必须产物 |
| --- | --- |
| KB draft | draftId、entryId、base hash、草稿内容摘要 |
| KB diff | unifiedDiff、added/removed、source entry hash |
| KB apply | approvalId、previousHash、newHash、apply event、trace bundle |
| 代码写入 | branch/ref、changed files、unified diff、tool call event |
| 命令执行 | command、cwd、exit code、stdout/stderr 摘要、timeout 信息 |
| PR 创建 | PR URL、source branch、target branch、diff summary、审批记录 |

## 回滚策略

| 场景 | 回滚方式 |
| --- | --- |
| KB draft 不满意 | `kb_reject` 或 `kb_draft_discard`，正式知识库不变 |
| KB apply 后发现问题 | 用 `previousHash`、draft 内容和 trace 手动恢复；后续阶段再做自动 rollback |
| 代码写入不满意 | 丢弃 trial branch 或 revert 生成的 commit/diff |
| 命令执行失败 | 保留 stdout/stderr artifact，不继续 PR 创建 |
| PR 创建失败 | 保留 branch 和 diff artifact，不重复创建无证据 PR |
| approval 超时 | 工作流进入 `timed_out`，不继续写入 |

## 试用验收命令

| 类型 | 命令 |
| --- | --- |
| writable profile 边界 | `bash scripts/smoke-cds-agent-writable-profile.sh` |
| KB draft workspace | `bash scripts/smoke-cds-agent-kb-draft-workspace.sh` |
| KB diff/apply/reject | `bash scripts/smoke-cds-agent-kb-diff-apply.sh` |
| workflow approval | `bash scripts/smoke-cds-agent-workflow-approval.sh` |
| simple panel 回归 | `bash scripts/smoke-cds-agent-simple-panel.sh` |
| workflow node 回归 | `bash scripts/smoke-cds-agent-workflow-node.sh` |
| 后端聚焦测试 | `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter "FullyQualifiedName~AgentToolsTests|FullyQualifiedName~WorkflowAgentTests|FullyQualifiedName~InfraAgentSessionServiceRuntimeAdapterTests" --no-restore` |
| 前端类型/构建 | `pnpm --prefix prd-admin tsc` / `pnpm --prefix prd-admin build` |

远端 provider one-cycle 只在写入试用影响 runtime/profile/SDK adapter 时重跑；如果只是文档、审批策略或本地工具 UI，不需要重复 provider 调用。

## 用户协助点

| 事项 | 是否需要用户 | 原因 |
| --- | --- | --- |
| 是否进入写入试用 | 需要 | 写入能力会改变风险等级 |
| 试用仓库/分支 | 需要 | 必须指定可写 trial branch，禁止误写 main |
| 试用知识库 | 需要 | 必须确认可写 KB 和 owner |
| GitHub/PR 权限 | 需要时 | PR 创建需要目标 repo 授权 |
| provider key/profile | 不需要新增 | 只读 provider path 已通过，除非用户切换模型或 profile |

## 推荐下一阶段

建议先做 W1/W2：KB draft + 人工审批 apply 灰度。原因是 KB 写入已有 draft/diff/apply 本地闭环，回滚边界比代码 PR 更清晰，适合作为第一个写入试用点。

代码写入和 PR 建议放在 W3/W4，必须先确认 trial repo、trial branch、PR target、命令白名单和回滚方式。

## Phase 4 收口结论

Phase 4 的发布/试用收口完成：远端只读试用入口可用，provider-backed one-cycle 通过，试用说明、发布/合并策略和写入能力后续试用计划均已归档。下一阶段应由用户决定：继续 preview 试用、先合入 main 跑门禁，或进入 W1/W2 写入灰度。
