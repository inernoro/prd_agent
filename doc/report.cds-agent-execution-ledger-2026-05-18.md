# CDS Agent 执行过程账本

> 日期：2026-05-18
> 范围：`codex/cds-agent-workbench-ui` 分支、远程 `prd-agent` preview、CDS Agent runtime pool 恢复
> 用途：回答“问题是什么、怎么处理、花了多久、下次怎么少花时间”。

## 当前结论

这份账本补的是此前缺失的执行过程视角。已有 `doc/status.cds-agent-current-progress.md` 记录当前状态和证据目录，但它偏结果；本文件专门记录过程问题、处理动作、耗时和优化。

截至 2026-05-18 18:08 Asia/Shanghai：

- 已解决：`prd-agent` branch-local `claude-agent-sdk-runtime-v2-prd-agent` 污染。
- 已解决：执行面板能展示 destructive cleanup 和 remote host/shared runtime recovery 的结构化 manifest。
- 已解决：发布验证能证明远程 bundle 支持 `applyManifest/preconditions` 渲染。
- 未解决：`REMOTE_HOST_AVAILABLE=missing`、`SHARED_POOL_RUNNING=missing`。

## 执行时间线

| 时间 | 问题 | 处理 | 证据 | 耗时 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 17:19 | 用户截图显示 `claude-agent-sdk-runtime-v2` 仍出现在 MAP 分支服务 | 只读查询 `branch list` 和 `project list`，确认是远程 CDS 存量 state，不是本地 compose 回退 | `/tmp/cds-agent-branch-list-latest.json`、`/tmp/cds-agent-project-list-latest.json` | 约 2s | 确认 4 个分支污染，`prd-agent.appServices` 包含 sidecar |
| 17:22 | 远程 BuildProfile/service residual 仍污染业务分支 | 经用户精确批准后运行 branch isolation evidence wrapper | `/tmp/cds-agent-branch-isolation-repair-apply-current/summary.json` | 40s | `beforeContaminatedBranchCount=4`、`afterContaminatedBranchCount=0` |
| 17:23 | 需要确认是否只是 wrapper 误判 | 直接查远程 branch list 和 project list | `/tmp/cds-agent-branch-list-after-delete.json`、`/tmp/cds-agent-project-list-after-delete.json` | 约 2s | 污染列表 `[]`，`prd-agent.appServices=api,admin` |
| 17:23 | 清理后 R0 是否恢复不清楚 | 运行 runtime pool evidence | `/tmp/cds-agent-runtime-pool-evidence-after-branch-clean/summary.json` | 11s | branch isolation clean；剩余 `REMOTE_HOST_AVAILABLE`、`SHARED_POOL_RUNNING` |
| 17:24 | 报告/进度仍写旧 contaminated 状态 | 更新状态面板和事故报告 | `doc/status.cds-agent-current-progress.md`、`doc/report.cds-agent-runtime-pool-contamination-2026-05-18.md` | 本地编辑 | 文档与远程证据对齐 |
| 17:25 | 页面执行面板只结构化 branch 删除，没有结构化 remote host 恢复 | 给 `remote-host-prepare` 增加后端 `applyManifest` | `InfraAgentSessionsControllerTests` | 后端测试 18/18，约数秒 | 页面可展示 remote host create / deploy sidecar 所需条件 |
| 17:31 | 远程是否发布了 manifest UI 不清楚 | 运行发布验证脚本 | `/tmp/cds-agent-runbook-published/summary.json` | 首轮约 35s | 发现脚本错误地要求后端常量出现在前端 bundle |
| 17:35 | 发布验证脚本误报 | 改为验证前端 bundle 的 `applyManifest/preconditions` 渲染能力，后端常量由控制器测试覆盖 | `/tmp/cds-agent-runbook-published/summary.json` | 约 35s | 发布验证通过，命中 `assets/index-D_MWXu97-local.js` |
| 17:38 | remote host dry-run 只列创建 host 缺参，没有列 deploy sidecar 缺参 | 给 `prepare-cds-agent-remote-host-pool.sh` 增加 `recoveryManifest.phases[]` | `/tmp/cds-agent-remote-host-pool-manifest-current/summary.json` | 14s | 机器可读列出 `remote_host_create` 和 `shared_runtime_deploy` 两阶段缺参 |
| 17:43 | 进度面板可读性不足，且远程构建状态需要复核 | 将 status 改成看板式第一屏，并刷新 CDS branch status 与 R0 evidence | `/tmp/cds-branch-status-latest-progress.json`、`/tmp/cds-agent-runtime-pool-evidence-latest/summary.json` | 约 13s | 远程拾取 `ffef7117`，服务仍只有 api/admin；R0 仍只缺 remote host/shared runtime |
| 17:46 | 用户反馈没有计划，文档仍可能让人误以为目标漂移 | 扫描 docs/audit，修正旧 `contaminated:4` 口径和“先清理 residual”的过期下一步 | quickstart、runbook、migration plan、adapter design、root-cause report、goal audit | 约 4m | 统一为 `BRANCH_LOCAL_SIDECAR_CLEAN=pass`，下一步只剩 remote host/shared runtime |
| 17:50 | 目标审计在无显式 live 输入时仍被环境变量带去查 `https://miduo.org`，并把旧 one-cycle R1 当当前 blocker | 改为 `CDS_AGENT_GOAL_AUDIT_LIVE=1` 才查远程；未观测 R0 时禁止把旧 R1 当当前结论 | `/tmp/cds-agent-goal-audit-fast.json` | 约 11s 快速审计 | 当前 blocker 回到 `R0 evidence not observed`，不会误导去修 R1 |
| 17:56 | N6 在目标审计中超时，需区分测试失败还是沙箱问题 | 先在沙箱内复现 `Permission denied`，再用已批准的 `dotnet test` 沙箱外跑 no-build 测试 | dotnet test 输出 | 64ms 测试执行；审计超时 62s | 27/27 pass；目标审计的 N6 是 infra/sandbox failure，不是业务回归 |
| 17:56 | 无 live 时只显示 R0 unknown 仍不够好，因为已有 `/tmp` R0 evidence 可用 | 让 goal audit 支持 `CDS_AGENT_GOAL_RUNTIME_POOL_SUMMARY`，直接消费 `/tmp/cds-agent-runtime-pool-evidence-latest/summary.json` | `/tmp/cds-agent-goal-audit-summary-fast.json` | 11s | `runtimePoolRecovery.source=summary`，当前 blocker 精确为 remote host/shared runtime |
| 18:00 | goal audit 已识别 R0 blocker，但 `executionPanel.status` 仍继承旧 one-cycle 的 `blocked_r1`，`nextCyclePlan` 仍指向 profile closure | R0 blocker 存在时覆盖 `cycle_status=blocked_r0`，并生成 `r0-runtime-pool-recovery` 计划 | `/tmp/cds-agent-goal-audit-summary-fast.json` | 11s | `status=blocked_r0`，plan items=`R0.2/R0.3/R0V` |
| 18:06 | remote host prepare 总是要求创建 host 参数，即使 CDS 已有 enabled host；这会阻塞“复用已有 host 部署 shared runtime”的路径 | 支持 `CDS_REMOTE_HOST_ID` 或第一个 enabled host 作为 target；已有 host 时不再要求 SSH 创建参数 | `/tmp/cds-agent-remote-host-existing-report.json`、`/tmp/cds-agent-remote-host-existing-deploy-missing-image-report.json` | <1s fixture | 复用 host 路径 `missingConfig=[]`；部署路径只缺 `CDS_AGENT_SIDECAR_IMAGE` |
| 18:08 | 沙箱内只读 live dry-run DNS 失败时，wrapper 把 `evidence-unavailable` 误判成 `blocked-branch-isolation` | 沙箱外重跑只读 dry-run确认真实远程状态；同时修 wrapper verdict 优先区分证据不可用 | `/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json`、`/tmp/cds-agent-remote-host-pool-current-readonly-unavailable-fixed/summary.json` | 18s live；<1s fixture | 远程真实缺 enabled host；网络/鉴权失败现在输出 `evidence-unavailable` |

