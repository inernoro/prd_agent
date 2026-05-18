# CDS Agent 当前进度面板

> **更新时间**：2026-05-18 20:41 Asia/Shanghai
> **分支**：`codex/cds-agent-workbench-ui`
> **当前阶段**：R0 shared-service runtime pool 恢复
> **总状态**：目标未完成；branch-local sidecar 污染已清理，仍缺 remote host 和 running shared runtime。

## 1. 项目级答案

### 1.1 预计什么时候结束

从 R0 所需输入齐全开始计算：

```text
R0 打通：20-50 分钟
R1/S1/S2/S3/V1 一轮真实验收：30-60 分钟
最终整理验收：10-20 分钟
总计：约 1-2 小时
```

当前不能按这个倒计时执行，因为 R0 仍缺外部输入：一个 remote host 可 `docker pull` 的 `CDS_AGENT_SIDECAR_IMAGE`，以及 remote host 承载参数。

### 1.2 一共多少步骤

| 顺序 | 阶段 | 状态 | 剩余时间 |
| --- | --- | --- | --- |
| 1 | A0 官方 SDK adapter 边界 | done | 0 |
| 2 | N6 其他智能体兼容性 | done | 0 |
| 3 | R0 shared runtime pool 恢复 | blocked | 输入齐全后 20-50 分钟 |
| 4 | R1 Claude/Anthropic profile 修正 | pending | 5-15 分钟 |
| 5 | S1 只读真实 run | pending | 5-10 分钟 |
| 6 | S2/S3 审批、取消、错误路径 | pending | 10-15 分钟 |
| 7 | V1 真实页面视觉/交互验证 | pending | 5-10 分钟 |
| 8 | 最终商业级验收/文档归档 | pending | 10-20 分钟 |

### 1.3 现在在哪一步

```text
第 3 步：R0 shared runtime pool 恢复
```

R0 的完成标准不是“页面能打开”，而是：

```text
sidecar image 可被 remote host pull
-> CDS 有 enabled remote host
-> shared official SDK runtime running
-> MAP runtime-status 能发现 healthy runtime
```

当前未满足：

```text
SIDECAR_IMAGE_PULLABLE=missing
REMOTE_HOST_AVAILABLE=missing
SHARED_POOL_RUNNING=missing
```

### 1.4 我需要你协助什么

最小输入是：

```text
CDS_AGENT_SIDECAR_IMAGE=<任意 registry image，只要目标 remote host 能 docker pull>
CDS_REMOTE_HOST_NAME=<name>
CDS_REMOTE_HOST_HOST=<host-or-ip>
CDS_REMOTE_HOST_SSH_USER=<ssh-user>
CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE=<private-key-file>
```

如果你已有可拉取的镜像，直接给 `CDS_AGENT_SIDECAR_IMAGE`，不用 GHCR。GHCR 只是当前仓库场景下自动推导的候选发布路径，不是架构目标。

### 1.5 最关键文档

只看这两个：

- `doc/status.cds-agent-current-progress.md`：当前项目级进度、剩余步骤、当前 blocker、下一步。
- `doc/report.cds-agent-execution-ledger-2026-05-18.md`：执行账本，记录做过什么、耗时、哪里兜圈、如何避免再兜圈。

## 2. 一句话进度

`prd-agent` 主系统已经不再被 `claude-agent-sdk-runtime-v2` 侵入。现在卡住的不是页面、构建或普通 preview deploy，而是 CDS 系统侧没有 enabled remote host，也没有 running 的 shared official SDK runtime sidecar。

当前有效 blocker：

