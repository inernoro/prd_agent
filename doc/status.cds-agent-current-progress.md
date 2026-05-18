# CDS Agent 当前进度面板

> 更新时间：2026-05-18 17:24 Asia/Shanghai
> 分支：`codex/cds-agent-workbench-ui`
> 状态：branch-local sidecar 污染已清理；R0 runtime pool 仍 blocked，目标未完成。

## 当前结论

现在不要做普通 preview redeploy。远程 `prd-agent` branch-local sidecar 污染已清理，R0 runtime pool 的剩余结构性阻塞是 remote host 与 shared runtime pool：

- `BRANCH_LOCAL_SIDECAR_CLEAN = clean`
- `REMOTE_HOST_AVAILABLE = missing`
- `SHARED_POOL_RUNNING = missing`

最新只读证据目录：

- `/tmp/cds-agent-runtime-pool-evidence-after-branch-clean`
- `summary.json`: `/tmp/cds-agent-runtime-pool-evidence-after-branch-clean/summary.json`
- `evidence-index.md`: `/tmp/cds-agent-runtime-pool-evidence-after-branch-clean/evidence-index.md`

本次证据采集总耗时 `11s`：

| 步骤 | 状态 | 耗时 |
| --- | --- | --- |
| runtime pool recovery plan | pass | 4s |
| branch isolation repair dry-run | pass | 2s |
| remote host pool preparation | pass | 1s |
| shared-service pool audit | blocked | 4s |

## 为什么不是部署问题

当前阻塞不在 `prd-api` 或 `prd-admin` 普通应用代码是否能构建，而在 CDS 远程控制面 state：

- `prd-agent` 业务项目的 branch-local `claude-agent-sdk-runtime-v2-prd-agent` 残留已清理，远程 branch list 污染数为 `0`。
- `prd-agent` 当前 appServices 只剩 `api-prd-agent` 与 `admin-prd-agent`，`runningServiceCount=2`。
- `shared-sidecar-pool-mp4anabh` 是 `shared-service`，但没有 running service。
- CDS 系统 remote host 列表为空，没有可承载 official SDK runtime 的主机。

普通 preview redeploy 不能创建 shared runtime pool，也不能登记 remote host。继续 redeploy 反而可能让用户以为构建能解决 R0。

## 已完成

- MAP/CDS 控制面与官方 SDK adapter 边界已写入后端兼容矩阵。
- `claude-agent-sdk` 路径已作为目标 adapter；`legacy-sidecar` 只允许显式 fallback。
- 其他候选官方 SDK，例如 `codex`、`openai-agents-sdk`、`google-adk`，仍为 `planned-not-routable`，避免误路由。
- 非代码智能体兼容 smoke 已存在，防止 PRD/Defect/Literary/Visual 等智能体被 CDS sidecar runtime pool 污染。
- runtime-status execution panel 已能把 R0 阻塞的下一步收敛到只读证据采集。
- 总证据 summary 已聚合 branch isolation 与 remote host/shared runtime verdict，避免跨多个 `/tmp` 目录人工判断。
- 文档和目标审计已校准到当前 R0 runtime pool 阻塞，而不是旧的“只剩 R1 profile”。
- runtime-status 已下发机器可读 `runbook[]`、`nextCommandCode`、`nextCommandSafety`，页面已渲染执行 runbook，标明只读、远程删除、remote host apply/deploy 和 provider opt-in 边界。
- runtime-status 的下一步建议已校准为 `shared-service runtime pool`，不再把运行时恢复描述成 `branch-service sidecar`。
- `scripts/smoke-cds-agent-sidecar-alias-stability.sh` 与 `scripts/doctor-cds-agent-runtime.sh` 已默认阻止探测 branch-local `claude-agent-sdk-runtime*` alias；只有显式设置 `SMOKE_CDS_AGENT_ALLOW_BRANCH_LOCAL_ALIAS_PROBE=1` 才能用于历史污染诊断。
- branch-local sidecar 清理 dry-run 现在会输出 `applyManifest`，明确标记 `destructive_remote_delete_build_profile`、DELETE endpoint、必需环境变量、唯一候选和确认变量等前置条件。
- 目标审计已新增 `P0 branch isolation apply manifest` gate；有 `CDS_HOST` 时会只读生成清理 dry-run manifest 并运行 `smoke-cds-agent-branch-isolation-manifest.sh` 验证 fail-closed。
- 2026-05-18 17:22 经用户精确批准，已执行远程 branch-local sidecar 清理；复查显示 `beforeContaminatedBranchCount=4`、`afterContaminatedBranchCount=0`，`prd-agent` appServices 已不再包含 `claude-agent-sdk-runtime-v2-prd-agent`。

## 最新远程页面验证

2026-05-18 16:40 Asia/Shanghai 只读验证：

- CDS 分支：`prd-agent-codex-cds-agent-workbench-ui`
- 远程 commit：`d80e65d0` / `feat: render cds agent execution runbook`
- 分支状态：`running`
- `/cds-agent` HTTP：`200`
- 远程入口资源：`/assets/index-DAolpcjY-local.js`
- 命中 runbook 页面 chunk：`assets/index-vu_T_VIY-local.js`
- chunk 中已包含执行 runbook 渲染、`branch-isolation-apply-confirmed`、`requires approval`、`provider opt-in` 等发布后代码。

限制：本地 headless 截图被登录页拦截，只能证明远程构建资源已发布，不能替代登录后的像素级视觉截图。

## 最新本地验证

2026-05-18 16:54 Asia/Shanghai：

