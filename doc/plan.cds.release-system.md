# CDS 发布系统改进 · 计划

> **版本**：v1.1 | **日期**：2026-07-28 | **状态**：阶段一二已落地，阶段三进行中

**一句话**：发布系统改进的三个阶段各自的判据与当前进度，含唯一一处需要特别说明的取舍。
**谁该读**：接手发布系统的工程师。
**读完能做什么**：判断当前离可发布还差什么。

---

## 〇、状态看板

> 最后更新：2026-07-28 | 轨道：单轨（claude/workflow-issues-verification-8pkmcq）
> **距离可发布**：阶段一二三均已达成各自判据。阶段三引入了本仓库唯一一处
> **默认开启、无人值守、在生产机器上执行删除**的路径（远端产物回收），安全边界与
> 对抗性回归见 [doc/debt.cds.release-system.md](./debt.cds.release-system.md) 债务 10；真出事的逃生阀是
> `CDS_RELEASE_ARTIFACT_RETENTION=0`（只巡检不回收，改环境变量重启即可，不必发版）。
> 阶段四需单独立项，理由见下方判断。

| 阶段 | 进度% | 状态 | 当前 blocker | 下一步 | 验收证据 |
| --- | --- | --- | --- | --- | --- |
| 一 止血 | 100 | 已验收 | 无 | — | PR #1273（Codex 七轮 20+ 条逐条修复）；真 sshd 端到端四条行为 A/B/C/D 逐条红绿闭环，见 [doc/debt.cds.release-system.md](./debt.cds.release-system.md)「真实环境证据」 |
| 二 可见 | 100 | 已验收 | 无 | — | 四条判据逐条核过：`第 N/M 步 · 标题` + ETA 同屏（`ReleaseCenterPage.tsx`）；事件上 `cds-events-bus` 且 `isAlertCdsEvent` 收敛告警判定；状态页生产目标独立分组出 24h 柱条；发布中心实时探测数 = 0（`tests/routes/releases-center-health-snapshot.test.ts`，红检确认改回实时探测即红） |
| 三 记账 | 100 | 已验收 | 无 | — | 七轮 Codex 审查收口（P1 8 条 / P2 12 条，逐条红绿闭环，见 PR #1281 收口小结）。四条判据逐条实测：落盘 1200 行从 1200 次降到 24 次（红检确认改回每行一落即 1200）；200 条 run 入库后按目标收敛到 100 且回滚链完整；`GET /releases/center` 带 DORA 四项且无样本恒 `null`；漂移告警 `release.drift-detected` 已上总线且 `isAlertCdsEvent` 为 true。远端回收另有对抗性套件 `tests/services/release-reclaim-adversarial.test.ts`（6 例，红检确认摘掉符号链接保护即红 4 例） |
| 四 架构升级 | 0 | 未开始（需单独立项） | 依赖不可变产物链路改造，工作量大 | 见本节下方「阶段四判断」 | — |

**阶段四判断**：不在本轮做，也不建议顺手起个头。它要把发布从「在生产机重新构建」改成「消费预览阶段已验证的
`DeploymentVersion` 不可变产物」，牵动构建、镜像仓库、回滚语义、compose 切流建模、分支保护五处，
且做一半的形态（产物链路建了但回滚仍走重建）比不做更危险——两条回滚路径并存时，
出事那一刻没人说得清走的是哪条。按计划第五节的「要单独立项」执行：等阶段三的漂移检测与 DORA 有了数据，
再用真实的失败率/恢复时长决定它的优先级。

## 一、管理摘要（30 秒）

CDS 里有两条交付链路：**分支预览部署**和**生产发布**。前者已经被线上事故打磨过——有状态机校验、心跳、卡死收敛、结构化失败归因、不可变版本台账、并发闸健康探针；后者是一层薄壳：一个不受管的内存 Promise、一个字符串错误、一屏 SSH 滚屏日志。用户说"发布系统有点 low"，指的就是这条真正上生产的路，反而是全系统里工程水位最低的一条。

**最尖锐的问题不是难看，是会卡死。** CDS 自更新或重启时，在途发布的执行体随进程消失，`ReleaseRun` 永远停在 `running`；而在途守卫会因此拒绝该目标的一切新发布，且没有取消接口、没有超时、没有心跳收敛——这个发布目标从此发不出去，只能改库或归档。自更新是 CDS 的常态操作，这不是理论风险。

**第二个问题是发布完就失联。** 生产健康的唯一信号是"有人打开发布中心时现场探一次"。刚落地的存活监控（uptime-monitor）只盯分支预览，不盯生产目标；发布事件也不上全局事件总线，失败没有任何外发告警。