| Gate | 状态 | 说明 |
| --- | --- | --- |
| `BRANCH_LOCAL_SIDECAR_CLEAN` | pass | 远程 branch services 污染数 `4 -> 0` |
| `REMOTE_HOST_AVAILABLE` | blocked | `/api/cds-system/remote-hosts` enabled host = `0` |
| `SHARED_POOL_RUNNING` | blocked | `shared-sidecar-pool-mp4anabh` 没有 running runtime |
| `SIDECAR_IMAGE_PULLABLE` | blocked | CDS deployer 是 `docker pull` 模式；本仓库有 Dockerfile，但不能证明远程 host 可拉取 |
| `SIDECAR_BUILD_CONTEXT` | pass | `claude-sdk-sidecar` Dockerfile/requirements/app/healthz/readyz/official SDK dependency 本地预检通过 |
| `SIDECAR_LOCAL_BUILD` | pass | Colima broken instance 已清理并重启；`prd-agent/claude-sidecar:latest` 本地 Docker build 通过 |
| `SIDECAR_REGISTRY_PUBLISH` | ready | registry-qualified candidate 已确定；本地 tag 已创建，外部 push 尚未执行；也可直接提供其他可 pull registry image |
| `SIDECAR_LOCAL_REGISTRY_TAG` | pass | 历史候选 tag 已本地创建；当前 HEAD 候选以 `scripts/refresh-cds-agent-r0-status.sh` 输出的 `candidateSidecarImage` 为准；`pushAttempted=false` |
| `SIDECAR_MANUAL_CI_PUBLISH` | optional | `.github/workflows/cds-sidecar-image.yml` 是 GHCR 候选路径；如果已有可 pull image 可跳过 |
| `SIDECAR_REGISTRY_MANIFEST` | not checked | 发布完成后先用只读 registry manifest 检查确认 image tag 可见，再 SSH 到 remote host |
| `REMOTE_HOST_PULL` | blocked | 默认报告 `missing_config`；需要 remote host SSH 参数和 registry image，显式 `CDS_AGENT_REMOTE_PULL_VERIFY=1` 才 SSH 执行 `docker pull` |

固定查看入口：

```bash
scripts/refresh-cds-agent-r0-status.sh
scripts/print-cds-agent-current-progress.sh
scripts/print-cds-agent-lifecycle-overview.sh
```

这些命令只读，不部署、不写远程、不输出 secret。`refresh-cds-agent-r0-status.sh` 默认只做本地刷新；只有显式设置 `CDS_AGENT_WORKFLOW_CHECK=1` 才查询 GitHub Actions 状态。它会统一刷新 publish handoff、workflow dry-run/status、registry dry-run、readiness、operator handoff、lifecycle 和 progress board，避免多个 `/tmp` 证据文件停留在不同 commit。

## 3. 阶段总览

完整生命周期不是“做页面”一个阶段，而是 8 个 gate：

```text
A0 adapter 边界 -> R0 runtime pool -> R1 profile -> S1 read-only ->
S2 approval -> S3 cancel/error -> V1 visual/live page -> Release hardening
```

当前实际位置：A0 已完成，R0 正卡在 image publish/remote host/shared runtime；也就是刚进入真实运行时恢复段，还没进入功能 one-cycle 和商业级视觉验收。

| 阶段 | 开发 | 证据 | 状态 | 下一步 |
| --- | --- | --- | --- | --- |
| A0 官方 SDK adapter 边界 | [x] | `smoke-cds-agent-official-sdk-boundary.sh`、helper tests | 已完成 | 保持 legacy loop 只作显式 fallback |
| R0.1 业务分支去污染 | [x] | `/tmp/cds-agent-branch-isolation-repair-apply-current/summary.json` | 已完成 | 防回归 |
| R0.2 remote host 承载层 | [x] 脚本就绪 | `/tmp/cds-agent-remote-host-pool-manifest-current/summary.json` | blocked | 提供 remote host SSH 参数 |
| R0.3 shared runtime pool | [x] 脚本就绪 | `smoke-cds-agent-shared-service-pool.sh` | blocked | 提供 `CDS_AGENT_SIDECAR_IMAGE` 并部署 |
| R1 Claude/Anthropic profile | [x] 模板/预检就绪 | runtime-status profile diagnostics | pending | R0 通过后配置默认 profile |
| S1/S2/S3 one-cycle | [x] smoke 框架就绪 | one-cycle summary | pending | R0/R1 通过后跑只读、审批、取消 |
| V1 视觉验证 | [x] 页面支持 | bundle publish check | partial | R0/R1/S1 后做登录态截图 |
| N6 非代码智能体兼容 | [x] | `/tmp/cds-agent-n6-non-code-compatibility-current.json` | 已完成 | one-cycle 前后复跑 |

