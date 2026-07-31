# CDS 生产发布系统 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-28 | **状态**：开发中

**一句话**：发布系统曾因执行体不受管而永久锁死发布目标，本文记修复主线、真实环境证据与仍缺的证据。
**谁该读**：接手发布系统的工程师；关心发布可靠性的人。
**读完能做什么**：知道锁死问题是怎么根治的，以及还缺哪些证据。

---

## 总览

生产发布系统（`ReleaseTarget` / `ReleaseRun` + SSH 执行）在 2026-07-28 之前存在一个会让
**发布目标永久锁死**的结构性缺陷：执行体是一个不受管的内存 Promise（`void this.runRelease(...)`），
CDS 自更新或重启把它连同进程一起抹掉，`ReleaseRun` 永远停在 `running`；而在途守卫会因此拒绝
该目标的一切新发布，当时既没有取消、没有执行超时、也没有心跳收割——只能改库才能复活。
自更新是 CDS 的日常操作，不是理论风险。

PR #1273 落地了**阶段一（止血）**：心跳 + 中断收敛 + 执行超时 + 取消端点 + 状态机断言 +
结构化失败 + 排空覆盖发布 + 并发闸（发布与回滚共用 `assertTargetFree`）。

本台账记录阶段一**有意延期**的边界项，以及**尚未取得真实环境证据**的行为，
防止下一次 session 把「有单测」误当成「已验证」。

模块范围：`cds/src/services/release-service.ts`、`cds/src/routes/releases.ts`、
`cds/src/services/deploy-drain.ts`、`cds/src/server.ts`（收割器接线 + 排空闸）。

## 已知边界 / 待补（open）