**打算怎么补**：不新起炉灶，把 CDS 自己已经建成的部件对准生产发布——`deployment-run` 的心跳与收敛范式、`deployment-failure-classifier` 的失败归因、`uptime-metrics` 的采样聚合、`deployDurationSamples` 的耗时台账、`cds-events-bus` 的事件外发。分四阶段：**先止血（不再卡死、失败说人话）→ 再可见（进度、ETA、生产存活、告警）→ 再记账（预检落库、日志有界、产物回收、DORA）→ 最后才动架构（不可变产物直达生产、切流建模）**。

**明确不做**：金丝雀统计分析、按比例流量切分、K8s 百分比滚动、完整 GitOps 仪式。CDS 是单机 Docker、单副本、无指标后端，这四样硬搬只增复杂度不产收益，理由见第六节。

---

## 二、用户会撞上什么

不讲机制，先讲一次真实使用里会踩到的四件事。

**一、发一半，CDS 自更新了，这个站点从此发不出去。** 发布执行体是 `void this.runRelease(...)`，进程一重启就没了，run 永远停在 `running`。下次点发布，收到一句"该发布目标已有进行中的发布（rel_xxxx，状态 running），请等待其完成后再发起"。等不到——没有超时（SSH 只有 10 秒**连接**超时，发布命令本身无执行超时）、没有取消端点（发布路由里压根没有 cancel/abort）、没有周期收割（发布服务里 heartbeat/stale/reconcile 三个词零命中）。同样的事在分支部署上不会发生：那边有 `heartbeatAt` + `reconcileInterrupted` 15 分钟过期 + 服务器每 5 分钟收割。而自更新前的排空 `deploy-drain.ts` 只认 `DeploymentRunStatus`，压根不知道 ReleaseRun 存在。

**二、点了发布，只能盯一屏 SSH 滚屏，不知道还要多久。** 发布中心整页 1604 行，`耗时 / elapsed / 进度 / ETA / 预计` 五个词零命中。步骤条不是后端给的，是前端把日志里的 `phase` 字符串收集成 Set 再倒着找最后一条 error 反推出来的，而且把本仓库自己的脚本名（`./fast.sh && ./exec_dep.sh`）写死进了 CDS 这个通用产品的前后端。换个项目，步骤条就退化成五个笼统格子。这直接违反仓库自己已成文的 `expectation-management.md`（"任何 >2s 等待都要给'在做什么 + 还要多久'"）——发布这种最需要预期管理的动作，是全系统预期管理最差的一屏。

**三、失败了要自己读 stderr 猜是谁的锅。** 失败只写一个 `errorMessage: string`。分支部署那边有 12 条规则的失败分类器，输出 `code / owner / retryable / evidenceRefs / suggestedAction`，发布侧一条都没接。

**四、发完就不管了。** 生产健康的唯一来源是 `GET /api/releases/center` 每次请求时对每个目标同步打一次 2.5 秒探测——不打开页面就没有任何健康判定，前端 12 秒轮询叠加多标签页还会持续打生产。刚落地的 uptime-monitor 数据源接口只有 `getAllBranches / getProject`，发布目标不在采样范围里。发布事件跑在私有的进程内 EventEmitter 上，不上 `cds-events-bus`，所以不进 Activity Monitor、不进系统日志、没有任何通知外发。

---

## 三、现状定位：一个系统，两条生命周期

| 能力 | 分支预览部署 `DeploymentRun` | 生产发布 `ReleaseRun` |
| --- | --- | --- |
| 状态机校验 | 有，`ALLOWED_TRANSITIONS` + `assertTransition` | 无，`patchStatus` 直写任意状态 |
| 心跳 / 卡死收敛 | 有心跳 + 15 分钟过期 + 5 分钟周期收割 + 45 分钟硬超时 | 全无 |
| 执行超时 | 有 | 无（只有 10 秒连接超时） |
| 取消 | 有 cancelled 终态 | 无端点、无终态路径 |
| 失败归因 | 结构化 `DeploymentFailure` + 规则分类器 | 一个 `errorMessage` 字符串 |
| 事件有界 | 上限 500 + `firstEventSeq` 截断标记 | 无上限，且每行日志一次落盘 |
| SSE 续传 | 标准 `id:` + `Last-Event-ID` | 只有 `afterSeq` 查询参数，无 `id:` 行 |
| 不可变版本台账 | `DeploymentVersion`，内容寻址 + 不可变镜像断言 | 完全不消费（release 三个文件 grep `DeploymentVersion` 零命中） |
| 重启前排空 | `deploy-drain.ts` 覆盖 | 不覆盖 |
| 并发闸纪律 | build-gate 五件套 + 健康探针 | 一个 if 拒绝，无排队、无持有者身份、无收敛 |