## 4. 当前 R0 看板

| 项 | 当前值 | 证据 |
| --- | --- | --- |
| app project | `prd-agent` | CDS branch/project list |
| shared pool | `shared-sidecar-pool-mp4anabh` | `project.kind=shared-service` |
| app services | `api-prd-agent`, `admin-prd-agent` | `/tmp/cds-branch-status-final.json` |
| sidecar contamination | `0` | `/tmp/cds-agent-branch-list-after-delete.json` |
| remote hosts | `0 enabled` | `/tmp/cds-agent-remote-host-pool-manifest-current/summary.json` |
| shared runtime running | `0` | `/tmp/cds-agent-runtime-pool-evidence-current-clean/summary.json` |
| should redeploy preview? | no | blocker 不在 preview app build |
| sidecar image readiness | `missing` | `CDS_AGENT_SIDECAR_IMAGE` 必须是目标 remote host 可 `docker pull` 的镜像 |
| sidecar build context | `pass` | `/tmp/cds-agent-sidecar-image-preflight-current.json` |
| sidecar local docker build | `build_pass` | `/tmp/cds-agent-sidecar-image-build-current.json` |
| sidecar registry publish | `push_ready` | `/tmp/cds-agent-sidecar-image-publish-current.json` |
| sidecar local registry tag | `tagPassed=true`、`pushAttempted=false` | 历史本地 tag 通过；当前 HEAD 候选以 refresh 输出的 `candidateSidecarImage` 为准 |
| sidecar registry manifest | `not checked` | `/tmp/cds-agent-sidecar-registry-image-current.json` |
| remote host docker pull | `missing_config` | `/tmp/cds-agent-remote-sidecar-pull-current.json` |

## 5. 下一步最小计划

只做 R0 runtime pool 恢复，不做页面重画，不做普通 preview redeploy。

| 顺序 | 动作 | 需要输入 | 成功证据 |
| --- | --- | --- | --- |
| 1 | 确定 sidecar image | 提供任意 remote host 可 pull 的 `CDS_AGENT_SIDECAR_IMAGE`；GHCR 只是候选发布路径 | registry manifest 可见或目标 host 可 pull |
| 2 | 只读验证 registry manifest | `CDS_AGENT_SIDECAR_IMAGE` | `/tmp/cds-agent-sidecar-registry-image-current.json` 为 `manifest_visible` |
| 3 | 创建/登记 enabled remote host | `CDS_REMOTE_HOST_NAME`、`CDS_REMOTE_HOST_HOST`、`CDS_REMOTE_HOST_SSH_USER`、SSH private key | `enabledHostCount > 0` |
| 4 | 验证 remote host 可 pull image 并部署 shared runtime | `CDS_AGENT_SIDECAR_IMAGE`，可选 `CDS_AGENT_SIDECAR_PORT=7400` | `remote pull=pass`、`sharedRunning > 0` |
| 5 | 跑 shared-service pool audit | 无新增输入 | `smoke-cds-agent-shared-service-pool.sh` pass |
| 6 | 刷新 MAP runtime-status | 登录态或 API | `diagnostics.healthyCount > 0`，R0 pass |
| 7 | 进入 R1/S1/S2/S3 | Anthropic/Claude-compatible profile key | one-cycle 产生真实只读、审批、取消证据 |

执行入口：