| # | 债务 | 说明 | 影响 |
|---|------|------|------|
| 1 | 执行超时是 per-command 而非 per-run | `RELEASE_EXEC_TIMEOUT_MS`（默认 30 分钟）挂在**单条 SSH 命令**上。默认脚本链 `./fast.sh && ./exec_dep.sh` 会被拆成两条命令各自计时，最坏总耗时是单命令上限的两倍 | 极端卡死场景下收敛时间翻倍；心跳收割（15 分钟）仍会兜住，不会永久锁死 |
| 2 | 取消只掐断 CDS 侧 SSH，不保证远端脚本停止 | `cancelRelease` abort 的是本机的 ssh2 连接；远端已经拉起的发布脚本进程不受影响，可能继续跑完。需要远端脚本侧配合（写 pid 文件 / 响应信号），属阶段四议题 | 取消后目标机器上可能仍在变更。已在 failure 的建议动作里写明「确认目标主机上的脚本是否已中断」 |
| 3 | 健康探测窗口无心跳 | 心跳只在 `sshExec` 执行期打点；健康探测与自动恢复窗口（≤8s 量级）没有心跳。远低于 15 分钟阈值故当前安全，但若未来引入长探测需补打点 | 当前无影响；引入长探测时必须同步补 |
| 4 | 预检跑两遍 | 向导调一次 `preflight`，`startRelease` 内部再跑一次。重复的 SSH 探测与健康检查，收敛属阶段三 | 发起一次发布多几秒；无正确性问题 |
| 5 | 结构化失败未上 UI | `run.failure` 已带 `owner` / `retryable` / `suggestedAction` / `code`，但前端仍只展示 `errorMessage` 摘要。暴露属阶段二 | 用户拿不到「该谁修、能不能重试、下一步做什么」 |
| 8 | 发布健康快照有一个探测间隔的滞后 | 发布中心不再实时探测生产，改读存活监控台账（`release-health-snapshot.ts`）。代价是健康显示最旧可能滞后一个探测间隔（默认 60s），且刚建的目标在首轮探测前只能显示「等待首次探测」 | 用不再放大请求换来的确定性延迟；比「每次打开页面都打生产、结果还不记账」划算。要即时结果就去状态页看采样曲线 |
| 10 | **远端产物自动回收默认开启，且会在生产机器上执行删除** | 阶段三新增。`release-remote-watcher` 每轮调 `reclaimRemoteReleaseArtifacts`，对超出保留窗口的 worktree 走 `git worktree remove --force`、对 static 成品目录走 `rm -rf`。这是本仓库**唯一**一处默认开启、定时无人值守、在生产机上删东西的路径 | 逃生阀 `CDS_RELEASE_ARTIFACT_RETENTION=0` 只巡检不回收。八条安全边界见 `release-artifact-retention.ts` 头部；其中五条（current/previous 落在淘汰位仍受保护、读不回来不删、台账为空不删、auto-restore 派生目录受保护、脏条目进不了删除计划）有对抗性回归 `tests/services/release-reclaim-adversarial.test.ts`，并逐条红检过 |
| 11 | auto-restore 回溯到的原始版本不进保护集 | `current -> <failed>-auto-restore` 时，drift 判定会回溯到 `previousReleaseId` 指的原始版本，但回收的保护集只保派生目录本身。**这是取舍不是疏漏**：发布脚本里 `worktree="$worktree_root/$CDS_RELEASE_ID"`，自动恢复那次用的是 `-auto-restore` 这个 id，因此它是一棵独立 worktree，删掉原始版本不影响正在服务的那份 | 代价仅是「日后真要回滚到该版本时，脚本的 `if [ ! -d "$worktree" ]; then git worktree add` 会从 git 重新长一次」，多一次 checkout。若将来 auto-restore 改成复用原目录，这条必须立刻改成保护 |
| 12 | 共用目录的产物归属只能从 run 台账反推，台账被裁剪后就永远推不出来 | 两个目标真共用同一 `host + publicDirectory` 时（`isSameRemoteDirectory` 判真），回收要靠「这个产物 id 属于谁」才敢删，而当前唯一的归属依据是 run 台账。run 台账有保留上限，老 run 被 `pruneReleaseRuns` 裁掉之后，远端那些老产物 id 在两个目标看来都「不认识」，于是双方永远 defer，`.releases` / worktree 目录无界增长 | 失效方向是**保守的**：只会漏删，不会误删别人的生产产物。真修需要一份独立于 run 的产物归属账（回收时写、不随 run 裁剪），或把远端产物按 targetId 分命名空间；两者都超出本轮范围，故记账不改 |
| 9 | 无告警外发（与存活监控同一笔债） | 发布 started / succeeded / failed / rolled-back 已上 `cds-events-bus`，`isAlertCdsEvent` 也已把 failed / rolled-back 标成告警级；但 CDS 至今没有任何外发通道（站内通知 / Webhook / 邮件），见 [doc/debt.cds.md](./debt.cds.md) 债务 2-1 | 关掉页面后发布失败**能被记录、能被订阅**，但不会主动叫醒人。接通道时只需 `subscribe` + `isAlertCdsEvent`，不许再判一遍事件名 |
| 6 | 收割器实例与执行实例不同 | `server.ts` 的周期收割用的是**独立 new 出来的** `ReleaseService`，与路由里执行发布的不是同一个实例，故其 `inFlight` 恒为空。当前靠心跳阈值判定，行为正确；但 `reconcileInterruptedReleases` 里那句 `this.inFlight.has(...)` 对收割器而言是死代码 | 无行为影响；语义容易误导后来人 |
| 7 | `DrainableReleaseStatus` 并了两个过渡期成员 | 类型并上 `cancelled`（取消能力落地后可能进联合）与 `prechecking`（已删的死状态），让两侧独立演进不互相卡编译。并集不削弱穷尽性 | 仅可读性 |
| 13 | 定时发布的「人工确认」没有服务端待办账本 | 2026-07-29 新增。`ScheduledJobTarget.release.requireApproval` 的语义是「到点只跑预检 + 发一条 `release.schedule.approval-required` 站内信，永不自动发布」，人看到通知后**手动**去发布中心点发布。没有「批准/驳回」这两个动作，也没有待办状态 | 语义是 fail-safe 的（永远不会因为没人批准而误发），但「谁批了、什么时候批的」没有审计记录。真做需要服务端待办账本 + 审批端点，列 v2 |
| 14 | 定时发布只在单进程内去重 | `ScheduledJobService` 的去重是实例内 `running: Set` + `claimScheduledOccurrence` 先推进 `nextRunAt`。蓝绿 promote 期间若出现双 daemon 同时活跃，同一 occurrence 可能被抢两次 | 兜底是 `ReleaseService.isTargetBusy` 与 `assertTargetFree` 的 state 级判据（读的是共享台账，跨实例可见），第二次会记 `skipped` 而不是并发部署。可接受 |
| 15 | 定时发布超时后不知道最终结果 | 任务超时（默认 3600s）只把 `ScheduledJobRun` 记成 failed 并写明 `releaseId`，**绝不**调 `cancelRelease`（调度器不是发布的主人）。发布本身可能随后成功 | 任务运行记录会留一条假失败，需要人点进 releaseId 看真实结果；连续 2 次假失败还会触发规则自动停用。缓解办法是把 timeoutSeconds 设得高于发布 P95 |
| 16 | 定时发布的前端只做只读 + 启停 | 本轮 `TaskSchedulePage` 只让 release 规则「看得见、能启停、能看运行记录 + 自动停用原因」，动作弹窗对 release 是只读摘要；创建与编辑目前只能走 API。完整表单在发布中心「自动发布」页签落地（前端轨道） | 编辑路径已防数据丢失（`ActionForm.release` 原样回传 + 类型分段控件对 release 隐藏），不会因为在本页改个名字就把发布配置抹掉 |

## 真实环境证据（2026-07-28 已补齐）

阶段一的四条关键行为此前**只有服务层单测**（ssh 执行器是注入的假实现，路由被绕过）。
现已用**真 sshd + 真 ssh2 + 真 express 路由**跑通端到端，并逐条做了红绿闭环
（把修复改回事故行为，确认对应用例变红）：