三条需要保留、不许在改造中动掉的现有正确设计：

1. 执行快照（模式 + 脚本 sha256 + 策略），且执行前会与预检快照比对、不一致直接拒绝执行。这是整个发布系统里最硬的一块审计证据。
2. static 模式远端脚本里的原子切换（`release-strategy.ts` 生成脚本里的 `current` / `previous` 符号链接替换）是真原子切换，不要退化。
3. SSE 流本身可用（`afterSeq` 续传 + 10 秒 keepalive），缺的是标准 `id:` 行，不是重写。

另外三条必须先说清的边界，避免下游误判：

- [doc/debt.platform.production-release.md](./debt.platform.production-release.md)（open = 0）和 [doc/rule.platform.production-release-safety.md](./rule.platform.production-release-safety.md) 讲的是 **MAP 自己的 `exec_dep.sh` 发布链**，不是 CDS 的发布系统。CDS 只是通过 `existing-script` 模式把它 SSH 跑一遍。不要把那份"零债务"当成 CDS 发布系统没有债务。
- 回滚**不会**因为分支被回收而失效（走远端 git，不依赖本地 worktree）。受损的只有策略重检测与证据可追溯。
- 目前 `doc/` 下**没有任何 CDS 发布系统的设计或规格文档**。两条生命周期之所以漂移到差一个代际，缺 SSOT 是结构性原因之一。本文补的就是这个缺口。

---

## 四、机制对照表

「市面怎么做」列只取机制，不取产品功能名；「适用性」按 CDS 形态（单机 Docker、单副本、分支预览为主、少量生产发布、无指标后端）判定。

| # | 机制 | 市面系统怎么做 | CDS 现状（file:line） | 差距性质 | 适用性 |
| --- | --- | --- | --- | --- | --- |
| 1 | 不可变、可寻址的发布单元 | Vercel/Netlify 的不可变部署实例；Heroku slug；K8s ReplicaSet | 分支侧有 `DeploymentVersion`（内容哈希 + 不可变镜像断言）；发布侧只有 `commitSha` 字符串，生产机上 `docker compose up -d --build` 重新构建 | 压根没有（但砖块已在隔壁） | 适用，价值最高 |
| 2 | 发布单元 = 制品 + 配置 | Heroku：改环境变量也生成新 release | 无。只改 env 的一次重启不进任何发布账本 | 压根没有 | 适用 |
| 3 | 期望态 / 实际态分离 + 漂移检测 | Argo CD / Flux 持续对账 | 远端脚本已经在生产机写了 `current` / `previous` 符号链接，CDS 从不读回；"当前生产版本"是每次请求扫 runs 现推 | 压根没有（真相已存在，只是没读） | 适用，成本低 |
| 4 | 双维状态（同步性 + 健康度） | Argo CD 的 Sync Status / Health Status 分离并逐层聚合 | 只有一个 run status；健康是一次性探针 | 压根没有 | 部分适用：先做"CDS 认知版本 vs 实际线上版本"这一维 |
| 5 | 切指针回滚（不重建） | Vercel 别名切换约 1 秒；Heroku 复制 slug 不重编译；K8s `rollout undo` | 分支侧有真回滚；发布侧 `existing-script` 模式回滚 = 跑用户另一条 shell，动态模式 = 用历史 commit 重新构建一遍 | 已有但不好用 | 适用，依赖机制 1 |
| 6 | 原子切换（无新旧混合窗口） | Netlify 明确保证原子 | static 模式已经是真原子；compose 模式是 `up -d` 就地替换，发布期间生产直接抖动 | 半有半无 | 适用（起新容器 → 就绪 → 切路由 → 停旧，即单实例蓝绿） |
| 7 | 就绪判据决定是否算发布成功 | K8s readiness + `minReadySeconds` | 有 `probeReleaseSurface`（8 秒超时）+ static 模式的同源 JS/CSS + MIME 校验——这条做得对 | 已有且可用 | 适用，保留 |
| 8 | 进度截止（卡住即失败）+ 失败保住旧版本 | K8s `progressDeadlineSeconds` 默认 10 分钟 | 无任何超时，卡住即永久锁死目标 | 压根没有 | 适用，必须有 |
| 9 | 发布前置钩子（迁移/预热），失败即中止 | Heroku release phase | 无独立钩子位；迁移只能混在用户脚本里 | 压根没有 | 适用，但排在后面 |
| 10 | 分阶段推进 + 显式人工门禁 | Spinnaker manual judgment | 无。生产发布甚至比配置类接口权限更松：`runs / rollback / retry` 三个执行类端点都不过 AI 越权拦截，而同文件的配置类端点过了 | 压根没有 | 生产路径适用；预览路径不适用（会毁掉即时性） |
| 11 | 保留策略显式化 | K8s `revisionHistoryLimit`；Heroku 30 天且最近 20 个 | 三处同时无界增长：远端 worktree / `.releases`、`state.releaseRuns`、`run.logs` | 压根没有 | 适用，单机硬约束 |
| 12 | 发布事件带版本标签外发 | Datadog deployment marker；OTel `service.version` | 发布事件不上 `cds-events-bus`，不进 Activity Monitor，无任何通知 | 压根没有 | 适用，成本极低 |
| 13 | 发布后持续健康监控 | 各家 uptime / SLO | uptime-monitor 已落地但只盯分支；发布目标只有"打开页面时探一次" | 已有但没对准 | 适用，接线成本远低于新建 |
| 14 | 发布 ↔ 故障关联归因 | Sentry release tracking 定位疑似引入提交 | incident 按分支目标 key 存独立文件，与 releaseId 无关联字段 | 压根没有 | 部分适用：先做"发布 ↔ incident 时间轴对齐" |
| 15 | 结构化失败分类 | 各家 CI/CD 的错误码 + owner + 是否可重试 | 分支侧有整套分类器；发布侧一个字符串 | 已有但没接 | 适用，纯接线 |
| 16 | 交付效能指标（DORA 四项） | Four Keys | 全仓 grep `dora / lead time / mttr / change failure / deployment frequency` 零命中 | 压根没有 | 适用；四项里三项现有字段就能算 |
| 17 | 百分比滚动更新（maxSurge / maxUnavailable） | K8s | 无 | — | **不适用原语**，只取单实例蓝绿退化形态（见机制 6） |
| 18 | 金丝雀 + 统计学自动分析 | Spinnaker/Kayenta、Argo Rollouts AnalysisRun | 无 | — | **不适用**：流量样本量不足，统计判据只会产出噪声 |
| 19 | 服务网格按比例分流 | Argo Rollouts / Spinnaker | 无 | — | **不适用**：单机无此基础设施 |
| 20 | 完整 GitOps 仪式 | Argo CD / Flux 全量声明 + PR 审批 | 无 | — | **只取"期望态可声明可对账"这一层语义**，不上仪式 |

