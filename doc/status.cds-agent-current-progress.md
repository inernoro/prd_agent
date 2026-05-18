# CDS Agent 当前进度面板

> **更新时间**：2026-05-19 03:10 Asia/Shanghai
> **分支**：`codex/cds-agent-workbench-ui`
> **当前阶段**：Phase 0 已完成，正在进入 Phase 1 商业级最小可用：简洁 Agent 面板、可观测性/超时、工作流最小调度、知识库只读接入。
> **权威入口**：`doc/design.cds-agent-commercial-architecture-and-roadmap.md`
> **总状态**：最小只读闭环已打通。MAP 保持控制面，CDS 管理 Claude SDK runtime/container/sandbox，默认 OpenRouter DeepSeek profile 可通过官方 Claude Agent SDK adapter 执行只读仓库巡检。下一步不是继续修 runtime 基线，而是把使用入口、工作流和知识库接入打磨到商业可用。

## 0. 当前执行面板

| 项 | 当前结论 |
| --- | --- |
| 总进度 | Phase 0 基线 100%；商业级整体按三期推进，当前进入 Phase 1 |
| 当前 gate | `P1_SIMPLE_AGENT_PANEL + P1_WORKFLOW_MIN_NODE + P1_KB_READONLY` |
| 当前 blocker | 无需用户输入的 blocker。需要开发的是简洁模式页面、统一超时/可观测字段、`CdsAgentRun` 工作流节点、KnowledgeBase 只读工具 |
| 需要用户协助 | 当前不需要。只有当知识库权限模型或目标示例空间无法从本地上下文确认时，才需要你指定一个示例知识库 |
| 不需要用户协助 | 不需要补 `CDS_REMOTE_HOST_*`、SSH 私钥、sidecar image 作为产品主路径 |
| 本轮下一步 | 按新权威入口进入 Phase 1：先实现简洁 Agent 面板和可观测性/超时，再接最小工作流节点和知识库只读工具 |
| 预计结束 | Phase 1 预计 5-7 个工作日；第一个可视化页面迭代预计 0.5-1 天内完成本地验收 |
| 是否该 redeploy preview | 当前不需要。先做本地单测、smoke 和视觉测试；只有关键门通过后再部署 |
| 当前权威证据 | one-cycle `/tmp/cds-agent-cycle-hardened-current/cycle-summary.json`：`commercialComplete=true`、7/7 gates pass、10 pass / 1 legacy skip / 0 failed、总 161s；S1/S2/S3/V1 单项证据仍保留 |

如需复跑完整周期，使用现有 CDS-managed provider profile，不需要把 key 发到聊天里：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1 \
  bash scripts/smoke-cds-agent-one-cycle.sh
```

## 1. 架构纠偏声明

当前最终目标固定为：

```text
MAP 只连接 CDS。
CDS 作为容器管理器、分支管理器、runtime/sandbox 管理器接管 Claude SDK Agent。
Claude SDK Agent 是 CDS-managed runtime/container/sandbox。
SSH、remote host、sidecar image、env 只能作为 CDS operator/debug fallback，不能作为普通用户主路径。
```

因此，本文档此前把“提供 `CDS_REMOTE_HOST_*`、SSH 私钥、`CDS_AGENT_SIDECAR_IMAGE`”写成当前下一步，是实现层泄漏。新的有限纠偏计划见：

```text
doc/plan.cds-agent-runtime-correction-limited.md
doc/design.cds-agent-managed-runtime-fact-source.md
```

## 2. Phase 0 基线总览

| 顺序 | 阶段 | 状态 | 剩余时间 |
| --- | --- | --- | --- |
| 1 | A0 官方 SDK adapter 边界 | done | 0 |
| 2 | N6 其他智能体兼容性 | done | 0 |
| 3 | D1 架构纠偏计划 | done | 0 |
| 4 | R0 CDS-managed runtime/container/sandbox | done_live | 0 |
| 5 | R1 Claude Code provider-switch profile 修正 | done_live | 0 |
| 6 | S1 provider read-only run | done_live | 0 |
| 7 | S2/S3 hardened controls、stop/cancel | done_live | 0 |
| 8 | V1 live visual acceptance + 文档归档 | done_live | 0 |

Phase 0 的职责是证明“CDS-managed official SDK 只读闭环可跑、可停、默认不暴露危险工具”。它已经完成。Phase 1 的职责不是继续兜 runtime 基线，而是把普通用户入口、工作流调度和知识库只读接入做成可用产品。

## 3. Gate 状态

| Gate | 状态 | 证据 | 结论 |
| --- | --- | --- | --- |
| A0 | pass | official SDK adapter boundary smoke | 自研 loop 已压缩为 adapter/bridge/policy/audit/UI 层 |
| R0 | pass | `/tmp/cds-agent-runtime-live-apply-current.json`、`/tmp/cds-agent-runtime-pool-evidence-after-capacity-latest/summary.json` | CDS-managed official SDK runtime running > 0 |
| R1 | pass_live | 默认 profile `OpenRouter DeepSeek V4 Pro · Claude Code`：runtime `claude-sdk`、protocol `anthropic`、baseUrl `https://openrouter.ai/api`、model `deepseek/deepseek-v4-pro`、hasApiKey true | 不需要 Anthropic 原生认证；按 Claude Code/OpenRouter Anthropic-compatible 路径运行 |
| S1 | pass_live | `/tmp/cds-agent-s1-provider-hardened.json` | provider-backed 只读仓库巡检通过；assistantMessages=1，dangerousApprovals=0，dangerousBuiltinTools=0 |
| S2/S3 | pass_live | `/tmp/cds-agent-controls-hardened.json` | 默认 hardened-readonly 不进入危险审批/执行；S3 stop 返回 `stopped` |
| V1 | pass_live | `/tmp/cds-agent-workbench-visual.png`、`/tmp/cds-agent-workbench-visual.coverage.json` | 远端工作台页面可达并通过文本/截图断言 |
| N6 | pass | `/tmp/cds-agent-n6-non-code-compatibility-current.json` | 非代码 Agent 不被 Claude SDK runtime path 误接管 |