```bash
CDS_HOST=https://cds.miduo.org \
CDS_AGENT_REMOTE_HOST_APPLY=1 \
CDS_AGENT_REMOTE_HOST_DEPLOY_SIDECAR=1 \
CDS_AGENT_SIDECAR_IMAGE=<official-sdk-sidecar-image> \
CDS_REMOTE_HOST_NAME=<name> \
CDS_REMOTE_HOST_HOST=<host> \
CDS_REMOTE_HOST_SSH_USER=<ssh-user> \
CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE=<private-key-file> \
  bash scripts/run-cds-agent-remote-host-pool-with-evidence.sh
```

post-check：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_SHARED_POOL_REMOTE=1 \
  bash scripts/smoke-cds-agent-shared-service-pool.sh
```

## 6. 已完成清单

| 完成项 | 证据 |
| --- | --- |
| 删除远程 `claude-agent-sdk-runtime-v2-prd-agent` 污染 | `/tmp/cds-agent-branch-isolation-repair-apply-current/summary.json`，`afterContaminatedBranchCount=0` |
| 直接复查业务服务只剩 api/admin | `/tmp/cds-agent-project-list-after-delete.json` |
| execution panel 展示 branch cleanup manifest | `InfraAgentSessionsControllerTests` 18/18 |
| execution panel 展示 remote host recovery manifest | `remote-host-prepare` runbook `applyManifest` |
| 前端 bundle 支持 manifest 渲染 | `/tmp/cds-agent-runbook-published/summary.json` |
| remote host dry-run 输出两阶段 recovery manifest | `/tmp/cds-agent-remote-host-pool-manifest-current/summary.json` |
| 过程账本落地 | `doc/report.cds-agent-execution-ledger-2026-05-18.md` |

## 7. 最新证据

| 证据 | 路径 | 结论 | 耗时 |
| --- | --- | --- | --- |
| branch isolation apply | `/tmp/cds-agent-branch-isolation-repair-apply-current/summary.json` | `applied-clean` | 40s |
| runtime pool evidence | `/tmp/cds-agent-runtime-pool-evidence-latest/summary.json` | branch clean，remote host/shared runtime missing | 12s |
| remote host recovery dry-run | `/tmp/cds-agent-remote-host-pool-manifest-current/summary.json` | `dry-run-missing-config` | 14s |
| runbook publish verification | `/tmp/cds-agent-runbook-published/summary.json` | bundle has `applyManifest/preconditions` rendering | ~35s |
| CDS branch status | `/tmp/cds-branch-status-final.json` | preview running, services only api/admin | ~1s |
| goal audit summary fast | `/tmp/cds-agent-goal-audit-summary-fast.json` | `status=blocked_r0`，next plan=`R0.2/R0.3/R0V` | 11s |
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
| goal audit with readiness | `/tmp/cds-agent-goal-audit-current-with-readiness.json` | `N6=pass`、otherAgentCompatibility proved，并纳入 R0 apply readiness；仍 `not_complete` | 15s |
| lifecycle overview | `scripts/print-cds-agent-lifecycle-overview.sh` | 按完整目标输出生命周期、已完成、阻塞、剩余距离和关键路径；V1 标为 partial | <1s |
| sidecar image readiness | `/tmp/cds-agent-r0-apply-readiness-current.json`、`/tmp/cds-agent-r0-operator-handoff-current.md` | 明确 CDS remote deployer 只 `docker pull`，不是远程构建；`CDS_AGENT_SIDECAR_IMAGE` 仍缺 | <1s |
| sidecar image preflight | `/tmp/cds-agent-sidecar-image-preflight-current.json` | 本地 build context 通过；image 仍为 `missing_image`，远程 pullability 未证明 | <1s |
| sidecar image build smoke | `/tmp/cds-agent-sidecar-image-build-current.json` | 本地 Docker build 通过；未 push、未 deploy | 约 65s，含依赖安装 |
| sidecar image publish dry-run | `/tmp/cds-agent-sidecar-image-publish-current.json` | 默认不 push；当前缺 registry-qualified target image | <1s |
| remote sidecar pull dry-run | `/tmp/cds-agent-remote-sidecar-pull-current.json` | 默认不 SSH；当前缺 image、host、ssh user、ssh key | <1s |
| progress board exact next step | `scripts/print-cds-agent-current-progress.sh` | 根据 image context/build/publish、remote pull、remote host gate 顺序动态选择下一步；当前指向确定 candidate tag 的 registry dry-run | <1s |
| local registry tag | `/tmp/cds-agent-sidecar-image-publish-current.json` | 本地 tag 已创建，未 push、未 deploy | <1s |
| manual CI publish workflow | `.github/workflows/cds-sidecar-image.yml` | 手动触发，默认 tag 为 commit SHA；不会随普通 push 自动发布 | local syntax/read |
| sidecar workflow status | `/tmp/cds-agent-sidecar-workflow-current.json` | 默认 dry-run；显式 `CDS_AGENT_WORKFLOW_CHECK=1` 后只读查询 GitHub Actions workflow/runs | <1s dry-run |
| sidecar publish handoff | `/tmp/cds-agent-sidecar-publish-handoff-current.md` | 输出 GitHub Actions 手动发布 URL、image tag、CLI 等价命令和本机 push 替代路径 | <1s |
| sidecar registry manifest verify | `/tmp/cds-agent-sidecar-registry-image-current.json` | 默认 dry-run；显式 `CDS_AGENT_SIDECAR_REGISTRY_VERIFY=1` 后只读查询 GHCR manifest | <1s dry-run |
| R0 status refresh bundle | `/tmp/cds-agent-r0-status-refresh-current.md` | 一键刷新当前 HEAD image、publish handoff、workflow dry-run/status、registry dry-run、readiness、operator handoff、lifecycle、progress board | <3s |

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
| goal audit with readiness | 15s；N6 沙箱步骤超时但 summary 校准为 pass | audit 读取 N6 summary 和 R0 readiness，不再把 VSTest 权限问题当作兼容性失败 |
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
Next cycle plan: r0-runtime-pool-recovery state=runtime-pool-blocked items=R0.2,R0.3,R0V
```