关于 DORA 四项的可算性（用现有 `ReleaseRun` 字段核过）：发布频率、变更失败率、恢复时长（靠 `rollbackOf` 串链）三项**现有字段就够**；只有变更前置时间算不出——缺 commit 时间戳，发布时多取一次并存进 run 即可。

---

## 五、分阶段方案

依赖关系：阶段一 → 阶段二 → 阶段三；阶段四依赖阶段一的心跳与取消能力，可与阶段三并行。

### 阶段一：止血——发布不再卡死，失败说人话

**为什么排第一**：它修的是"这个发布目标从此发不出去"，比"UI 不好看"严重一个量级；而且全部有现成范式可抄（`deployment-run.ts` 那一套），不改架构。

| 交付物 | 做法要点 | 现成砖块 |
| --- | --- | --- |
| `ReleaseRun` 心跳 | 加 `heartbeatAt`，执行期周期刷新；长静默阶段（SSH 命令跑着）要节流打心跳，否则收割器误杀慢发布 | 照抄 `deployment-run.ts:159` |
| 中断收敛 | 启动时 + 每 5 分钟收割：心跳过期即收敛为 `failed`，写明"CDS 重启导致执行体丢失" | 照抄 `deployment-run.ts:203` + `server.ts:1415-1427` 已有的周期钩子 |
| 发布命令执行超时 | `sshExec` 增加执行超时（区别于现有 10 秒连接超时），超时即判失败并释放目标 | — |
| 取消端点 | `POST /api/releases/runs/:id/cancel`，终态化 run 并释放在途守卫 | — |
| 自更新排空覆盖发布 | `deploy-drain` 的终态判定扩展到 `ReleaseRunStatus`，重启前等待或拒绝 | `deploy-drain.ts:44` 的 `Record<Status, boolean>` 写法照搬（穷尽式，新增状态编译期报错） |
| 状态机校验 | 给 `patchStatus` 加转移合法性断言；顺手删掉从未被赋值的死状态 `prechecking` | 照抄 `assertTransition` |
| 失败结构化 | `failRun` 改写结构化失败，接入现有规则分类器 | `deployment-failure-classifier.ts` 是纯函数，直接调 |
| 两条合规补丁 | `retry` 端点补审计标签（登记表里漏了它，违反 `cds/CLAUDE.md` §0.1）；`runs / rollback / retry` 三个执行类端点补 `rejectUnscopedAiMutation`（当前比配置类端点权限还松） | — |

