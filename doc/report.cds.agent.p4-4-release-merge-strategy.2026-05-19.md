# CDS Agent P4-4 发布/合并策略评估报告

日期：2026-05-19

## 结论

P4-4 完成。当前分支 `codex/cds-agent-workbench-ui` 可以作为远端 preview 继续试用；不建议直接合并到 main 后发布。推荐路径是先在当前分支吸收 `origin/main` 的 18 个新提交，完成本地门禁和一次 preview 验收，再由用户确认是否合并 main。

本次评估没有执行合并、没有部署、没有改运行时代码。评估结论基于当前 git 状态、`origin/main` 最新状态、差异规模和一次 dry-run merge-tree。

## 当前分支状态

| 项 | 当前值 |
| --- | --- |
| 当前分支 | `codex/cds-agent-workbench-ui` |
| 当前 HEAD | `def3c1407` |
| origin/main | `57165f373` |
| merge base | `4f59b1108` |
| ahead / behind | `421 / 18` |
| dry-run merge-tree | pass，生成 tree `c3f9f6416e721309cb1420368d8a854529e89ca2` |
| 当前 preview | `https://cds-agent-workbench-ui-codex-prd-agent.miduo.org/cds-agent` |
| 已验收 runtime commit | `6b2f1552e` |

## main 新增 18 个提交

| 范围 | 代表提交 | 影响 |
| --- | --- | --- |
| marketplace 分享与详情弹窗 | `5912c9f7a`、`7297510b1`、`2e4b312ec`、`78a8d6152`、`5d88e3eac` | 新增 marketplace share link、token index、文件预览、详情弹窗和竞态修复 |
| emergence 页面稳定性 | `2aa4295d2`、`87b7e92bf`、`c283cb89f`、`207a4e760`、`a84cfd3a1`、`286c4bcb4` | 涌现首页/画布重构、停止/出错/渐显生命周期修复 |
| CDS 发布稳定性 | `6342976b4`、`a444cf042` | admin 就绪超时从 600s 调到 1200s，新增 compose secrets 债务说明 |
| changelog/归档 | `57165f373` | CDS changelog 入库 |

这些提交不是 CDS Agent 主功能，但会影响同一个前端工程、API 工程和 CDS 发布路径。合并后必须跑全局前端/后端/CDS 基础门禁。

## 当前分支改动规模

| 类别 | 影响 |
| --- | --- |
| CDS runtime/control plane | `cds/src/routes/remote-hosts.ts`、runtime pool、managed runtime、SSE ingest、profile gates、self-update/preflight 脚本 |
| official SDK adapter | `claude-sdk-sidecar` official SDK adapter、workspace、event mapping、tool surface、provider-switch |
| MAP API | `InfraAgentSessionsController`、runtime profile、workflow capsule、tool registry、KB readonly/draft/diff/apply、governance/SLA/schedule dashboards |
| MAP Admin | `CdsAgentPage.tsx` 简洁模式、可观测性、工作流/KB/治理/SLA 面板、视觉验收 |
| 文档和证据 | 商业级路线图、Phase 1-4 验收报告、视觉/PDF、smoke/runbook |
| 测试和脚本 | CDS Agent smoke、profile、runtime、KB、workflow、governance、one-cycle、视觉脚本 |

当前分支相对 main 改动 220 个文件，约 39550 insertions / 665 deletions。规模较大，不能把“无文本冲突”等同于“可直接发布”。

## 发布选项

| 选项 | 结论 | 风险 | 适用场景 |
| --- | --- | --- | --- |
| A. 继续 preview 试用 | 可行，短期最稳 | main 的 marketplace/emergence 修复未进入 preview 分支 | 需要继续让用户试 CDS Agent，只读巡检已可用 |
| B. 先把 `origin/main` 合入当前分支，再跑门禁和 preview | 推荐 | 需要一次集成验证；可能暴露语义冲突 | 准备进入 main 前的标准路径 |
| C. 当前分支直接合并 main | 不建议 | 分支体量大，主线同时有 marketplace/emergence 改动，语义风险未验证 | 仅在紧急发布且可接受快速回滚时考虑 |
| D. 拆分 CDS Agent 小 PR | 中长期更好，本轮不建议立即做 | 421 个提交拆分成本高，容易破坏已经通过的验收证据 | 后续产品稳定后做历史整理 |

