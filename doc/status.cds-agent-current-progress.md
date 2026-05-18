# CDS Agent 当前进度面板

> 更新时间：2026-05-18 15:21 Asia/Shanghai
> 分支：`codex/cds-agent-workbench-ui`
> HEAD：`a867b5fa8`
> 状态：R0 runtime pool blocked，目标未完成。

## 当前结论

现在不要做普通 preview redeploy。远程 R0 runtime pool 的结构性阻塞仍存在：

- `BRANCH_LOCAL_SIDECAR_CLEAN = contaminated:7`
- `REMOTE_HOST_AVAILABLE = missing`
- `SHARED_POOL_RUNNING = missing`

最新只读证据目录：

- `/tmp/cds-agent-runtime-pool-evidence-20260518152052`
- `summary.json`: `/tmp/cds-agent-runtime-pool-evidence-20260518152052/summary.json`
- `evidence-index.md`: `/tmp/cds-agent-runtime-pool-evidence-20260518152052/evidence-index.md`

本次证据采集总耗时 `14s`：

| 步骤 | 状态 | 耗时 |
| --- | --- | --- |
| runtime pool recovery plan | pass | 5s |
| branch isolation repair dry-run | pass | 3s |
| remote host pool preparation | pass | 1s |
| shared-service pool audit | blocked | 5s |

## 为什么不是部署问题

当前阻塞不在 `prd-api` 或 `prd-admin` 普通应用代码是否能构建，而在 CDS 远程控制面 state：

- `prd-agent` 业务项目仍有 branch-local `claude-agent-sdk-runtime-v2-prd-agent` 残留。
- `shared-sidecar-pool-mp4anabh` 是 `shared-service`，但没有 running service。
- CDS 系统 remote host 列表为空，没有可承载 official SDK runtime 的主机。

普通 preview redeploy 不能创建 shared runtime pool，也不能清理历史 branch-local sidecar residual。继续 redeploy 反而可能让用户以为构建能解决 R0。

## 已完成

- MAP/CDS 控制面与官方 SDK adapter 边界已写入后端兼容矩阵。
- `claude-agent-sdk` 路径已作为目标 adapter；`legacy-sidecar` 只允许显式 fallback。
- 其他候选官方 SDK，例如 `codex`、`openai-agents-sdk`、`google-adk`，仍为 `planned-not-routable`，避免误路由。
- 非代码智能体兼容 smoke 已存在，防止 PRD/Defect/Literary/Visual 等智能体被 CDS sidecar runtime pool 污染。
- runtime-status execution panel 已能把 R0 阻塞的下一步收敛到只读证据采集：
  `CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 bash scripts/collect-cds-agent-runtime-pool-evidence.sh`
- 文档和目标审计已校准到当前 R0 runtime pool 阻塞，而不是旧的“只剩 R1 profile”。

## 下一步

必须按这个顺序处理：

1. 清理 `prd-agent` 的 branch-local sidecar BuildProfile/service residual。
   - dry-run 证据已确认候选 profile：`claude-agent-sdk-runtime-v2-prd-agent`
   - 写远程清理前必须使用 evidence wrapper，并在清理后立即跑 post-check。
2. 登记至少一个 enabled CDS remote host。
   - 当前缺失：`CDS_REMOTE_HOST_NAME`
   - 当前缺失：`CDS_REMOTE_HOST_HOST`
   - 当前缺失：`CDS_REMOTE_HOST_SSH_USER`
   - 当前缺失：`CDS_REMOTE_HOST_SSH_PRIVATE_KEY` 或 `CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE`
3. 部署 shared official SDK runtime sidecar。
   - 需要 sidecar image，例如通过 `CDS_AGENT_SIDECAR_IMAGE` 提供。
4. 重跑 shared-service pool audit。
5. R0 通过后，再进入 R1 Anthropic/Claude-compatible profile 和 S1/S2/S3 provider smokes。

## 当前有效命令

只读总证据：

```bash
CDS_HOST=https://cds.miduo.org \
CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 \
  bash scripts/collect-cds-agent-runtime-pool-evidence.sh
```

branch 清理 dry-run：

```bash
CDS_HOST=https://cds.miduo.org \
  bash scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh
```

remote host 准备 dry-run：

```bash
CDS_HOST=https://cds.miduo.org \
  bash scripts/prepare-cds-agent-remote-host-pool.sh
```

目标审计：

```bash
CDS_AGENT_GOAL_AUDIT_REPORT=/tmp/cds-agent-goal-audit.json \
  bash scripts/audit-cds-agent-goal.sh
```