## 4. 当前需要协助

当前不需要你继续补 env、SSH 私钥或 image 作为产品主路径。你已提供的：

```text
ssh root@62.146.168.225
```

只作为 CDS operator/debug fallback 的可用资源线索记录，不作为 MAP/CDS/Agent 的主架构。

当前不需要你把 Anthropic/Claude secret 发给我。目标路径已按你的澄清校准为：Claude Code 云端运行体验 + cc-switch/DeepSeek provider secret。它仍然可以是 `claude-sdk` runtime，但 profile 必须表达为 Anthropic-compatible upstream；只有原生 `https://api.anthropic.com` 才要求 `sk-ant`。

## 5. 最关键文档

当前先看这些：

- `doc/design.cds-agent-commercial-architecture-and-roadmap.md`：当前权威入口，定义商业级总目标、能力边界、架构图、一期/二期/三期和验收门。
- `doc/plan.cds-agent-runtime-correction-limited.md`：D1 有限纠偏计划、任务数、ETA、smoke、视觉测试触发条件。
- `doc/design.cds-agent-managed-runtime-fact-source.md`：R0 CDS-managed runtime fact source、最小开发计划、smoke 和视觉触发条件。
- `doc/status.cds-agent-current-progress.md`：当前项目级进度、剩余步骤、当前 blocker、下一步。
- `doc/report.cds-agent-execution-ledger-2026-05-18.md`：执行账本，记录做过什么、耗时、哪里兜圈、如何避免再兜圈。

## 6. 一句话进度

`prd-agent` 主系统已经不再被 `claude-agent-sdk-runtime-v2` 侵入。D1 架构口径已纠正，R0 fact-source 设计已落地，runtime-status 执行面板已从 remote host/image 主路径改成 CDS-managed runtime 主路径。CDS `/agent-sessions` 非 fake 路径已加 ownership guard，并能通过 shared-service branch service transport 调用 official SDK sidecar 协议；MAP Toolbox adapter 也已收回到 CDS session transport，默认不再排 MAP direct runtime job。R0.5/R0.6/R0.7/R1/S1/S2/S3/V1 已闭合。下一步进入 Phase 1：简洁 Agent 面板、统一可观测性/超时、`CdsAgentRun` 工作流节点、KnowledgeBase 只读工具。

当前有效 gate 记录：