## 本轮暴露的问题

### 1. 报告不是修复

问题：先前给出了根因报告，但没有执行远程存量清理，因此页面继续显示 `claude-agent-sdk-runtime-v2`。

处理：用户精确批准后，执行 remote state cleanup wrapper，并做直接远程复查。

优化：以后“报告”和“修复”必须分开标记。状态面板必须明确写：

- report-only
- dry-run
- apply executed
- post-check passed

### 2. 证据分散，用户看不到时间花在哪里

问题：证据散落在 `/tmp`、status 文档、聊天更新里，不形成过程账本。

处理：新增本文件，按时间线记录问题、动作、证据、耗时、结果。

优化：后续每个超过 30s 的动作必须至少落一条账本记录，尤其是远程查询、构建、视觉验证、provider smoke。

### 3. 不该重复 preview redeploy

问题：R0 blocker 是 remote host/shared pool 缺失，普通 preview deploy 不会创建 remote host，也不会恢复 shared runtime pool。

处理：执行面板和文档都标明 `do not redeploy for this state`，并把下一步收敛到 remote host recovery wrapper。

优化：只在以下情况部署：

- 代码变更需要发布到页面/API。
- 远程容器网络或鉴权修复需要新容器。
- 视觉证据需要看最新 UI。
- promotion/self update 被明确要求。