**验收判据**：模拟 CDS 在发布中途重启，run 在一个收割周期内收敛为失败且目标可再次发布；远端脚本 sleep 超过执行超时，run 判失败且释放；cancel 端点能终止在途发布；伪造非法状态转移的单测必红；至少三类典型失败（SSH 不通 / 脚本非零退出 / 健康探测失败）在 UI 上给出 owner + 是否可重试 + 建议动作。

**工作量**：中偏小。**依赖**：无。

### 阶段二：可见——过程有预期，发布完不失联

| 交付物 | 做法要点 | 现成砖块 |
| --- | --- | --- |
| 后端一等公民步骤模型 | 让执行器按发布计划里的 steps（**已定义但从不被读取**）汇报"第 N / 共 M 步"，前端不再正则日志反推 | `ReleasePlan` 已定义 |
| 去掉本仓脚本名硬编码 | 步骤来自 plan 而非 `./fast.sh` 字面量，CDS 恢复成通用产品 | — |
| 发布 ETA | 发布耗时进耗时台账并在 UI 出"预计还需 MM:SS（近 N 次中位）"。**注意**：现有 `DeployDurationMode = 'release' \| 'source' \| 'restart'`里的 `release` 指的是**极速版构建模式**，不是生产发布，必须新增独立 bucket，不要复用 | 分支部署耗时台账的采样 + p50 + "近 N 次"文案口径 |
| 生产存活监控 | `UptimeStateSource` 增加发布目标 getter，`selectProbeTargets` 多产一类 URL 型目标，探测走 `ReleaseTarget.ssh.healthcheckUrl`；状态页出现生产目标的 24h 可用率、响应时间、故障时间线 | `uptime-metrics.ts` 纯函数（采样 / 聚合 / 去抖 / incident 合成，有单测）+ `ProbeFn` 可注入+ 全 URL 探测函数 `probeHealthcheckStatus` 已存在 |
| 事件上总线 + 告警外发 | 发布 started / succeeded / failed / rolled-back 上 `cds-events-bus`；告警通道与存活告警**共用一条**——[doc/debt.cds.md](./debt.cds.md) 已把"无告警外发"登记为 open，不要当两件事做 | `cds-events-bus` 已存在 |
| SSE 补 `id:` 行 | 支持 `Last-Event-ID` 标准续传，与分支部署流对齐 | `routes/deployment-runs.ts:70-71,106` |
| 停掉现场探测 | 发布中心健康改读监控快照，不再每次请求同步打生产 | 依赖上面的存活监控 |

**验收判据**：发布过程 UI 显示"第 3/5 步 · 执行发布命令 · 预计还需 1 分 40 秒（近 8 次中位）"；关闭页面后发布失败仍收到告警；状态页能看到生产目标连续 24 小时的可用率柱条；打开发布中心不再产生对生产的实时探测请求。

**工作量**：中。**依赖**：阶段一（结构化失败是步骤失败展示的前提）。

### 阶段三：记账——证据、回收、效能指标

| 交付物 | 做法要点 |
| --- | --- |
| 预检结果落库 | `ReleasePreflightResult`目前只作 HTTP 响应、不落库，且**跑两遍**（向导一次、`startRelease` 内部一次，`:355`），用户看到的那次不是真正把关的那次。改为一次预检 → 落库 → run 引用同一份结论 |
| 日志有界 + 批量落盘 | `run.logs` 加上限与 `firstEventSeq` 截断标记；`appendReleaseRunLog` 当前**每行一次 `save`**，SSH 逐行输出下写放大严重，改批量 flush |
| run 保留策略 | `state.releaseRuns` 按目标保留最近 N 条 + 时间窗，显式写出边界（回滚能力有保质期，必须声明） |
| 远端产物回收 | 每次发布在远端建 git worktree、static 模式再建 `.releases/<id>`，全仓无任何清理逻辑。按"保留最近 N 份"回收，与机制 5 的回滚可达范围对齐 |
| 目标配置变更历史 | `PATCH /releases/targets/:id` 目前只覆盖 `updatedAt`，答不出"健康检查地址是谁什么时候改的"。补变更快照 |
| 漂移检测 | 读回远端 `current` / `previous` 符号链接，与 CDS 认知的当前版本比对，不一致即告警。**只告警不自动改**——单机误自愈代价高 |
| DORA 看板 | 发布频率 / 变更失败率 / 恢复时长直接从现有字段聚合；补存 commit 时间以支持变更前置时间 |
| 发布 ↔ incident 关联 | 给 incident 记录挂 releaseId 或时间轴对齐，回答"是哪次发布引入的" |