| Gate | 状态 | 说明 |
| --- | --- | --- |
| `BRANCH_LOCAL_SIDECAR_CLEAN` | pass | 远程 branch services 污染数 `4 -> 0` |
| `CDS_MANAGED_RUNTIME_MODEL` | pass | 主路径必须是 CDS-managed runtime/container/sandbox |
| `REMOTE_HOST_ENV_AS_PRODUCT_PATH` | rejected | SSH、remote host、image、env 只能是 operator/debug fallback |
| `R0_FACT_SOURCE` | designed | `doc/design.cds-agent-managed-runtime-fact-source.md` 已定义新 gate；runtime-status execution panel 已指向它 |
| `CDS_AGENT_SESSION_EXECUTION_OWNED_BY_CDS` | pass_guarded | CDS `/agent-sessions` 非 fake runtime 不再返回“delegated to MAP sidecar bridge”；runtime 缺失时由 CDS 返回 `cds_managed_runtime_unavailable` |
| `CDS_MANAGED_RUNTIME_TRANSPORT` | pass_minimal | CDS `/agent-sessions` 可发现 shared-service branch runtime 并投递 `/v1/agent/run`，事件写回 `runtime_init/text_delta/done` |
| `MAP_TO_CDS_SESSION_TRANSPORT` | pass_smoke | MAP Toolbox adapter 不注入 direct runtime adapter；session message 先走 CDS `/agent-sessions/{id}/messages`，MAP direct runtime queue 只在显式 fallback env 下启用 |
| `R0V_MANAGED_RUNTIME_POSTCHECK` | done | live evidence 显示 branch isolation clean，CDS-managed runtime capacity available |
| `CDS_MANAGED_RUNTIME_CAPACITY` | pass_live | `/tmp/cds-agent-runtime-live-apply-current.json` 与 `/tmp/cds-agent-runtime-pool-evidence-after-capacity-latest/summary.json` 显示 `runningOfficialSdkRuntimeCount=1` |
| `R1_PROVIDER_PROFILE` | pass_live | 默认 profile `OpenRouter DeepSeek V4 Pro · Claude Code` 已按 Anthropic-compatible upstream 通过，不需要 Anthropic 原生 secret |
| `ONE_CYCLE_FACT_SOURCE` | pass_live | `/tmp/cds-agent-cycle-hardened-current/cycle-summary.json` 显示 `commercialComplete=true`、7/7 gates pass、10 pass / 1 legacy skip / 0 failed |
| `SIDECAR_BUILD_CONTEXT` | pass | `claude-sdk-sidecar` Dockerfile/requirements/app/healthz/readyz/official SDK dependency 本地预检通过 |
| `SIDECAR_LOCAL_BUILD` | pass | Colima broken instance 已清理并重启；`prd-agent/claude-sidecar:latest` 本地 Docker build 通过 |
| `SIDECAR_REGISTRY_PUBLISH` | ready | registry-qualified candidate 已确定；本地 tag 已创建，外部 push 尚未执行；也可直接提供其他可 pull registry image |
| `SIDECAR_LOCAL_REGISTRY_TAG` | pass | 历史候选 tag 已本地创建；当前 HEAD 候选以 `scripts/refresh-cds-agent-r0-status.sh` 输出的 `candidateSidecarImage` 为准；`pushAttempted=false` |
| `SIDECAR_MANUAL_CI_PUBLISH` | optional | `.github/workflows/cds-sidecar-image.yml` 是 GHCR 候选路径；如果已有可 pull image 可跳过 |
| `SIDECAR_REGISTRY_MANIFEST` | not checked | 发布完成后先用只读 registry manifest 检查确认 image tag 可见，再 SSH 到 remote host |
| `REMOTE_HOST_PULL` | operator_fallback_only | 只作为 fallback 诊断门禁；不再作为产品主路径 blocker |

固定查看入口：

```bash
scripts/refresh-cds-agent-r0-status.sh
scripts/print-cds-agent-current-progress.sh
scripts/print-cds-agent-lifecycle-overview.sh
scripts/check-cds-agent-progress-consistency.sh
```

这些命令只读，不部署、不写远程、不输出 secret。它们仍可用于复查 Phase 0 runtime/profile 事实源；Phase 1 需要新增或更新面板、工作流、知识库相关 smoke，避免继续只围绕 R0/R1 打转。

## 7. 阶段总览

Phase 0 生命周期不是“做页面”一个阶段，而是 8 个 gate：

```text
A0 adapter 边界 -> R0 runtime pool -> R1 Claude Code provider-switch profile -> S1 read-only ->
S2 approval -> S3 cancel/error -> V1 visual/live page -> Release hardening
```

当前实际位置：A0、N6、D1、R0、R1、S1、S2、S3、V1 均已闭合。新的工作面是 Phase 1 产品化：简洁面板、可观测性/超时、工作流最小调度、知识库只读接入。