只读刷新 remote host recovery manifest：

```bash
CDS_HOST=https://cds.miduo.org \
CDS_AGENT_REMOTE_HOST_POOL_RUN_DIR=/tmp/cds-agent-remote-host-pool-manifest-current \
  bash scripts/run-cds-agent-remote-host-pool-with-evidence.sh
```

当前 live dry-run 证明远程没有 enabled remote host，因此恢复 R0 的最小写入输入是：

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

注意：`CDS_AGENT_SIDECAR_IMAGE` 不是“仓库里有 Dockerfile 就自动具备”。CDS remote sidecar deployer 当前只执行 `docker pull` 和 `docker run`，所以这里必须是目标 remote host 可以拉取的 registry image，例如先完成本地 build、push，再把可拉取 tag 填入该变量。

当前 workflow 状态：

```text
workflowStatus=workflow_file_on_branch_not_indexed
workflowFileVisible=true
workflowRun=none
```

这表示 `.github/workflows/cds-sidecar-image.yml` 已存在于 `codex/cds-agent-workbench-ui` 分支，但 GitHub Actions workflow API 不能 dispatch/list 它。它只是 GHCR 候选路径的问题，不是 R0 架构前提。当前最小下一步仍是提供任意目标 remote host 可 `docker pull` 的 `CDS_AGENT_SIDECAR_IMAGE`，以及 remote host 参数；如果选择 GHCR，再处理 workflow 索引或显式批准 registry push。

生成安全 handoff 命令：

```bash
scripts/print-cds-agent-remote-host-handoff.sh \
  /tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json
```

发布验证：

```bash
bash scripts/verify-cds-agent-runbook-published.sh
```
