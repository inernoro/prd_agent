# CDS Agent SDK Runtime 再次侵入 MAP 主系统 · 调查报告

> 日期：2026-05-18
> 最新复核：2026-05-18 17:24 Asia/Shanghai，远程清理后复查
> 范围：`prd-agent` 业务项目、`shared-sidecar-pool-mp4anabh` 共享运行池、MAP runtime discovery
> 结论：结构性隔离失败，不是页面误报，也不是 Claude Agent SDK 官方包本身的问题。

## 结论

`claude-agent-sdk-runtime-v2-prd-agent` 又出现在 `main`/业务分支视图里，是因为历史部署曾把 Claude Agent SDK runtime 当成 `prd-agent` 业务项目的普通 branch service。CDS 的业务分支模型会把项目 BuildProfile 跟随每个 branch preview 展示、部署、探活和计入 appServices；因此一旦 runtime sidecar 进入 `prd-agent` BuildProfile，它就天然会“侵入” MAP 主系统。

当前代码侧已经补了多道禁止新增污染的 guard；2026-05-18 17:22 经用户精确批准后，远程 `prd-agent` 存量 branch-local sidecar residual 已清理。正确的 `shared-service` runtime pool 仍没有 running 实例。也就是说：

- 错误结构已经从当前业务分支清理：`prd-agent` branch services 中不再包含 `claude-agent-sdk-runtime-v2-prd-agent`。
- 正确结构还没恢复：`shared-sidecar-pool-mp4anabh` 是 `kind=shared-service`，但没有 running service，也没有 remote host 承载 runtime。

所以这次不是“又有人把代码写回去了”，而是此前代码防线、远程存量清理、共享运行池恢复没有形成闭环。现在 branch-local 污染已解除，闭环还差 remote host 与 shared runtime pool。

## 最新现场证据

清理前只读查询命令：

```bash
CDS_HOST=https://cds.miduo.org \
  python3 .claude/skills/cds/cli/cdscli.py branch list --project prd-agent
```

2026-05-18 17:19 结果显示，仍有 4 个 `prd-agent` 分支包含 branch-local sidecar service：

| 分支 ID | Git 分支 | 状态 | 污染服务 |
| --- | --- | --- | --- |
| `prd-agent-codex-cds-agent-workbench-ui` | `codex/cds-agent-workbench-ui` | `running` | `claude-agent-sdk-runtime-v2-prd-agent` |
| `prd-agent-claude-redesign-ui-layout-awndl` | `claude/redesign-ui-layout-awNDL` | `idle` | `claude-agent-sdk-runtime-v2-prd-agent` |
| `prd-agent-claude-fix-gallery-stats-csu9h` | `claude/fix-gallery-stats-csu9H` | `idle` | `claude-agent-sdk-runtime-v2-prd-agent` |
| `prd-agent-cursor-marking-line-agent-e307` | `cursor/marking-line-agent-e307` | `idle` | `claude-agent-sdk-runtime-v2-prd-agent` |

清理前项目列表只读查询同时显示：

| Project | kind | running services | 说明 |
| --- | --- | --- | --- |
| `prd-agent` | `git` | `api-prd-agent`、`admin-prd-agent`、`claude-agent-sdk-runtime-v2-prd-agent` | 错误：runtime 被算作业务项目 app service |
| `shared-sidecar-pool-mp4anabh` | `shared-service` | 无 | 正确承载层存在，但没有 running runtime |

清理执行与复查证据：

- `/tmp/cds-agent-branch-isolation-repair-apply-current/summary.json`
- `/tmp/cds-agent-runtime-pool-evidence-after-branch-clean/summary.json`
- `/tmp/cds-agent-branch-list-after-delete.json`
- `/tmp/cds-agent-project-list-after-delete.json`

其中关键结论为：

- `BRANCH_LOCAL_SIDECAR_CLEAN = clean`
- `REMOTE_HOST_AVAILABLE = missing`
- `SHARED_POOL_RUNNING = missing`
- `beforeContaminatedBranchCount = 4`
- `afterContaminatedBranchCount = 0`
- `prd-agent.appServices = api-prd-agent, admin-prd-agent`
- `shared-sidecar-pool-mp4anabh` 仍无 running runtime

## 为什么屡次复发

### 1. 资源所有权边界曾经放错

正确边界应该是：

```text
prd-agent / MAP
  api、admin、session、profile、审批、事件、日志、取消、workspace 上下文

shared-sidecar-pool
  系统级 official SDK runtime instance

Claude Agent SDK
  官方 agent loop、tool loop、模型交互
```

错误边界是：

```text
prd-agent branch service
  api/admin
  claude-agent-sdk-runtime-v2-prd-agent
```

这个错误边界一旦进入 CDS state，runtime 就会和业务分支共生命周期：一起部署、一起展示、一起探活、一起失败。

### 2. 之前的修复偏向“让 R0 能跑”，没有先把负向约束做硬

为了让 MAP 能发现 Claude SDK runtime，历史上走过 branch-local fallback：让 `api` 通过 `CLAUDE_SIDECAR_BASE_URL` 指向分支内 sidecar。这个局部方案可以短期让 R0 发现 runtime，但代价是把 runtime 重新纳入业务项目服务列表。

现在已经修正为：R0 找不到 shared-service runtime pool 时应该明确 pending，并输出恢复步骤；不能再把 sidecar 塞回 `prd-agent` 分支服务。

### 3. 代码防线和远程状态没有同步闭环

