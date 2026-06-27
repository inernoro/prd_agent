# CDS executor 卡死看门狗 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-27 | **状态**：进行中（cluster-only，生产单机 master 不受影响）

## 总览

PR #940 让通用部署卡死看门狗（`reconcileStuckDeployStates`）在 master 与 executor 两种模式都跑。
master 的部署（本地 + 远端代理）都持 `BranchOperationCoordinator` 租约，看门狗的 `hasActiveOperation`
判活准、`allowHardTimeout` 可安全开启。**executor 节点不持该租约**，于是当前用 `allowHardTimeout:
isMaster` 在 executor 上**关闭硬超时**，只做时间戳证据收敛 + 告警。

模块范围：`cds/src/services/deploy-stuck-reconciler.ts`、`cds/src/index.ts`、`cds/src/executor/routes.ts`。

## 已知边界 / 待补（open）

| # | 债务 | 说明 | 影响 |
|---|------|------|------|
| 1 | executor 卡死构建无人硬超时 | Bugbot High #228 要求关 executor 硬超时（无租约判活，怕误杀 >45min 合法远端构建）；Codex P2 #233 反向要求开（否则 executor 卡在 building/starting 的构建永不被收敛）。两条机器人评审结论冲突。当前取保守侧（关），代价是 executor-owned 分支若真卡死，本地看门狗不会把它收敛成 error，要等 master 侧或人工介入 | 仅 **cluster 模式**；生产是单机 master、executor 未启用，无实际影响 |

## 根治方案（待实施）

给 executor 加「本地在途部署感知」，同时满足两条评审：

1. `cds/src/executor/routes.ts` 维护一个模块级 `Set<branchId>` 记录正在跑的 `/exec/deploy`（deploy 开始时 add、finally 时 delete）。
2. `cds/src/index.ts` executor 模式下，看门狗的 `hasActiveOperation` 改读这个 Set（而非 master 的 coordinator），并把 `allowHardTimeout` 在 executor 也设为 true。
3. 效果：部署进行中 → `hasActiveOperation=true` → 整条跳过（不误杀，满足 #228）；部署结束/从未开始却卡死 → `hasActiveOperation=false` → 硬超时可收敛成 error（满足 #233）。

未在 PR #940 内实施的原因：本沙箱无法端到端验证 executor 集群模式（CLAUDE §8.1 自测优先），不在安全可验证范围内加未测的集群管线代码。等真正启用 executor 集群、有可验证环境时按上方方案补。守卫：`reconcileStuckDeployStates` 的 `hasActiveOperation` / `allowHardTimeout` 单测已覆盖核心逻辑，补 executor 接线时复用。

## 相关

- `cds/src/services/deploy-stuck-reconciler.ts` —— 看门狗纯函数 SSOT
- `doc/debt.cds.ci-prebuilt.md` —— 极速版（CI 预构建）债务（同属 cluster/部署模式族）
- PR #940 评审：Bugbot #228（关）、Codex #233（开）