### 4. 发布验证脚本的验证对象错了

问题：脚本要求 `remote_host_create_then_shared_runtime_deploy`、`CDS_AGENT_SIDECAR_IMAGE` 出现在前端 bundle，但这些是后端 runtime-status 返回值，不应该在 JS bundle 里硬编码。

处理：脚本改为验证前端是否发布了 `applyManifest/preconditions` 渲染能力；后端具体 manifest 由 `InfraAgentSessionsControllerTests` 覆盖。

优化：发布验证按层拆分：

- 前端 bundle：验证渲染能力和 UI 标记。
- 后端测试/API：验证 runtime-status 内容。
- 远程 runtime evidence：验证 CDS state。

### 5. remote host 恢复报告缺第二阶段

问题：`prepare-cds-agent-remote-host-pool.sh` 在 `DEPLOY_SIDECAR=0` 时只列 host 创建缺参，没有清楚说明恢复 shared runtime 还缺 `CDS_AGENT_SIDECAR_IMAGE` 和 deploy flag。

处理：新增 `recoveryManifest.phases[]`：

- `remote_host_create`: `POST /api/cds-system/remote-hosts`
- `shared_runtime_deploy`: `POST /api/cds-system/remote-hosts/<hostId>/deploy-sidecar`

优化：以后每个远程写动作都必须有 manifest，包含 safety、method、endpoint、requiredEnv、missingEnv、expectedPostCheck。

### 6. 文档校准没有跟上远程修复

问题：branch-local sidecar 已经清理，但 quickstart、runbook、migration plan、adapter design 和 `scripts/audit-cds-agent-goal.sh` 仍保留 `contaminated:4` 或“先清理 residual”的旧下一步。用户看到这些文档时，会以为修复没有发生，或者计划仍停在旧目标。

处理：把当前权威状态统一为 `BRANCH_LOCAL_SIDECAR_CLEAN=pass`、`REMOTE_HOST_AVAILABLE=missing`、`SHARED_POOL_RUNNING=missing`，并让 goal audit 以后检查新的状态面板文案。

优化：每次远程写动作完成后，必须同步更新三类文档：当前状态、用户使用入口、目标审计脚本。不能只更新事故报告。

### 7. 目标审计把旧证据当当前事实

问题：本机环境变量里有 `CDS_HOST=https://miduo.org`，目标审计在没有明确要求 live 远程审计时仍尝试查询 CDS，导致 P0 计划失败；同时当 runtime pool 没有当前证据时，脚本会继续读取旧 one-cycle summary 的 R1 blocker，让执行方向看起来像“应该先修 profile”。

处理：新增 `CDS_AGENT_GOAL_AUDIT_LIVE=1` 显式开关。不开 live 时，P0 远程状态只标记 `not_observed`；如果 runtime pool 未观测，当前 blocker 固定为 R0 evidence，而不是继承旧 one-cycle R1。

