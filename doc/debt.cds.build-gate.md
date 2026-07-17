# CDS 构建闸（build-gate）· 债务台账

> **版本**：v1.0 | **日期**：2026-07-16 | **状态**：进行中（核心修复已上线，遗留项均为低优先级打磨）

## 总览

2026-07-16 CDS 构建队列堵死事故（线上 `active=3 / queued=54`，agent 部署排队 50 分钟以上）的系统性修复
已在 PR #1160 落地并自更新到线上：build-gate 可取消 + holder 身份、极速版跳闸、就绪探测容器活性早退、
层内 fan-out allSettled + 共享 abort、manual deploy 合并、run 账本周期收割 + 部署静默期节流心跳、
健康纯函数 + 探针端点 + 看门狗 + 定时回归任务、热重启等待页真实进度。

教训已固化为规则：`.claude/rules/concurrency-gate-discipline.md`（并发闸五件套设计纪律）。
本台账记录修复中**有意延期**的边界项，防止下一次 session 无人记得。

模块范围：`cds/src/services/build-gate.ts`、`build-gate-health.ts`、`deploy-layer-runner.ts`、
`branch-operation-coordinator.ts`、`deployment-run.ts`、`cds/src/routes/branches.ts`、`cluster.ts`、
`cds/src/index.ts`、`cds/src/services/proxy.ts`。

## 已知边界 / 待补（open）

| # | 债务 | 说明 | 影响 |
|---|------|------|------|
| 1 | `pendingWebhookDeploys` 命名滞后 | coordinator 的待部署队列字段仍叫 `pendingWebhookDeploys`，但 2026-07-16 起 manual deploy 也会合并进来（`isMergeableManualDeploy`），名字与语义不再对齐。更名涉及状态持久化字段与多处消费方，为控制修复 PR 面积而延期 | 仅可读性；不影响行为 |
| 2 | `run.heartbeatAt` 未拆分排队/执行心跳 | 排队刷新与真实执行共用同一个 `heartbeatAt`。修复后僵尸 waiter 15s 内出队、心跳自然停，闭环成立；但「排队心跳」与「执行心跳」语义仍混在一个字段里，未来若引入更长排队周期需拆 `queueHeartbeatAt`，避免长排队 run 与执行中 run 在收割器口径上纠缠 | 当前闭环下无实际影响 |
| 3 | holders/waiters 无运维 UI | `GET /api/cluster/status` 已透出 `buildGate.holders[]/waiters[]` 明细（branchId/profileId/runId/持槽时长），但 cluster/ops 前端面板尚未渲染，排障需直接看 API | 排障便利性；数据面已就绪 |
| 4 | 健康阈值硬编码 | `evaluateBuildGateHealth` 的阈值（queued≥15、holder≥45min、stale-run≥30min）为常量，未走系统级设置。当前值基于事故数据（queued=54 必红、正常构建 ≤20min）留有余量，暂无调整需求 | 需调整时改代码重发版 |
| 5 | merged 部署完成后无自动通知 | 前端对 merged 请求已如实展示「已合并为待部署」且不再打开旧预览（Codex P2 x2），但重放的那次部署真正完成时没有主动通知/自动打开预览，用户需自行回来看分支状态 | 体验打磨；靠分支列表状态刷新兜底 |
| 6 | 续约过期时 pending 被取消而非派发 | force-rebuild 续约 5 分钟过期时（`getUsableReservedContinuation` 惰性清理），挂在其后的 pending 部署一并取消（含 warn 事件留痕）。撞续约的重放已改为重新合并不丢（Codex P2），但「续约过期」这一小概率出口仍会取消 pending——改为过期即派发需要协调器持有派发通道，属结构调整 | 5 分钟窗口 + 续约方几乎立即接续，触发概率低；事件日志可见 |

## 修复主线（已完成，供回溯）

六根因 → 修复对照：僵尸排队（无取消）→ AbortSignal + isCancelled + 租约 tick 传导；极速版白占槽 →
prebuilt 跳闸 + 源码回退前补闸；崩溃容器空等 1200s → 就绪探测每 5 轮 inspect、连续 2 次死亡即放槽；
Promise.all 兄弟泄漏 → `runLayerWithSharedAbort`；manual 重试风暴 → 合并为 last-writer-wins pending
（限部署类在途、无 versionId）；账本无周期收敛 → 5 分钟 `reconcileInterrupted` + 30s 节流部署心跳。

常态回归三层：CI vitest 门禁（事故值 queued=54 必红断言）+ 进程内看门狗（60s 采样写事件日志）+
CDS 定时任务「构建队列健康回归」（30 分钟探测 `GET /api/cluster/build-gate/health`，退化 503 红灯）。

## 相关

- 规则：`.claude/rules/concurrency-gate-discipline.md`
- PR：#1160（含 Codex 四轮 8 条审查意见的逐条修复）
- changelog：`changelogs/2026-07-16_cds-build-gate-overhaul.md`