| 阶段 | 开发 | 证据 | 状态 | 下一步 |
| --- | --- | --- | --- | --- |
| A0 官方 SDK adapter 边界 | [x] | `smoke-cds-agent-official-sdk-boundary.sh`、helper tests | 已完成 | 保持 legacy loop 只作显式 fallback |
| R0.1 业务分支去污染 | [x] | `/tmp/cds-agent-branch-isolation-repair-apply-current/summary.json` | 已完成 | 防回归 |
| D1 架构纠偏 | [x] | `doc/plan.cds-agent-runtime-correction-limited.md` | 已完成 | 作为 R0 设计边界 |
| R0 CDS-managed runtime pool | [x] | `doc/design.cds-agent-managed-runtime-fact-source.md`、runtime-status task board、CDS route test、MAP session transport smoke、R0V/R0.7 live evidence、R0.5 capacity smoke、CDS runtime-capacity/reconcile/liveApply route test | pass_live | 防回归 |
| R1 Claude Code provider-switch profile | [x] | runtime-status profile diagnostics + sidecar upstream resolver | pass_live | 防回归 |
| S1/S2/S3 one-cycle | [x] | `/tmp/cds-agent-cycle-hardened-current/cycle-summary.json` | pass_live | 防回归 |
| V1 视觉验证 | [x] | `/tmp/cds-agent-workbench-visual.png` | pass_live | Phase 1 页面改动后重跑视觉测试 |
| N6 非代码智能体兼容 | [x] | `/tmp/cds-agent-n6-non-code-compatibility-current.json` | 已完成 | 新 adapter 接入前复跑 |

## 8. 当前 Phase 0 看板

| 项 | 当前值 | 证据 |
| --- | --- | --- |
| app project | `prd-agent` | CDS branch/project list |
| shared pool | `shared-sidecar-pool-mp4anabh` | `project.kind=shared-service` |
| app services | `api-prd-agent`, `admin-prd-agent` | `/tmp/cds-branch-status-final.json` |
| sidecar contamination | `0` | `/tmp/cds-agent-branch-list-after-delete.json` |
| architecture correction | `done` | `doc/plan.cds-agent-runtime-correction-limited.md` |
| CDS-managed runtime model | `required` | 本轮最终目标 |
| operator fallback resource | `ssh root@62.146.168.225` | 用户提供，仅作为 fallback 线索 |
| legacy remote-host/env path | `rejected_as_product_path` | 本轮纠偏声明 |
| should redeploy preview? | no | 当前是产品页面和接入设计开发，先本地验收再部署 |
| old sidecar image/registry checks | `operator_fallback_only` | 不再作为产品主下一步 |

## 9. 下一步最小计划

下一轮进入 Phase 1，不做普通 preview redeploy，不把 SSH/env/image 重新提升为产品路径，也不把 DeepSeek/cc-switch 错写成 Anthropic 原生认证必需项。完整商业级计划见 `doc/design.cds-agent-commercial-architecture-and-roadmap.md`。

| 顺序 | 动作 | 需要输入 | 成功证据 |
| --- | --- | --- | --- |
| 1 | 盘点现有 Agent 页面组件和事件 API | 无新增输入 | 明确可复用组件、缺失字段和改动文件 |
| 2 | 实现简洁模式信息架构 | 无新增输入 | 首屏只保留目标、任务、运行、停止、状态、结果 |
| 3 | 统一 timeline、timeout、stop 展示 | 无新增输入 | 页面显示 traceId、状态、耗时、timeoutAt、lastEventSeq |
| 4 | 本地 smoke + 视觉测试 | 无新增输入 | 截图证明无错位，smoke 证明状态链路可用 |
| 5 | 设计/实现 `CdsAgentRun` 最小 workflow node | 仅在 workflow API 缺扩展点时需要确认 | Start -> Agent -> Notify 可跑通 |
| 6 | 接入 KnowledgeBase 只读工具 | 仅在找不到示例知识库时需要你指定 | `kb_list/search/read` 可被 Agent 调用并显示来源 |

## 10. 已完成清单

| 完成项 | 证据 |
| --- | --- |
| 删除远程 `claude-agent-sdk-runtime-v2-prd-agent` 污染 | `/tmp/cds-agent-branch-isolation-repair-apply-current/summary.json`，`afterContaminatedBranchCount=0` |
| 直接复查业务服务只剩 api/admin | `/tmp/cds-agent-project-list-after-delete.json` |
| execution panel 展示 branch cleanup manifest | `InfraAgentSessionsControllerTests` 18/18 |
| execution panel 展示 remote host recovery manifest | `remote-host-prepare` runbook `applyManifest` |
| 前端 bundle 支持 manifest 渲染 | `/tmp/cds-agent-runbook-published/summary.json` |
| remote host dry-run 输出两阶段 recovery manifest | `/tmp/cds-agent-remote-host-pool-manifest-current/summary.json` |
| 过程账本落地 | `doc/report.cds-agent-execution-ledger-2026-05-18.md` |
| CDS route ownership guard | `cds/tests/routes/remote-hosts-instances.test.ts` 3/3 |
| MAP session transport smoke | `scripts/smoke-cds-agent-map-session-transport.sh` |
| R0V live evidence | `/tmp/cds-agent-runtime-pool-evidence-latest/summary.json` |
| R0.5 capacity smoke | `scripts/smoke-cds-agent-managed-runtime-capacity.sh` |
| CDS runtime capacity contract | `GET /api/projects/:id/runtime-capacity`、`cds/tests/routes/remote-hosts-instances.test.ts` |