| # | 行为 | 证据 | 红检 |
|---|------|------|------|
| A | 取消后目标保持占用，直到执行体退出 | `cds/tests/routes/release-ssh-e2e.test.ts` | 去掉 `findSettlingExecution` 判定 → 红 |
| B | 取消后不执行自动恢复（不再写目标机器） | 同上（先造一次成功发布让 `previousReleaseId` 成立，否则断言是空跑） | 去掉 `isCancelled` 抑制 → 红（真的多出一次 SSH 写入） |
| C | 回滚走与发布同一道并发闸 | 同上 | 去掉 `assertTargetFree(…, '回滚')` → 红 |
| D | 排空期间 `/releases/*` 拿 503 | 同上 | 从 `isDrainBlockedPath` 去掉 `/releases/branches/:id/runs` → 红 |

复现方式（本机起 sshd，CI 上没有则整套自动跳过）：

```bash
mkdir -p ~/.cds-release-e2e
ssh-keygen -t ed25519 -N '' -f <dir>/hostkey -q
ssh-keygen -t ed25519 -N '' -f ~/.cds-release-e2e/clientkey -q
cat ~/.cds-release-e2e/clientkey.pub >> ~/.ssh/authorized_keys
/usr/sbin/sshd -f <dir>/sshd_config   # Port 2222, ListenAddress 127.0.0.1
cd cds && pnpm vitest run tests/routes/release-ssh-e2e.test.ts
```

私钥路径可用 `CDS_RELEASE_E2E_SSH_KEY` 覆盖，端口用 `CDS_RELEASE_E2E_SSH_PORT`。
**判断有没有真跑**看耗时：真连 sshd 是秒级（约 3.5s），7ms 那种是跳过。
默认路径最初写成了一个 session 级的 scratchpad 绝对路径，换一次会话目录就没了，
`existsSync` 失败即静默跳过，整套变成三个空跑的绿灯——而本节正引用它当证据。
**一个不会红的证据比没有证据更糟**，所以跳过时现在会打印到底是缺 key 还是没 sshd。

两个时序细节值得记（都是写测试时踩出来的，不是猜的）：

1. **取消必须发生在健康探测阶段**，不能在 SSH 执行阶段。SSH 侧 abort 是**干净生效**的：
   `sleep 90` 被 cancel 立刻掐断，执行体毫秒级 settle，此时放行新发布**完全正确**。
   真正会出问题的是 `probeReleaseSurface`——普通 HTTP 请求，不接 abort。
2. **`startRelease` 先跑 preflight、再过并发闸**。所以测并发闸时，被挂住的健康端点必须
   只挂住「那一次在飞的探测」，后续探测照常 200；否则新发布会先被预检的
   「上线地址可访问」挡下，测到的是预检而不是闸。

## 仍未取得证据（open）

| # | 行为 | 缺什么 |
|---|------|--------|
| E | 网关（C#）附件转发到缺陷系统 | 本地无 dotnet，只有源码守卫 + CDS 构建的编译验证。等价逻辑的 **TypeScript 侧**已用真 HTTP 假 MAP 服务端到端验过（`cds/tests/routes/bug-report-forward-e2e.test.ts`，断言 create → attachments → submit 的真实顺序与字节） |
| F | 取消对**远端**脚本进程的影响 | 见「已知边界 #2」：需要远端脚本侧配合，属阶段四 |

## 修复主线（已完成，供回溯）

病根 → 修复对照：执行体随进程消失 → `heartbeatAt` + `reconcileInterruptedReleases`（启动轮
`assumeAllOrphaned` 收敛全部非终态，周期轮保留心跳阈值以免误杀）；无执行超时 → `sshExec` 挂
abort 定时器（预检类用 60s 短超时）；无法取消 → `cancelRelease` + AbortSignal，且**摘牌交给
`execute()` 的 finally**（abort 只是「请你停」，探测不接 abort，提前摘牌会让下一次发布与老执行体
并发写）；状态机无守卫 → `patchStatus` 唯一写入口 + 穷尽式转移表断言；失败只有字符串 →
复用分支侧 `DeploymentFailure` + 委派既有分类器；排空不知道发布存在 → `collectDrainableRuns`
合并两条生命周期，闸提到 app 级由 `isDrainBlockedPath` 唯一判定（路由器级只罩得住自己那一半）。

排空闸另修一处既有缺陷：`endSelfUpdateDrain()` 此前是**从未被调用过的死代码**，一次没真正重启
进程的自更新（fast-forward / spawn 静默失败）会把部署闸晾满 fail-open 窗口（默认 6 分钟），
期间每次 webhook 部署都拿 503 + 红灯 CI（本 PR 2026-07-28 实际中招一次）。现补：spawn 失败
且不退出时立刻开闸 + 15 秒看门狗。

## 相关

- 计划：[doc/plan.cds.release-system.md](./plan.cds.release-system.md)（四阶段方案与看板）
- 规则：`.claude/rules/concurrency-gate-discipline.md`（并发闸五件套）、
  `.claude/rules/server-authority.md`（长任务与请求生命周期解耦）、
  `.claude/rules/production-release-safety.md`（生产发布安全触发）
- PR：#1273（含 Codex 七轮 20+ 条 P1/P2 的逐条修复）
- changelog：`changelogs/2026-07-27_cds-trunk-protection-uptime-loadtest-bugreport.md`