优化：以后审计分两层：

- 本地 guardrail：A0、D0、N6、evidence index，可以无网络跑。
- live control-plane：R0 runtime pool、branch isolation、remote branch status，必须显式 `CDS_AGENT_GOAL_AUDIT_LIVE=1`。

### 8. N6 慢点不是业务失败

问题：目标审计中的 N6 dotnet 测试在沙箱内被 VSTest 本地 socket 限制拦住，表现为 `System.Net.Sockets.SocketException (13): Permission denied` 或超时。

处理：N6 脚本增加 `DOTNET_CLI_USE_MSBUILD_SERVER=0`、`MSBUILDDISABLENODEREUSE=1`、`-m:1 /nodeReuse:false`，减少 MSBuild server/node reuse 干扰；随后沙箱外复跑 no-build N6 测试通过。

证据：`dotnet test ... --no-build --filter 'FullyQualifiedName~CdsAgentRuntimeCompatibilityTests|FullyQualifiedName~InfraAgentRuntimeProfilesControllerTests'` 结果为 `27/27 pass`，测试执行 `64ms`。

优化：目标审计里 N6 `infra_failed` 不再等同于业务失败；需要用沙箱外 no-build 测试确认。

### 9. 无 live 审计也要能读已有 R0 证据

问题：即使禁止无意 live 查询，目标审计也不应该退化成 R0 unknown。当前目录里已有 `/tmp/cds-agent-runtime-pool-evidence-latest/summary.json`，它足以证明 branch cleanup 已干净、remote host 和 shared runtime 仍缺失。

处理：`scripts/audit-cds-agent-goal.sh` 新增 `CDS_AGENT_GOAL_RUNTIME_POOL_SUMMARY`。当 live plan 未运行但 summary 存在时，审计把 runtime pool recovery 标为 `source=summary`，并继承其中的 blockers。

证据：`/tmp/cds-agent-goal-audit-summary-fast.json` 显示 `runtimePoolRecovery.status=pass`、`source=summary`、`contaminatedBranchCount=0`、`REMOTE_HOST_AVAILABLE=missing`、`SHARED_POOL_RUNNING=missing`。

优化：以后日常进度面板优先走“本地 guardrail + 最近 R0 summary”，只有要刷新远程事实时才开 `CDS_AGENT_GOAL_AUDIT_LIVE=1`。

### 10. 审计状态和下一步计划不能继承旧 one-cycle

问题：即使 runtime pool blockers 已经来自最新 summary，`executionPanel.status` 仍沿用旧 one-cycle 的 `blocked_r1`，`nextCyclePlan` 仍是 provider/profile closure。这会让页面或人类读者误以为下一步应先修 R1。

处理：当 runtime pool plan 未观测或存在 blockers 时，goal audit 强制输出 R0 状态：

- `executionPanel.status=blocked_r0`
- `currentBlockingGate=R0`
- `nextCyclePlan.cycle=r0-runtime-pool-recovery`
- plan items 为 `R0.2` enabled remote host、`R0.3` shared runtime deploy、`R0V` evidence refresh。

证据：`/tmp/cds-agent-goal-audit-summary-fast.json` 当前输出 `Next cycle plan: r0-runtime-pool-recovery state=runtime-pool-blocked items=R0.2,R0.3,R0V`。

优化：旧 one-cycle 只作为历史 provider/profile 证据，不再决定当前执行面板的顶层状态。

### 11. remote host prepare 不应强制创建新 host

问题：恢复 R0 时可能已经存在 enabled remote host，但旧脚本仍强制要求 `CDS_REMOTE_HOST_NAME`、`CDS_REMOTE_HOST_HOST`、`CDS_REMOTE_HOST_SSH_USER` 和 SSH key。这会把“部署 shared runtime sidecar”误挡在“创建 host 参数缺失”上。

处理：`prepare-cds-agent-remote-host-pool.sh` 现在会先选择 target host：

- 优先使用 `CDS_REMOTE_HOST_ID`。
- 未指定时复用第一个 enabled remote host。
- 只有没有 target host 时才要求创建 host 的 SSH 参数。
- 部署 sidecar 时单独要求 `CDS_AGENT_SIDECAR_IMAGE`。