## 11. 最新证据

| 证据 | 路径 | 结论 | 耗时 |
| --- | --- | --- | --- |
| branch isolation apply | `/tmp/cds-agent-branch-isolation-repair-apply-current/summary.json` | `applied-clean` | 40s |
| runtime pool evidence | `/tmp/cds-agent-runtime-pool-evidence-latest/summary.json` | branch clean，remote host/shared runtime missing | 12s |
| remote host recovery dry-run | `/tmp/cds-agent-remote-host-pool-manifest-current/summary.json` | `dry-run-missing-config` | 14s |
| runbook publish verification | `/tmp/cds-agent-runbook-published/summary.json` | bundle has `applyManifest/preconditions` rendering | ~35s |
| CDS branch status | `/tmp/cds-branch-status-final.json` | preview running, services only api/admin | ~1s |
| goal audit summary fast | `/tmp/cds-agent-goal-audit-summary-fast.json` | `status=blocked_r0`，next plan=`D1/R0.3/R0.4/R0V` | 10-12s |
| N6 no-build test | terminal output | 27/27 pass outside sandbox socket restriction | 64ms |
| remote host prepare fixture | `/tmp/cds-agent-remote-host-existing-report.json` | existing enabled host 可复用，`missingConfig=[]` | <1s |
| remote host deploy fixture | `/tmp/cds-agent-remote-host-existing-deploy-missing-image-report.json` | existing host 部署路径只缺 `CDS_AGENT_SIDECAR_IMAGE` | <1s |
| remote host live dry-run | `/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json` | 远程 `enabledHostCount=0`、`sharedRunning=0`、缺 host SSH 参数 | 18s |
| unavailable verdict fixture | `/tmp/cds-agent-remote-host-pool-current-readonly-unavailable-fixed/summary.json` | DNS/auth 证据不可用时输出 `evidence-unavailable`，不再误报 branch contamination | <1s |
| remote host invalid fixture | `/tmp/cds-agent-remote-host-invalid-report.json` | host URL、SSH port、private key 格式错误会进入 `invalid_config` | <1s |
| execution panel preflight manifest | `InfraAgentSessionsControllerTests`、`pnpm --prefix prd-admin tsc` | 页面可显示 local preflight 命令和 `preflightReady/invalidConfig` 报告字段 | 18/18 + tsc |
| remote host handoff | `/tmp/cds-agent-remote-host-handoff.md` | 从 dry-run summary 生成不含私钥的 apply/deploy/post-check 命令 | <1s |
| current progress board | `scripts/print-cds-agent-current-progress.sh` | 1 秒内输出当前 gate、R0 blocker、下一步和 ETA | <1s |
| runtime-status task board | `/api/infra-agent-sessions/runtime-status` -> `executionPanel.taskBoard` | 页面执行面板可直接展示阶段、状态、下一步和 ETA | controller tests 18/18 + tsc |
| N6 current smoke summary | `/tmp/cds-agent-n6-non-code-compatibility-current.json` | 非代码 Toolbox agents 独立于 CDS sidecar pool；候选官方 SDK 仍 planned-not-routable | 27/27 pass, 3s |
| R0 local apply readiness | `/tmp/cds-agent-r0-apply-readiness-current.json` | 本机尚不能进入 R0 apply/deploy；缺 remote host SSH 参数和 `CDS_AGENT_SIDECAR_IMAGE`；同时展示 registry manifest 与 remote pull 是否匹配当前 image | <1s |
| R0 operator handoff bundle | `/tmp/cds-agent-r0-operator-handoff-current.md` | 聚合进度、readiness、缺失输入、ETA、安全命令；未发现 secret 泄露 | <2s |
| goal audit with readiness | `/tmp/cds-agent-goal-audit-current-with-readiness.json` | 历史 R0 readiness 审计；Phase 0 最终结论以后续 one-cycle hardened summary 为准 | 10-15s |
| lifecycle overview | `scripts/print-cds-agent-lifecycle-overview.sh` | 按完整目标输出生命周期、已完成、阻塞、剩余距离和关键路径；V1 标为 partial | <1s |
| sidecar image readiness | `/tmp/cds-agent-r0-apply-readiness-current.json`、`/tmp/cds-agent-r0-operator-handoff-current.md` | 明确 CDS remote deployer 只 `docker pull`，不是远程构建；`CDS_AGENT_SIDECAR_IMAGE` 仍缺 | <1s |
| sidecar image preflight | `/tmp/cds-agent-sidecar-image-preflight-current.json` | 本地 build context 通过；image 仍为 `missing_image`，远程 pullability 未证明 | <1s |
| sidecar image build smoke | `/tmp/cds-agent-sidecar-image-build-current.json` | 本地 Docker build 通过；未 push、未 deploy | 约 65s，含依赖安装 |
| sidecar image publish dry-run | `/tmp/cds-agent-sidecar-image-publish-current.json` | 默认不 push；可从当前 git remote/HEAD 推导 candidate image；仍可直接提供其他可 pull image | <1s |
| remote sidecar pull dry-run | `/tmp/cds-agent-remote-sidecar-pull-current.json` | 默认不 SSH；当前缺 image、host、ssh user、ssh key | <1s |
| progress board exact next step | `scripts/print-cds-agent-current-progress.sh` | 当前指向有限纠偏计划和 consistency check，不再指向补 `CDS_AGENT_SIDECAR_IMAGE` / remote host 参数 | <1s |
| local registry tag | `/tmp/cds-agent-sidecar-image-publish-current.json` | 本地 tag 已创建，未 push、未 deploy | <1s |
| manual CI publish workflow | `.github/workflows/cds-sidecar-image.yml` | 手动触发，默认 tag 为 commit SHA；不会随普通 push 自动发布 | local syntax/read |
| sidecar workflow status | `/tmp/cds-agent-sidecar-workflow-current.json` | 默认 dry-run；显式 `CDS_AGENT_WORKFLOW_CHECK=1` 后只读查询 GitHub Actions workflow/runs | <1s dry-run |
| sidecar publish handoff | `/tmp/cds-agent-sidecar-publish-handoff-current.md` | 输出 GitHub Actions 手动发布 URL、image tag、CLI 等价命令和本机 push 替代路径 | <1s |
| sidecar registry manifest verify | `/tmp/cds-agent-sidecar-registry-image-current.json` | 默认 dry-run；显式 `CDS_AGENT_SIDECAR_REGISTRY_VERIFY=1` 后只读查询 GHCR manifest | <1s dry-run |
| R0 status refresh bundle | `/tmp/cds-agent-r0-status-refresh-current.md` | 一键刷新当前 HEAD image、publish handoff、workflow dry-run/status、registry dry-run、readiness、operator handoff、lifecycle、progress board | <3s |
| progress consistency check | `scripts/check-cds-agent-progress-consistency.sh` | 断言 refresh、progress board、主进度文档对 R0 blocker、GHCR scope、Exact Next Step 的口径一致 | <3s |
| CDS route ownership test | `cds/tests/routes/remote-hosts-instances.test.ts` | 非 fake runtime message 由 CDS 返回 `cds_managed_runtime_unavailable`，不再委托 MAP sidecar bridge | 3/3，约 0.5s |
| CDS route transport test | `cds/tests/routes/remote-hosts-instances.test.ts` | 非 fake runtime message 经 CDS-managed branch service transport 投递 `/v1/agent/run`，事件含 `runtime_init` 与 `loopOwner=claude-agent-sdk` | 4/4，约 0.9s |
| MAP session transport smoke | `scripts/smoke-cds-agent-map-session-transport.sh` | MAP Toolbox adapter 不注入 `IInfraAgentRuntimeAdapter`；session message 先走 CDS；MAP direct runtime queue 只在 `INFRA_AGENT_ENABLE_MAP_DIRECT_RUNTIME_FALLBACK` 下启用 | <1s |
| R0V live evidence | `/tmp/cds-agent-runtime-pool-evidence-latest/summary.json` | branch isolation clean；`shared-sidecar-pool-mp4anabh` running=0；enabled remote host=0；脚本 nextAction 已改为 CDS-managed runtime capacity 缺失，不要求产品用户补 SSH/env/image | 17s |
| R0.5 capacity smoke | `scripts/smoke-cds-agent-managed-runtime-capacity.sh` | progress/audit/runtime-status 顶层显示 `CDS_MANAGED_RUNTIME_CAPACITY`；remote host/env/image 只在 legacy fallback | ~10-15s |
| CDS runtime capacity route | `cds/tests/routes/remote-hosts-instances.test.ts` | `/api/projects/:id/runtime-capacity` 区分 `product-runtime` 与 `operator-fallback`；official SDK runtime running 时 capacity=available | 5/5 pass |