## 推荐发布路径

1. 保持当前 preview 可试用，不做无意义重复部署。
2. 在 `codex/cds-agent-workbench-ui` 上合入 `origin/main`，生成一个集成提交。
3. 跑本地门禁：前端类型/构建、后端聚焦测试、CDS 测试、sidecar 测试、关键 smoke。
4. 如果运行时代码受合并影响，再执行一次关键 preview 部署和 P4 provider one-cycle。
5. 用户确认后再合并 main；未确认前不把 preview 分支视为正式发布。

## 合并前最后门禁

| 门禁 | 命令 | 发布要求 |
| --- | --- | --- |
| diff hygiene | `git diff --check` | 必须 pass |
| 前端类型检查 | `pnpm --prefix prd-admin tsc` | 必须 pass |
| 前端构建 | `pnpm --prefix prd-admin build` | 必须 pass |
| 前端关键单测 | `pnpm --prefix prd-admin test -- src/pages/cds-agent/__tests__/cdsAgentReadiness.test.ts` | 必须 pass |
| 后端 Agent 聚焦测试 | `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter "FullyQualifiedName~InfraAgentSessionServiceRuntimeAdapterTests|FullyQualifiedName~InfraAgentSessionsControllerTests|FullyQualifiedName~AgentToolsTests|FullyQualifiedName~WorkflowAgentTests" --no-restore` | 必须 pass |
| CDS runtime 测试 | `npm --prefix cds test -- --run tests/routes/remote-hosts-instances.test.ts` | 必须 pass |
| sidecar 测试 | `pytest claude-sdk-sidecar/tests` | 必须 pass |
| Phase 3 验收包 | `bash scripts/smoke-cds-agent-phase3-acceptance.sh` | 必须 pass |
| 简洁面板 smoke | `bash scripts/smoke-cds-agent-simple-panel.sh` | 必须 pass |
| 工作流 smoke | `bash scripts/smoke-cds-agent-workflow-node.sh` | 必须 pass |
| KB readonly smoke | `bash scripts/smoke-cds-agent-kb-readonly-tools.sh` | 必须 pass |
| 远端 provider one-cycle | `CDS_HOST=https://cds-agent-workbench-ui-codex-prd-agent.miduo.org SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 bash scripts/smoke-cds-agent-one-cycle.sh` | 只有合并后运行时代码或 profile 变动时必跑 |

## 回滚策略

| 场景 | 回滚方式 |
| --- | --- |
| 合入 main 后本地门禁失败 | 不推送或 revert 集成提交，继续停留在 `def3c1407` |
| preview 部署后失败 | 回退 preview 分支到上一验收提交，并用 P4-2/P4-3 报告确认可用路径 |
| main 合并后发现问题 | revert merge commit，保留 CDS Agent 证据包和 trace 用于定位 |
| provider 路径失效 | 不回滚产品代码，先看 R1 profile/provider 状态；只有代码变更导致才回滚 |

## P4-4 决策建议

推荐用户选择：先继续 preview 试用，同时批准一次“当前分支合入 origin/main 后跑门禁”的集成轮次。通过后再决定是否合并 main。

不推荐现在直接合并 main。原因不是发现了文本冲突，而是分支体量大、主线已有 marketplace/emergence/CDS 发布稳定性更新，必须先做语义集成和门禁复验。

## 下一步

P4-5：后续 writable/PR/KB apply 试用计划。P4-5 不应默认打开写入能力，只需要把代码写入、知识库 apply、PR、commit 的试用边界、审批门禁和失败回滚计划列清楚，等待用户确认是否进入写入试用。