**验收判据**：一次输出上万行的发布不再产生上万次落盘；发布 100 次后 state 体积与远端磁盘占用有上界且可预测；发布中心能给出最近 30 天的四项指标；线上被人工手改过版本时 CDS 主动告警。

**工作量**：中。**依赖**：阶段二（告警通道复用）。

### 阶段四：架构升级——不可变产物直达生产

这是"low"最深的一层，收益最大，但要单独立项。

| 交付物 | 做法要点 |
| --- | --- |
| 发布消费不可变产物 | 让发布使用预览阶段已验证的不可变镜像（digest 或 `sha-*`，断言已有），而不是在生产机 `docker compose up -d --build` 重新构建。做完之后"预览验的"和"生产跑的"第一次是同一个制品 |
| 回滚变成换镜像 | 回滚从"重新构建历史 commit"降级为"把旧镜像放回去"，秒级且必然成功；`existing-script` 模式仍保留用户自定义回滚命令作为兼容路径 |
| 发布单元含配置 | 版本标识 = 产物 digest + 配置哈希；只改环境变量也记一次发布，从而可回退 |
| compose 模式切流建模 | 起新容器 → 就绪判据通过 → 切路由 → 停旧容器（单实例蓝绿），把中间态显式建成状态；static 模式的原子切换作为参照，不要动 |
| 已发布分支纳入分支保护 | `branch-protection.ts` 目前完全不知道 release 存在，"生产当前版本的来源分支"不受保护 |

**验收判据**：一次生产发布不触发生产机上的源码构建；回滚在秒级完成且不依赖网络与依赖仓库可用；compose 模式发布期间生产可用性不中断。

**工作量**：大。**依赖**：阶段一。

---

## 六、明确不做什么

写清楚不做什么，是为了防止这份方案变成许愿池。

**不做金丝雀统计自动分析（Kayenta / AnalysisRun 那一类）。** 它的前提是基线组与金丝雀组同时承接足够流量、跑统计显著性检验。CDS 是单机单副本、生产发布频次低、无指标后端，样本量根本不够，硬搬只会得到一个看起来专业但没有判别力的分数，反而给人虚假的安全感。**替代做法**：发布成功的判据用确定性信号（就绪探测 + 同源资源校验 + 容器重启次数），这些 CDS 已经有一半。

**不做按比例流量切分与百分比滚动更新（maxSurge / maxUnavailable）。** 单机无服务网格、无 Ingress 权重能力，通常也只有一个副本，"一批一批推进"没有对应物。**替代做法**：只取它的单实例退化形态——蓝绿切换（阶段四）。

**不做完整 GitOps 仪式。** 把每次部署都变成一次 Git 提交与审批，会直接毁掉分支预览的即时性，而即时性正是 CDS 的核心价值。**只取一层语义**：期望态可声明、可比对、可对账（阶段三的漂移检测）。

**~~不做多环境晋级链~~（2026-07-29 已被 v2 跨环境提升取代，见第十节）。** 本条原判据是"没有不可变产物，晋级无法保证是同一产物"；v2 改走另一条安全模型解决——不复用产物、原样重新构建，但用 `expectedCommitSha` 钳制版本 + 祖先判定防误标分叉版本，代价是仍要重新构建（不是阶段四设想的直接搬运产物），但至少保证"发出去的确实是被检查过的那个 commit"。阶段四的不可变产物落地后，可以把这条晋级链换成真正的产物直接搬运，收益是免重建、更快。

**不做漂移自愈。** 只检测、只告警，不自动把线上改回去。单机环境下一次误自愈可能直接打断人工抢修。

**不动三样已经正确的东西**：`executionSnapshot` 的脚本 sha256 快照与执行前比对、static 模式的原子切换、SSE 流的 `afterSeq` 续传骨架。

---

## 七、复用清单

方案的主线是接线，不是新建。逐条对上：

