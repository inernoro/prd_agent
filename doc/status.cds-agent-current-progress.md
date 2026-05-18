# CDS Agent 当前进度面板

> **更新时间**：2026-05-18 18:00 Asia/Shanghai
> **分支**：`codex/cds-agent-workbench-ui`
> **当前阶段**：R0 shared-service runtime pool 恢复
> **总状态**：目标未完成；branch-local sidecar 污染已清理，仍缺 remote host 和 running shared runtime。

## 1. 一句话进度

`prd-agent` 主系统已经不再被 `claude-agent-sdk-runtime-v2` 侵入。现在卡住的不是页面、构建或普通 preview deploy，而是 CDS 系统侧没有 enabled remote host，也没有 running 的 shared official SDK runtime sidecar。

当前有效 blocker：

| Gate | 状态 | 说明 |
| --- | --- | --- |
| `BRANCH_LOCAL_SIDECAR_CLEAN` | pass | 远程 branch services 污染数 `4 -> 0` |
| `REMOTE_HOST_AVAILABLE` | blocked | `/api/cds-system/remote-hosts` enabled host = `0` |
| `SHARED_POOL_RUNNING` | blocked | `shared-sidecar-pool-mp4anabh` 没有 running runtime |

## 2. 阶段总览

| 阶段 | 开发 | 证据 | 状态 | 下一步 |
| --- | --- | --- | --- | --- |
| A0 官方 SDK adapter 边界 | [x] | `smoke-cds-agent-official-sdk-boundary.sh`、helper tests | 已完成 | 保持 legacy loop 只作显式 fallback |
| R0.1 业务分支去污染 | [x] | `/tmp/cds-agent-branch-isolation-repair-apply-current/summary.json` | 已完成 | 防回归 |
| R0.2 remote host 承载层 | [x] 脚本就绪 | `/tmp/cds-agent-remote-host-pool-manifest-current/summary.json` | blocked | 提供 remote host SSH 参数 |
| R0.3 shared runtime pool | [x] 脚本就绪 | `smoke-cds-agent-shared-service-pool.sh` | blocked | 提供 `CDS_AGENT_SIDECAR_IMAGE` 并部署 |
| R1 Claude/Anthropic profile | [x] 模板/预检就绪 | runtime-status profile diagnostics | pending | R0 通过后配置默认 profile |
| S1/S2/S3 one-cycle | [x] smoke 框架就绪 | one-cycle summary | pending | R0/R1 通过后跑只读、审批、取消 |
| V1 视觉验证 | [x] 页面支持 | bundle publish check | partial | R0/R1/S1 后做登录态截图 |
| N6 非代码智能体兼容 | [x] smoke 就绪 | non-code compat smoke | pending | one-cycle 前后复跑 |

## 3. 当前 R0 看板

| 项 | 当前值 | 证据 |
| --- | --- | --- |
| app project | `prd-agent` | CDS branch/project list |
| shared pool | `shared-sidecar-pool-mp4anabh` | `project.kind=shared-service` |
| app services | `api-prd-agent`, `admin-prd-agent` | `/tmp/cds-branch-status-final.json` |
| sidecar contamination | `0` | `/tmp/cds-agent-branch-list-after-delete.json` |
| remote hosts | `0 enabled` | `/tmp/cds-agent-remote-host-pool-manifest-current/summary.json` |
| shared runtime running | `0` | `/tmp/cds-agent-runtime-pool-evidence-current-clean/summary.json` |
| should redeploy preview? | no | blocker 不在 preview app build |

## 4. 下一步最小计划

只做 R0 runtime pool 恢复，不做页面重画，不做普通 preview redeploy。