## 8. 时间和问题账本

详细过程、问题、处理、耗时和优化记录在：

- `doc/report.cds-agent-execution-ledger-2026-05-18.md`

最耗时项：

| 项 | 耗时 | 后续优化 |
| --- | --- | --- |
| branch isolation cleanup wrapper | 40s | 远程写动作保留 wrapper，但完成后直接查 branch/project list，减少反复判断 |
| runbook publish verification | ~35s | 只在 UI 发布后跑；后端 manifest 内容用 controller tests 覆盖 |
| runtime pool evidence | 11-14s | 保留为 R0 权威远程证据，不用 one-cycle 替代 |
| goal audit summary | 11s | 日常看板读最近 R0 summary；只有刷新远程事实时才开 live |
| remote host prepare fixture | <1s | 本地模拟 API 响应，先验证参数判定，避免真实远程反复试 |
| remote host live dry-run | 18s | 只读远程证据；只有真实执行前或状态刷新时运行 |
| remote host invalid fixture | <1s | 本地校验参数格式，减少 apply 阶段才失败 |
| execution panel manifest tests | 约 8s 有效测试，沙箱内 dotnet 会因 socket 权限失败 | 需要 dotnet 时直接用已批准的沙箱外测试；前端 tsc 本地可跑 |
| remote host handoff | <1s | 参数给齐后直接按 handoff 执行，不再翻长文档 |
| runtime-status task board | 后端测试 15s，前端 tsc 20s | 页面事实源直接返回 taskBoard/nextStepEta/timeSinkAdvice，减少人工解释成本 |
| N6 current smoke | 3s 沙箱外；沙箱内 VSTest socket 权限失败 | N6 smoke 现在写 summary，进度面板优先读取最新 N6 结果，避免把 infra 权限误判成兼容失败 |
| R0 local apply readiness | <1s | 先本地判定 env/summary/image/registry manifest/remote pull 是否足够 apply，避免到远程写入阶段才失败 |
| R0 operator handoff bundle | <2s | 一个文件交接当前状态、缺失输入和安全执行命令，减少翻文档和聊天解释 |
| goal audit with readiness | 10-15s；N6 沙箱步骤可能因 VSTest socket 权限失败，但 canonical summary 校准为 pass | audit 读取 N6 summary、R0 readiness 和 D1 progress consistency，不再把 VSTest 权限问题当作兼容性失败 |
| lifecycle overview | <1s | 直接回答“整个生命周期到哪一步、离目标多远”，避免只看局部脚本输出 |
| sidecar image readiness | <1s | 本地 Dockerfile 只能给候选 build/push 命令；远程部署前必须提供可拉取镜像 tag |
| sidecar image preflight | <1s | 本地先拦截 Dockerfile/context/image 引用问题，避免 R0.3 到远程 `docker pull` 阶段才失败 |
| sidecar image build smoke | 约 65s 当前通过 | 把 Docker daemon / base image pull / Python dependency install 问题和 R0 远程 deploy 分开 |
| sidecar image publish dry-run | <1s | 显式拆出 registry tag/push 阶段，避免把本地 build pass 误认为 remote host pullable |
| sidecar registry manifest verify | <1s dry-run；真实 GHCR 查询通常 1-5s | 在 SSH 到 remote host 前先证明 image tag 在 registry 可见，减少远程排障面 |
| remote sidecar pull dry-run | <1s | 独立验证目标 host 是否可 pull image；不创建 CDS host、不运行 sidecar |
| dynamic exact next step | <1s | 不再固定跳到 remote-host handoff；先走当前最靠前的失败 gate |

