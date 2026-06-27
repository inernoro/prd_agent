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

## 其它 #940 评审延期项（cluster/UI 可见性，非安全阻塞）

下列均为本 PR 新增「构建历史元数据 / 极速版告警」的**可见性/准确性**边界，非安全回归，集中在 cluster/executor
或前端渲染，沙箱无法端到端验证，故记债务、不在 PR #940 内强行接线：

| # | 债务 | 现状 | 影响面 |
|---|------|------|--------|
| 2 | 远端 executor 部署的 commit SHA 不回传 | `/exec/deploy` 完成 SSE 只把 SHA 放进 `title` 字符串、未放进 `data/detail`；master 侧 `opLog.commitSha` 拿不到 executor `pull()` 的真实 HEAD，cluster 手动部署历史「版本」列可能停在派发前旧 SHA（Codex P2）。**本地/主 deploy 路径已修**（源码 pull 后 opLog 以 pulledSha 为准，不再冻结在 requestCommitSha）。根治需改 executor SSE 协议：complete 事件 data 带 `pullResult.afterFull` | 仅 cluster；单机 master 不触发 |
| 3 | 远端 executor 部署的 deployMode 不回传刷新 | executor-proxy 的 opLog.deployMode 在构建前按 master 现有 profiles 冻结，executor 真实 `deployedMode`（含 express→source 回退）不回传，远端历史「部署类型」列可能显示旧值（Codex/Bugbot）。本地路径已按实际 ran profiles 重算 | 仅 cluster |
| 4 | TYPE1 极速版落后告警在分支卡片不可见 | 看门狗对「ciImageStatus=ready 但 ciTargetSha≠HEAD 且含运行时改动」写 `ciImageError`、status 保持 `ready`；分支卡片 UI 只在 `ciImageStatus==='failed'` 渲染 error 文案，故该告警目前只进系统事件日志/字段、不在主分支列表醒目显示（Codex P2）。根治需前端加 ready-with-error 渲染路径，或引入 `stale` 状态枚举（涉 enum 全栈涟漪，见 `enum-ripple-audit.md`） | UI 可见性；告警本身已落库/落日志 |

根治原则同 #1：等有可验证的 executor 集群环境 + 前端可视验收时按上表补；当前不在安全可验证范围内加未测代码。

## 相关

- `cds/src/services/deploy-stuck-reconciler.ts` —— 看门狗纯函数 SSOT
- `cds/src/services/build-log-meta.ts` —— 构建历史元数据纯函数（commit/mode/触发器，已单测）
- `doc/debt.cds.ci-prebuilt.md` —— 极速版（CI 预构建）债务（同属 cluster/部署模式族）
- PR #940 评审：Bugbot #228（关）、Codex #233（开）；#2-#4 见 PR #940 review threads