| 顺序 | 动作 | 需要输入 | 成功证据 |
| --- | --- | --- | --- |
| 1 | 创建/登记 enabled remote host | `CDS_REMOTE_HOST_NAME`、`CDS_REMOTE_HOST_HOST`、`CDS_REMOTE_HOST_SSH_USER`、SSH private key | `enabledHostCount > 0` |
| 2 | 部署 shared official SDK runtime sidecar | `CDS_AGENT_SIDECAR_IMAGE`，可选 `CDS_AGENT_SIDECAR_PORT=7400` | `sharedRunning > 0` |
| 3 | 跑 shared-service pool audit | 无新增输入 | `smoke-cds-agent-shared-service-pool.sh` pass |
| 4 | 刷新 MAP runtime-status | 登录态或 API | `diagnostics.healthyCount > 0`，R0 pass |
| 5 | 进入 R1/S1/S2/S3 | Anthropic/Claude-compatible profile key | one-cycle 产生真实只读、审批、取消证据 |

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

## 5. 已完成清单

| 完成项 | 证据 |
| --- | --- |
| 删除远程 `claude-agent-sdk-runtime-v2-prd-agent` 污染 | `/tmp/cds-agent-branch-isolation-repair-apply-current/summary.json`，`afterContaminatedBranchCount=0` |
| 直接复查业务服务只剩 api/admin | `/tmp/cds-agent-project-list-after-delete.json` |
| execution panel 展示 branch cleanup manifest | `InfraAgentSessionsControllerTests` 18/18 |
| execution panel 展示 remote host recovery manifest | `remote-host-prepare` runbook `applyManifest` |
| 前端 bundle 支持 manifest 渲染 | `/tmp/cds-agent-runbook-published/summary.json` |
| remote host dry-run 输出两阶段 recovery manifest | `/tmp/cds-agent-remote-host-pool-manifest-current/summary.json` |
| 过程账本落地 | `doc/report.cds-agent-execution-ledger-2026-05-18.md` |

## 6. 最新证据

| 证据 | 路径 | 结论 | 耗时 |
| --- | --- | --- | --- |
| branch isolation apply | `/tmp/cds-agent-branch-isolation-repair-apply-current/summary.json` | `applied-clean` | 40s |
| runtime pool evidence | `/tmp/cds-agent-runtime-pool-evidence-latest/summary.json` | branch clean，remote host/shared runtime missing | 12s |
| remote host recovery dry-run | `/tmp/cds-agent-remote-host-pool-manifest-current/summary.json` | `dry-run-missing-config` | 14s |
| runbook publish verification | `/tmp/cds-agent-runbook-published/summary.json` | bundle has `applyManifest/preconditions` rendering | ~35s |
| CDS branch status | `/tmp/cds-branch-status-final.json` | preview running, services only api/admin | ~1s |
| goal audit summary fast | `/tmp/cds-agent-goal-audit-summary-fast.json` | `status=blocked_r0`，next plan=`R0.2/R0.3/R0V` | 11s |
| N6 no-build test | terminal output | 27/27 pass outside sandbox socket restriction | 64ms |

## 7. 时间和问题账本

详细过程、问题、处理、耗时和优化记录在：

- `doc/report.cds-agent-execution-ledger-2026-05-18.md`

最耗时项：

| 项 | 耗时 | 后续优化 |
| --- | --- | --- |
| branch isolation cleanup wrapper | 40s | 远程写动作保留 wrapper，但完成后直接查 branch/project list，减少反复判断 |
| runbook publish verification | ~35s | 只在 UI 发布后跑；后端 manifest 内容用 controller tests 覆盖 |
| runtime pool evidence | 11-14s | 保留为 R0 权威远程证据，不用 one-cycle 替代 |
| goal audit summary | 11s | 日常看板读最近 R0 summary；只有刷新远程事实时才开 live |

## 8. 不要做的事

- 不要为了当前 blocker 重复普通 preview redeploy。
- 不要把 `claude-agent-sdk-runtime*` 写回 `prd-agent` compose services。
- 不要把 `CLAUDE_SIDECAR_BASE_URL` 指回 branch-local sidecar alias。
- 不要在 `REMOTE_HOST_AVAILABLE` 和 `SHARED_POOL_RUNNING` 未通过时跑 provider one-cycle。
- 不要把历史 preview alias 成功当作 shared-service runtime pool 恢复。

## 9. 当前命令

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

发布验证：

```bash
bash scripts/verify-cds-agent-runbook-published.sh
```