## 9. 不要做的事

- 不要为了当前 blocker 重复普通 preview redeploy。
- 不要把 `claude-agent-sdk-runtime*` 写回 `prd-agent` compose services。
- 不要把 `CLAUDE_SIDECAR_BASE_URL` 指回 branch-local sidecar alias。
- 不要在 `REMOTE_HOST_AVAILABLE` 和 `SHARED_POOL_RUNNING` 未通过时跑 provider one-cycle。
- 不要把历史 preview alias 成功当作 shared-service runtime pool 恢复。

## 10. 当前命令

查看当前任务纵览：

```bash
scripts/refresh-cds-agent-r0-status.sh
scripts/print-cds-agent-current-progress.sh
```

查看完整生命周期：

```bash
scripts/print-cds-agent-lifecycle-overview.sh
```

本地检查 R0 apply/deploy 是否具备输入：

```bash
scripts/preflight-cds-agent-r0-apply-readiness.sh
```

本地检查 sidecar image 构建上下文和 image 引用：

```bash
scripts/preflight-cds-agent-sidecar-image.sh
```

本地尝试构建 sidecar image，不 push、不 deploy：

```bash
scripts/smoke-cds-agent-sidecar-image-build.sh
```

以下命令只保留为历史 operator/debug fallback 证据，不再是当前产品路径。普通用户路径应由 CDS-managed runtime/container/sandbox 接管 image/profile/host 细节；只有明确执行 fallback 恢复时才使用这些命令。