已经补上的代码防线包括：

- `cds-compose.yml` 当前不再声明 branch-local `claude-agent-sdk-runtime*` service。
- `api.environment` 当前不再配置 branch-local `CLAUDE_SIDECAR_BASE_URL` 或 `CLAUDE_SIDECAR_TOKEN`。
- `scripts/smoke-cds-agent-branch-isolation.sh` 能检查本地 compose 和可选远程 branch contamination。
- `scripts/repair-cds-agent-branch-isolation.sh` 能 dry-run 并输出清理 manifest。
- CDS `StateService` 对非 `shared-service` 项目的 runtime-looking BuildProfile 做中心写入护栏。
- MAP runtime-status execution panel 已能显示 R0 blocker 和清理 runbook。

但这些只能防止新增污染，不能自动删除已经保存在远程 CDS state 里的 BuildProfile、branch.services 和容器记录。该远程存量清理已在 2026-05-18 17:22 通过 evidence wrapper 执行，复查为 clean。

### 4. 正确的 shared-service pool 还没接管

`shared-sidecar-pool-mp4anabh` 已经是 `kind=shared-service`，这说明结构方向是对的；但它现在没有 remote host、没有 running runtime instance。只清理污染而不恢复 shared pool，MAP 仍然没有可用 official SDK runtime。

## 哪个结构出了问题

核心问题是 CDS 里有两套概念共用了相近路径：

| 层 | 错误状态 | 正确状态 |
| --- | --- | --- |
| Compose / BuildProfile | runtime sidecar 被当成 `prd-agent` app profile | `prd-agent` 只保留 `api/admin` |
| Branch lifecycle | 每个业务分支继承 runtime service | runtime 不跟随业务分支复制 |
| Runtime discovery | MAP 可能看到 branch-local sidecar | MAP 只发现 shared-service 或显式外部 runtime |
| UI / 可观察性 | sidecar 和业务服务一起显示、一起报错 | runtime pool 独立显示健康度、host、adapter、profile |
| 验收 | 只看“能不能跑” | 同时验证“业务分支不含 runtime sidecar” |

所以问题结构不是 Claude SDK，也不是某一个 UI 卡片，而是 runtime ownership 没有被强制成系统级共享池。

## 为什么用户看到的是“侵犯 MAP”

因为清理前 `prd-agent` 项目列表仍把 `claude-agent-sdk-runtime-v2-prd-agent` 计为 `appServices`，和 `api-prd-agent`、`admin-prd-agent` 并列。截图中红框显示的正是这个 branch service，而不是独立的 shared-service runtime pool。

这会带来实际影响：

- `main` 或业务分支会被无关 runtime 探活失败拖红。
- 每个分支多一个 Python runtime 服务，增加端口、内存、构建、探活失败面。
- 用户无法判断失败来自 MAP 业务服务还是代码审查 runtime。
- 普通 preview redeploy 不能解决根因，反而容易制造“又部署了一次但还是污染”的错觉。

## 当前不能做什么

- 不能继续通过普通 `prd-agent` preview redeploy 解决 R0。
- 不能把 `claude-agent-sdk-runtime*` 写回 `cds-compose.yml services`。
- 不能让 MAP 默认指向 branch-local `CLAUDE_SIDECAR_BASE_URL`。
- 不能把历史 alias smoke 的稳定结果当作 shared-service runtime pool 已恢复。

## 必须按这个顺序闭环

1. 已完成：清理 `prd-agent` 业务项目里的 `claude-agent-sdk-runtime-v2-prd-agent` BuildProfile/service residual。
2. 已完成：清理后立即跑远程 branch isolation post-check，确认污染数变成 0。
3. 待完成：登记至少一个 enabled CDS remote host。
4. 待完成：在 remote host 上部署 official SDK runtime sidecar，让 `shared-sidecar-pool-mp4anabh` 出现 running instance。
5. 待完成：重跑 runtime-status、R0/S1/S2/S3 和 one-cycle。

已执行的清理命令：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_BRANCH_ISOLATION_APPLY=1 \
SMOKE_CDS_AGENT_BRANCH_ISOLATION_CONFIRM_PROFILE_ID=claude-agent-sdk-runtime-v2-prd-agent \
CDS_AGENT_BRANCH_ISOLATION_REPAIR_DIR=/tmp/cds-agent-branch-isolation-repair-apply-current \
  bash scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh
```

清理后复查：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_BRANCH_ISOLATION_REMOTE=1 \
  bash scripts/smoke-cds-agent-branch-isolation.sh
```

## 已沉淀的检查入口

只读总证据：

```bash
CDS_HOST=https://cds.miduo.org \
  bash scripts/collect-cds-agent-runtime-pool-evidence.sh
```

只读恢复计划：

```bash
CDS_HOST=https://cds.miduo.org \
  bash scripts/plan-cds-agent-runtime-pool-recovery.sh
```

branch-local sidecar 清理 dry-run：

```bash
CDS_HOST=https://cds.miduo.org \
  bash scripts/run-cds-agent-branch-isolation-repair-with-evidence.sh
```

shared-service pool 审计：

```bash
CDS_HOST=https://cds.miduo.org \
SMOKE_CDS_AGENT_SHARED_POOL_REMOTE=1 \
  bash scripts/smoke-cds-agent-shared-service-pool.sh
```

没有 post-check 的清理不能算完成；没有 running shared-service runtime instance 的 R0 也不能算恢复。