- `bash -n scripts/doctor-cds-agent-runtime.sh`：通过
- `bash -n scripts/smoke-cds-agent-sidecar-alias-stability.sh`：通过
- `git diff --check`：通过
- `dotnet test prd-api/tests/PrdAgent.Tests/PrdAgent.Tests.csproj --no-restore --filter FullyQualifiedName~DynamicSidecarRegistryTests`：通过，18/18
- `CDS_HOST=https://cds.miduo.org bash scripts/smoke-cds-agent-sidecar-alias-stability.sh`：按预期拒绝默认 branch-local alias probe，除非显式设置 `SMOKE_CDS_AGENT_ALLOW_BRANCH_LOCAL_ALIAS_PROBE=1`
- `CDS_HOST=https://cds.miduo.org CDS_AGENT_GOAL_AUDIT_REPORT=/tmp/cds-agent-goal-audit-current-after-doc-fix.json bash scripts/audit-cds-agent-goal.sh`：按预期返回 `goalStatus=not_complete`，本地 guardrail 耗时 `11s`，阻塞为 R0 runtime pool 未恢复
- `CDS_HOST=https://cds.miduo.org CDS_AGENT_BRANCH_ISOLATION_REPAIR_DIR=/tmp/cds-agent-branch-isolation-repair-manifest-current bash scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh`：dry-run 通过，`totalSeconds=15s`，`verdict=dry-run-contaminated`，未执行删除
- `bash scripts/smoke-cds-agent-branch-isolation-manifest.sh /tmp/cds-agent-branch-isolation-repair-manifest-current/summary.json`：通过，验证 dry-run manifest 明确且 fail-closed
- `CDS_HOST=https://cds.miduo.org CDS_AGENT_RUNTIME_POOL_EVIDENCE_DIR=/tmp/cds-agent-runtime-pool-evidence-manifest-current CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 bash scripts/collect-cds-agent-runtime-pool-evidence.sh`：通过，总证据 `branchIsolation.applyManifest` 已包含同一 DELETE manifest
- `CDS_HOST=https://cds.miduo.org CDS_AGENT_GOAL_AUDIT_REPORT=/tmp/cds-agent-goal-audit-with-manifest.json bash scripts/audit-cds-agent-goal.sh`：按预期返回 `goalStatus=not_complete`；新增 manifest gate 通过，整体耗时 `39s`

## 最新 Branch Isolation Apply

2026-05-18 17:22 Asia/Shanghai：

- 目录：`/tmp/cds-agent-branch-isolation-repair-apply-current`
- 报告：`/tmp/cds-agent-branch-isolation-repair-apply-current/summary.json`
- verdict：`applied-clean`
- beforeContaminatedBranchCount：`4`
- afterContaminatedBranchCount：`0`
- readyForRemoteHostStep：`true`
- nextAction：`branch isolation clean; register an enabled remote host and deploy the shared official SDK runtime sidecar`
- post-check：`SMOKE_CDS_AGENT_BRANCH_ISOLATION_REMOTE=1 bash scripts/smoke-cds-agent-branch-isolation.sh` 已通过
- 直接复查：`/tmp/cds-agent-branch-list-after-delete.json` 中 runtime sidecar service 污染列表为 `[]`
- 项目复查：`/tmp/cds-agent-project-list-after-delete.json` 中 `prd-agent.appServices` 只剩 `api-prd-agent` 与 `admin-prd-agent`

## 最新目标审计

2026-05-18 17:24 Asia/Shanghai：

- 当前没有重跑完整 goal audit；最新运行的是 runtime pool evidence。
- 结果：目标仍未完成。
- 当前阻塞门：`R0`
- 阻塞原因：`REMOTE_HOST_AVAILABLE=missing, SHARED_POOL_RUNNING=missing`
- 已解除阻塞：`BRANCH_LOCAL_SIDECAR_CLEAN=clean`

## 下一步

必须按这个顺序处理：

1. 登记至少一个 enabled CDS remote host。
   - verdict：`dry-run-missing-config`
   - readyForSharedRuntimeDeploy：`false`
   - nextAction：provide missing remote host variables, then rerun scripts/run-cds-agent-remote-host-pool-with-evidence.sh
   - 当前缺失：`CDS_REMOTE_HOST_NAME`
   - 当前缺失：`CDS_REMOTE_HOST_HOST`
   - 当前缺失：`CDS_REMOTE_HOST_SSH_USER`
   - 当前缺失：`CDS_REMOTE_HOST_SSH_PRIVATE_KEY or CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE`
2. 部署 shared official SDK runtime sidecar。
   - 需要 sidecar image，例如通过 `CDS_AGENT_SIDECAR_IMAGE` 提供。
3. 重跑 shared-service pool audit。
4. R0 通过后，再进入 R1 Anthropic/Claude-compatible profile 和 S1/S2/S3 provider smokes。

## 当前有效命令

只读总证据并刷新本文件：

```bash
CDS_HOST=https://cds.miduo.org \
CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 \
CDS_AGENT_RUNTIME_POOL_UPDATE_STATUS_DOC=1 \
  bash scripts/collect-cds-agent-runtime-pool-evidence.sh
```

branch 清理 dry-run：

```bash
CDS_HOST=https://cds.miduo.org \
  bash scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh
```

branch 清理 apply 必须精确确认候选 profile：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1 \
SMOKE_CDS_AGENT_BRANCH_ISOLATION_CONFIRM_PROFILE_ID=claude-agent-sdk-runtime-v2-prd-agent \
  bash scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh
```

remote host 准备 dry-run：

```bash
CDS_HOST=https://cds.miduo.org \
  bash scripts/run-cds-agent-remote-host-pool-with-evidence.sh
```

目标审计：

```bash
CDS_AGENT_GOAL_AUDIT_REPORT=/tmp/cds-agent-goal-audit.json \
  bash scripts/audit-cds-agent-goal.sh
```