生成 sidecar image registry 发布 dry-run，不 push、不 deploy：

```bash
CDS_AGENT_SIDECAR_IMAGE=<registry>/<namespace>/claude-sidecar:<tag> \
  scripts/publish-cds-agent-sidecar-image.sh
```

真正 push 必须显式设置：

```bash
CDS_AGENT_SIDECAR_IMAGE=<registry>/<namespace>/claude-sidecar:<tag> \
CDS_AGENT_SIDECAR_IMAGE_PUSH=1 \
  scripts/publish-cds-agent-sidecar-image.sh
```

验证目标 remote host 能否 pull image，不创建 CDS host、不运行 sidecar：

```bash
CDS_AGENT_SIDECAR_IMAGE=<registry>/<namespace>/claude-sidecar:<tag> \
CDS_AGENT_SIDECAR_REGISTRY_VERIFY=1 \
  scripts/verify-cds-agent-sidecar-registry-image.sh
```

确认 registry manifest 可见后，再验证目标 remote host 能否 pull image：

```bash
CDS_AGENT_SIDECAR_IMAGE=<registry>/<namespace>/claude-sidecar:<tag> \
CDS_REMOTE_HOST_HOST=<host-or-ip-no-protocol> \
CDS_REMOTE_HOST_SSH_USER=<ssh-user> \
CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE=<private-key-file> \
CDS_AGENT_REMOTE_PULL_VERIFY=1 \
  scripts/verify-cds-agent-remote-sidecar-pull.sh
```

生成 R0 操作员交接包：

```bash
scripts/print-cds-agent-r0-operator-handoff.sh
```

只读刷新 R0 证据：

```bash
CDS_HOST=https://cds.miduo.org \
CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 \
  bash scripts/collect-cds-agent-runtime-pool-evidence.sh
```

用既有 R0 evidence 进行本地目标审计：

```bash
CDS_AGENT_GOAL_RUNTIME_POOL_SUMMARY=/tmp/cds-agent-runtime-pool-evidence-latest/summary.json \
CDS_AGENT_GOAL_AUDIT_LIVE=0 \
CDS_AGENT_GOAL_AUDIT_REPORT=/tmp/cds-agent-goal-audit-summary-fast.json \
  bash scripts/audit-cds-agent-goal.sh
```

该命令当前应输出：

```text
Cycle status: blocked_r0
Current blocking gate: R0
Next cycle plan: r0-cds-managed-runtime-live-apply state=cds-managed-runtime-live-capacity-missing items=D1,R0.3,R0.4,R0V,R0.5,R0.6,R0.7
```

只读刷新 remote host recovery manifest：

```bash
CDS_HOST=https://cds.miduo.org \
CDS_AGENT_REMOTE_HOST_POOL_RUN_DIR=/tmp/cds-agent-remote-host-pool-manifest-current \
  bash scripts/run-cds-agent-remote-host-pool-with-evidence.sh
```

历史 live dry-run 曾证明远程没有 enabled remote host；这只能说明 fallback recovery 还缺 operator 输入，不能再写成产品主下一步。

```text
CDS_REMOTE_HOST_NAME
CDS_REMOTE_HOST_HOST
CDS_REMOTE_HOST_SSH_USER
CDS_REMOTE_HOST_SSH_PRIVATE_KEY or CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE
CDS_AGENT_REMOTE_HOST_APPLY=1
```

创建 host 后再部署 shared runtime，需要：

```text
CDS_AGENT_REMOTE_HOST_DEPLOY_SIDECAR=1
CDS_AGENT_SIDECAR_IMAGE
```

注意：这些字段属于 legacy fallback deployer 的操作参数。纠偏后的产品路径不应要求用户提供 `CDS_AGENT_SIDECAR_IMAGE` 或 SSH 参数；CDS 应通过 managed runtime / BuildProfile / container profile 承担这些细节。

当前 workflow 状态：

```text
workflowStatus=workflow_file_on_branch_not_indexed
workflowFileVisible=true
workflowRun=none
```

这表示 `.github/workflows/cds-sidecar-image.yml` 已存在于 `codex/cds-agent-workbench-ui` 分支，但 GitHub Actions workflow API 不能 dispatch/list 它。它只是 GHCR 候选路径的问题，不是 R0 架构前提。当前最小下一步是执行 `doc/plan.cds-agent-runtime-correction-limited.md`，把 R0 fact source 从 remote-host/env handoff 收回到 CDS-managed runtime。

生成安全 handoff 命令：

```bash
scripts/print-cds-agent-remote-host-handoff.sh \
  /tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json
```

发布验证：

```bash
bash scripts/verify-cds-agent-runbook-published.sh
```