| 要补的能力 | 复用什么 | 位置 |
| --- | --- | --- |
| 心跳 + 中断收敛 | `DeploymentRunService` 的心跳与 `reconcileInterrupted` 范式 | `cds/src/services/deployment-run.ts:159,203` |
| 周期收割钩子 | 服务器已在跑的 5 分钟定时器 | `cds/src/server.ts:1415-1427` |
| 排空的穷尽式状态表写法 | `RUN_STATUS_TERMINAL` | `cds/src/services/deploy-drain.ts:44` |
| 结构化失败 | `DeploymentFailure` 类型 + 规则分类器（纯函数） | `cds/src/types.ts:1100`、`cds/src/services/deployment-failure-classifier.ts` |
| 生产存活监控 | 采样 / 聚合 / 去抖 / incident 纯函数 + 可注入 `ProbeFn` | `cds/src/services/uptime-metrics.ts`、`uptime-monitor.ts:171` |
| 探测实现 | 已有的全 URL 健康探测函数 | `cds/src/services/release-service.ts:825` |
| ETA | 耗时采样 + p50 + "近 N 次"文案口径（**需新 bucket，勿复用 `'release'` 构建模式**） | `cds/src/services/state.ts:3436-3480` |
| 事件外发 | `cds-events-bus` + uptime 告警通道（同一条） | 与 [doc/debt.cds.md](./debt.cds.md) 的 open 项合并做 |
| SSE 标准续传 | 分支部署流的 `id:` + `Last-Event-ID` 实现 | `cds/src/routes/deployment-runs.ts:70-71,106` |
| 不可变产物 | `DeploymentVersion` 内容寻址 + 不可变镜像断言 | `cds/src/services/deployment-version.ts:52-72,178` |
| 取证账本格式参考 | MAP 自己 `exec_dep.sh` 那套结构化取证（操作者 / PID / 起止 / SHA256 / 切换前后 owner-mode / 首个失败阶段 / 回滚结果） | [doc/debt.platform.production-release.md](./debt.platform.production-release.md) |

---

## 八、状态看板

按 `.claude/rules/living-status-board.md`，本工程开工后在本文档第一屏维护六列看板（阶段 / 进度% / 状态 / 当前 blocker / 下一步 / 验收证据），并在顶部写"最后更新 + 距离可发布"。在阶段一开工前不建空看板占位。

---

## 九、决策点：先做哪一阶段

请在下面三条里挑一条。

**A. 只做阶段一（止血）。** 好处：工作量最小，一次改动就消除"发布目标被永久锁死"这个会真实伤人的故障，且失败第一次会说人话。局限：发布过程仍是一屏滚屏，发完仍然失联。

**B. 阶段一 + 阶段二（止血 + 可见）。** 好处：发布中心从"一个按钮加一屏日志"变成"能看的东西"——有步骤、有 ETA、有生产存活曲线、失败会主动找人。用户对"low"的感知主要来自这两阶段覆盖的面。局限：账本与回收仍欠着，磁盘与 state 继续无界增长。

**C. 直接上阶段四（不可变产物直达生产）。** 好处：治的是最深那层，做完回滚才是真回滚。局限：工作量大、周期长，期间"发布卡死"和"发完失联"这两个高频痛点一天都没解决，且它本身依赖阶段一的心跳与取消能力。

**建议选 B。** 三条理由：一是阶段一修的是会真实卡死用户的故障，且几乎全是照抄现成范式，不做等于把已知地雷留着；二是阶段二里最贵的两件事——生产存活监控和告警外发——的砖块本 PR 刚落地，接线成本远低于新建，错过这个窗口反而要重新捡上下文；三是用户说的"low"主要是可观测性体感，阶段一 + 二正好覆盖生命周期与可观测性两条，能立刻感知，而阶段四虽然更根本，但它的收益（回滚变快、产物同一）只有在发布出问题时才被感知到，不适合作为第一刀。阶段三与阶段四按 B 完成后的实际痛感再排序。

---

## 十、v2 界面重做与增量能力（2026-07-29）

阶段二、三验收后，发布中心在同一批工作里做了一次界面重做与能力增量，超出上面各阶段判据描述的范围，单独记一节：