证据：

- `/tmp/cds-agent-remote-host-existing-report.json`：existing enabled host dry-run，`willCreateHost=false`、`missingConfig=[]`。
- `/tmp/cds-agent-remote-host-existing-deploy-missing-image-report.json`：existing enabled host + deploy dry-run，只缺 `CDS_AGENT_SIDECAR_IMAGE`。

优化：真实执行前先用 prepare report 看 `targetHostId/willCreateHost/missingConfig`，避免把创建 host 和部署 sidecar 混成一个大黑盒。

### 12. evidence unavailable 不能误报成 branch contamination

问题：沙箱内 DNS 解析 `cds.miduo.org` 失败时，pre evidence 标记 `branchIsolation.evidenceCaptured=false`，但 remote host wrapper 仅通过 `branchIsolationClean=false` 推导 verdict，最终误报 `blocked-branch-isolation`。

处理：`run-cds-agent-remote-host-pool-with-evidence.sh` 增加 `preEvidenceAvailable`，先判断证据是否可用。证据不可用时输出：

- `verdict=evidence-unavailable`
- `nextAction=fix network/auth and rerun`

证据：

- 沙箱外 live dry-run `/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json`：`dry-run-missing-config`，远程 `enabledHostCount=0`、`sharedRunning=0`。
- 沙箱内 DNS 失败 fixture `/tmp/cds-agent-remote-host-pool-current-readonly-unavailable-fixed/summary.json`：`verdict=evidence-unavailable`。

优化：以后只有看到真实 `BRANCH_LOCAL_SIDECAR_CLEAN` blocker 时才写 branch contamination；证据不可用单独处理，避免误导执行顺序。

## 最耗时项

| 项 | 耗时 | 是否可本地化 | 后续优化 |
| --- | --- | --- | --- |
| branch isolation cleanup wrapper | 40s | 部分可本地化 | wrapper 已有 pre/post evidence；直接清理后追加 direct branch/project query，避免再猜 |
| runbook publish verification | 约 35s/次 | 部分可本地化 | 本地 `tsc`/controller tests 先跑；远程 bundle 验证只在 UI 发布后跑 |
| runtime pool evidence | 11-14s | 不可完全本地化 | 它查远程 CDS state，保留为 R0 权威证据，不用 one-cycle 替代 |
| controller tests | 18 tests，<1s 测试执行；构建有 warnings | 可本地化 | 只跑 `InfraAgentSessionsControllerTests` 覆盖 execution panel 内容 |

## 当前下一步

现在不应该继续普通 preview redeploy。下一步要么提供 remote host 参数，要么继续完善恢复前置检查。

真正恢复 R0 需要：

```text
CDS_REMOTE_HOST_NAME
CDS_REMOTE_HOST_HOST
CDS_REMOTE_HOST_SSH_USER
CDS_REMOTE_HOST_SSH_PRIVATE_KEY or CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE
CDS_AGENT_REMOTE_HOST_APPLY=1
CDS_AGENT_REMOTE_HOST_DEPLOY_SIDECAR=1
CDS_AGENT_SIDECAR_IMAGE
```

执行入口：

```bash
CDS_HOST=https://cds.miduo.org \
CDS_AGENT_REMOTE_HOST_APPLY=1 \
CDS_AGENT_REMOTE_HOST_DEPLOY_SIDECAR=1 \
CDS_AGENT_SIDECAR_IMAGE=<image> \
  bash scripts/run-cds-agent-remote-host-pool-with-evidence.sh
```

完成后必须通过：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_SHARED_POOL_REMOTE=1 \
  bash scripts/smoke-cds-agent-shared-service-pool.sh
```

## 承诺的记录方式

后续继续推进时，每轮必须更新：

- `doc/status.cds-agent-current-progress.md`：当前状态、最新 evidence、下一步。
- `doc/report.cds-agent-execution-ledger-2026-05-18.md`：问题、处理、耗时、优化。
- 对任何远程写动作：保留 evidence wrapper summary 和 post-check。
