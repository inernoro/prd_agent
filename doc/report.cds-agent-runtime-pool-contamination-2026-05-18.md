# CDS Agent SDK Runtime 再次侵入 MAP 主系统 · 调查报告

> 日期：2026-05-18
> 范围：`prd-agent` 业务项目、`shared-sidecar-pool-mp4anabh` 共享运行池、MAP runtime discovery
> 结论：这是结构性隔离失败，不是单次页面显示错误。

## 结论

Claude Agent SDK runtime 之所以再次出现在 `main` 和多个业务分支里，是因为历史部署把 `claude-agent-sdk-runtime-v2-prd-agent` 当成了 `prd-agent` 业务项目的 branch-local service。MAP 需要的是系统级 shared-service runtime pool，但远程 CDS state 里同时存在两件相互冲突的事实：

- `prd-agent` 仍残留 branch-local `claude-agent-sdk-runtime-v2-prd-agent` service。
- `shared-sidecar-pool-mp4anabh` 是 `kind=shared-service`，但没有 running branch/service，也没有可用 remote host。

因此 MAP 在控制面上没有稳定的官方 SDK runtime pool 可发现，只能持续看到业务分支上的 sidecar 残留。这就是“侵犯主系统 MAP”的实际来源。

## 当前证据

只读远程审计显示，以下 `prd-agent` 分支仍存在 branch-local sidecar contamination：

- `prd-agent-main`
- `prd-agent-codex-cds-agent-workbench-ui`
- `prd-agent-claude-redesign-ui-layout-awndl`
- `prd-agent-claude-fix-gallery-stats-csu9h`
- `prd-agent-claude-great-keller-htqwh`
- `prd-agent-cursor-marking-line-agent-e307`
- `prd-agent-claude-sync-sidebar-user-names-fslel`

共享池状态：

- `shared-sidecar-pool-mp4anabh.kind = shared-service`
- `branchCount = 0`
- `runningBranchCount = 0`
- `runningServiceCount = 0`
- `runningInfraServiceCount = 0`
- `/api/cds-system/remote-hosts` 返回 `hosts=[]`

最新证据目录示例：

- `/tmp/cds-agent-runtime-pool-evidence-20260518150655`

其中 `summary.json` 明确显示：

- `BRANCH_LOCAL_SIDECAR_CLEAN = contaminated:7`
- `REMOTE_HOST_AVAILABLE = missing`
- `SHARED_POOL_RUNNING = missing`
- `remoteHostPoolPreparation.status = missing_config`

## 为什么前面修复后还会复发

前面的修复主要解决了代码路径，但没有把远程存量 state 清掉，也没有把 shared-service runtime pool 真正恢复起来。

已经修掉的代码面包括：

- 本地 compose 不再声明 branch-local agent runtime sidecar。
- MAP API env 不再指向 branch-local `CLAUDE_SIDECAR_BASE_URL`。
- CDS compose parser 会跳过 agent runtime sidecar import，避免再次把 sidecar 写进业务项目服务。
- runtime-status、goal audit、shared-service pool smoke 已能暴露当前 blocker。

仍未完成的远程状态面包括：

- `prd-agent` 远程 BuildProfile/service residual 仍保存了历史 branch-local sidecar。
- shared-service pool 没有 remote host，因此没有地方部署官方 SDK runtime。
- 没有 running shared sidecar instance，MAP discovery 仍然找不到系统级 runtime。

所以复发不是因为某个页面又写错了，而是“代码防线”和“远程控制面状态”之间没有闭环：代码已经开始禁止新增污染，但旧污染仍在；共享池设计已经存在，但运行承载层为空。

## 哪个结构出问题

出问题的是 runtime ownership 边界。

正确结构：

```text
MAP / prd-agent
  只负责控制面：session、profile、审批、事件、日志、取消、workspace 上下文

shared-sidecar-pool
  负责系统级 official SDK runtime instance

Claude Agent SDK
  负责真正 agent loop、tool loop、模型交互
```

错误结构：

```text
prd-agent branch service
  同时跑业务 api/admin
  又挂 claude-agent-sdk-runtime-v2-prd-agent
```

一旦 sidecar 被建成业务项目的 branch service，它就会跟随 `main`、feature branch、preview deploy 一起复制、显示、失败和重启。它自然会污染 MAP 主系统，因为 CDS 认为它是业务项目的一部分，而不是共享基础设施。

## 为什么屡被侵犯

根因有四个：

1. **资源模型混淆**：shared-service runtime 和普通 branch preview service 使用了相近的 deploy/profile/display 通路，历史上允许 sidecar 进入 `prd-agent` BuildProfile。
2. **缺少负向门禁**：过去只验证“runtime 能不能跑”，没有把“不允许 branch-local sidecar 出现在业务项目”做成发布阻断。
3. **远程状态不可见**：页面能显示端口和服务，但没有把 `branch-local contamination`、`remote host missing`、`shared pool not running` 合并成一个执行面板。
4. **恢复顺序错误风险**：如果先反复 redeploy preview，而不是先清理业务项目 residual、再恢复 shared pool，就会继续把注意力花在短周期构建上，污染本身不会消失。

## 当前阻断点

下一步不能靠继续部署 `prd-agent` preview 解决。正确顺序是：

1. 清理 `prd-agent` 业务项目里历史残留的 `claude-agent-sdk-runtime-v2-prd-agent` BuildProfile/service。
2. 登记至少一个 enabled remote host。
3. 在 remote host 上部署 official SDK runtime sidecar，恢复 `shared-sidecar-pool-mp4anabh` 的 running instance。
4. 重新跑 MAP runtime-status、R0/S1/S2/S3 和 one-cycle。

禁止路径：

- 不要把 `claude-agent-sdk-runtime` 写回 `prd-agent` compose services。
- 不要让 MAP 默认指向 branch-local `CLAUDE_SIDECAR_BASE_URL`。
- 不要用普通 `branch deploy` 把 `shared-sidecar-pool-mp4anabh` 当作业务 preview 恢复。

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

remote host 准备 dry-run：

```bash
CDS_HOST=https://cds.miduo.org \
  bash scripts/prepare-cds-agent-remote-host-pool.sh
```

执行清理或创建 remote host 都是写远程状态的动作，必须带 evidence wrapper，并在完成后立即跑 post-check。没有 post-check 的“修复”不能算完成。