- **环境成为骨架**：原 1669 行单文件拆分为一组组件；顶部改为主干版本流水轴，左栏改为环境列表，概览页给线上版本、健康可用率、近 30 天发布统计三格摘要，发布时间线带提交说明而非裸 sha。
- **跨环境提升**：一个按钮把某环境正在跑的版本原样发到另一个环境，靠 `expectedCommitSha` 钳制版本、不引入"发布候选"这个新实体；提升候选带祖先判定，避免把分叉版本误标为可提升。
- **自动发布（定时任务）**：基于 scheduled-job 的发布规则支持增删改查、启停、立即试跑；支持"需要人工确认"（到点只跑发布前检查、生成待确认站内信，绝不自动发布）、连续失败 2 次自动停用并告警、失败自动回滚、目标版本未变或目标忙时按并发策略跳过。**并发闸不变量**：HTTP 发布路由与定时任务调度器必须共用同一个 `ReleaseService` 实例，绝不能各自 `new` 一个——`inFlight`（在途发布）表是实例私有的，两个实例各持一张互不可见的表，settling 判定会当场失明，两条并发闸都会误判「空闲」而同时放行同一目标（此前路由侧确实自建过第二个实例，现已改为共用并由专门的单实例守卫测试钉住）。**版本钳制不变量**："需要人工确认"的站内信必须钉死那次过检的具体 commit（不是"当前最新"）：分支在等待人确认期间可能继续推进，通知深链带着过检时的 commit 一路透传到发布确认弹窗的 `expectedCommitSha`，人几小时后点进来发布的仍是被检查过的那一版，而不是分支当下的最新版。**编辑不变量**：`PATCH /api/scheduled-jobs/:id` 把 `actions` 当权威全量覆盖，而一个任务可能同时挂着 HTTP 回调、命令、发往其他环境的 release 等兄弟动作；编辑自动发布规则必须只替换本目标匹配的那条 release 动作、原样保留其余动作，不能直接提交单元素数组把兄弟动作静默删光。
- **发布判据前置**：失败判据从日志提取后摆到首屏（门禁逐项检查表 + 人话解释），原始日志退到折叠区；磁盘不足会给出人话结论（还差多少 MB）并在磁盘失败后自动复查、拦在下一次发布之前。
- **通知账本**：服务端记录发布失败 / 自动回滚 / 现场漂移 / 健康掉线 / 自更新失败 / 预览探测失败 / 基础设施熔断七类告警，10 分钟内同目标同类型合并计次，可选外发到 MAP 站内通知。两条安全不变量：通知 `href` 只收同源相对路径（拒绝协议相对 URL 与 `javascript:` 等可执行 scheme，防止低权限项目级凭据写入的通知在全局运维会话里被点开执行）；去重与忽略均按调用方作用域（项目）隔离，防止一个项目的写入覆盖或误关另一个项目的通知。
- **新建服务器就地化**：加环境向导内嵌新建服务器表单（密钥对 / 粘贴私钥 / 用户名密码三种接法），不再把用户支到系统设置再走回来。三条安全不变量：密码认证主机对外暴露的公开标识是与口令无关的随机串（不是口令派生的哈希，避免公开接口返回的指纹被离线撞库还原口令）；SSH 执行失败摘要与发布日志共用同一个脱敏器，统一盖住 Authorization 头 / JSON 口令字段 / URL userinfo 三类格式，避免凭据经由失败信息展示在发布中心；从私钥认证切到密码认证必须清掉旧的私钥口令，否则公开视图会继续谎报 `hasPassphrase`，日后换回新私钥时这枚陈年口令还会被拿去解新私钥，认证失败查不出原因。

这批改动是阶段二"可见"与阶段三"记账"判据在真实界面上的落地延伸，不新增独立阶段编号；已知边界与安全取舍见 [doc/debt.cds.release-system.md](./debt.cds.release-system.md)。

## 实现来源

给要跳去看代码的人；只读这篇文档的人可以整块跳过。

| 位置 | 文件 |
|------|------|
| 二、用户会撞上什么 | `cds/src/services/release-service.ts:396`、`release-service.ts:362-370`、`cds/src/services/deployment-run.ts:159,203`、`cds/src/server.ts:1415-1427`、`cds/src/services/deploy-drain.ts:44`、`ReleaseCenterPage.tsx:1490-1528`、`release-service.ts:515-523`、`cds/src/types.ts:1436`、`cds/src/services/deployment-failure-classifier.ts`、`types.ts:1100`、`routes/releases.ts:520-522`、`cds/src/services/uptime-monitor.ts:162-168`、`cds/src/services/release-events.ts:26` |
| 三、现状定位：一个系统，两条生命周期 | `deployment-run.ts:13-23,250`、`release-service.ts:559`、`cds/src/services/state.ts:2146-2167`、`cds/src/routes/deployment-runs.ts:70-71,106`、`cds/src/services/deployment-version.ts:52-72,178`、`release-service.ts:466-468` |
| 四、机制对照表 | `routes/releases.ts:513-514`、`routes/deployment-versions.ts:74-99`、`release-service.ts:494-496`、`release-service.ts:760-800`、`uptime-monitor.ts:162-168,574-580` |
| 阶段一：止血——发布不再卡死，失败说人话 | `types.ts:1417` |
| 阶段二：可见——过程有预期，发布完不失联 | `ReleaseCenterPage.tsx:247,249`、`release-service.ts:671-676`、`types.ts:1469`、`uptime-monitor.ts:171`、`release-service.ts:825` |
| 阶段三：记账——证据、回收、效能指标 | `release-service.ts:45-52`、`state.ts:2146-2167`、`routes/releases.ts:114,202` |
| 六、明确不做什么 | `types.ts:1343`、`ReleaseCenterPage.tsx:1449` |
