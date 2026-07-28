| docs | cds | 新增 doc/debt.cds.release-system.md 债务台账：阶段一有意延期的 7 条边界 + 真实环境证据清单，并同步 doc/index.yml 与 guide.list.directory.md |
| test | cds | 新增生产发布真 SSH 端到端验收（真 sshd + 真 ssh2 + 真路由，无任何注入）：取消后目标保持占用、取消后不再写目标机器、回滚过同一道并发闸、排空期间 /releases/* 拿 503；四条逐条红绿闭环，本机无 sshd 时整套自动跳过 |
| test | cds | 新增提缺陷转发真 HTTP 端到端验收（本地假 MAP + 真 global fetch/FormData）：断言 create → attachments → submit 的真实顺序与真实字节，以及附件上传失败时如实降级 |
| test | llmgw | 前端附件总量闸用真实 5MB 量级 base64 验证：两张 5MB 图必须在前端就被拦下（base64 口径），单张 5MB 不误伤 |
| feat | cds | 发布步骤模型成为一等公民：执行器按 ReleasePlan.steps 汇报「第 N/共 M 步」，前端不再用正则从日志反推步骤，并清除发布中心的本仓脚本名硬编码（CDS 恢复成通用产品） |
| feat | cds | 发布 ETA：新增独立的生产发布耗时台账（不复用 DeployDurationMode 的 release，那是极速版构建模式，语义不同会互相污染），发布进行中显示「预计还需 MM:SS（近 N 次中位）」，样本不足时给诚实文案而非编造数字 |
| feat | cds | 生产存活监控：存活探测新增 URL 型发布目标，走 ReleaseTarget.ssh.healthcheckUrl，状态页出现生产目标的可用率与故障时间线；复用既有 uptime-metrics 纯函数，不另起一套聚合 |
| feat | cds | 发布生命周期事件上 cds-events-bus（started/succeeded/failed/rolled-back），告警通道与存活告警共用一条 |
| feat | cds | 发布 SSE 流补 id: 行，支持 Last-Event-ID 标准续传，与分支部署流对齐 |
| test | cds | 新增阶段二回归约 100 例（步骤模型/ETA/存活目标/事件/SSE 续传），含多个「防再修一边」的唯一判定源守卫 |
| perf | cds | 发布中心健康列改读存活监控快照，打开页面不再按目标数放大成一串对生产的实时探测；监控没接上时诚实报「等待首次探测 / 存活监控未启用」，不偷偷回退到实时探测 |
| fix | cds | 分支侧发布向导也迁到共享步骤判定源：此前它自带第三份「日志 phase 反推 + `scripts[0] \|\| './fast.sh'` 兜底」的拷贝，换个项目就展示三个根本不会执行的脚本；同步显示「第 N/M 步 · 标题」，与发布中心对同一次发布说同一句话 |
| fix | cds | 真 SSH 端到端用例不再因私钥路径失效而静默空跑：默认路径原本是 session 级 scratchpad 绝对路径，换会话即 existsSync 失败、整套变成三个空绿灯，而债务台账正引用它当真实环境证据；改为 `CDS_RELEASE_E2E_SSH_KEY` 可覆盖 + 稳定默认路径，跳过时打印到底是缺 key 还是没 sshd |
| test | cds | 修掉一条断言 bug 本身的契约用例：release-site-ui-contract 逐字要求 BranchListPage 里存在 `执行 ${scriptOne.replace` 与 `releaseScriptPhase(scriptOne)`，等于把硬编码焊死——谁去掉谁 CI 红；改为断言走共享判定源 |
| feat | cds | 发布预检落库并被 run 引用：一次预检 → 落库 → 发布复用同一份结论，消除「向导跑一次、startRelease 内部再跑一次」的重复（用户看到的那次此前不是真正把关的那次）；复用带 commit 相同 + 2 分钟 TTL + 目标/分支重新校验的过期保护，对不上一律回落重跑 |
| perf | cds | 发布日志改批量落盘：`appendReleaseRunLog` 此前每追加一行就全量 `save()` 一次，SSH 逐行输出下写放大随已累积日志量增长；实测灌 1200 行的落盘次数从 1200 降到 24，error 级仍立即落盘（失败证据是排障第一现场） |
| fix | cds | 发布日志加 500 条上限 + `firstEventSeq` 截断标记，SSE 快照走同一份判定并如实报 `truncated`：此前唯一的截断发生在持久化层应急压缩且不写任何标记，客户端拿旧 `afterSeq` 重连会静默缺一段还以为收全了 |
| feat | cds | 发布 run 保留策略（每目标 100 条 + 90 天窗）：保护集含在途 run、最新一条、最近 20 次成功及其回滚链，避免「保留了版本却回滚不了」 |
| feat | cds | 远端产物回收：按保留窗口清理远端 worktree 与 static 成品目录，N 与回滚可达范围同源；八条安全边界（current/previous 取远端 readlink 实读值绝不删、读不回来不删、有在途 run 不删、漂移时不删、形状不匹配不碰、publicDirectory 共用时退化）；逃生阀 `CDS_RELEASE_ARTIFACT_RETENTION=0` |
| feat | cds | 生产漂移检测：定时读回远端 `current` / `previous` 与 CDS 台账比对，不一致走 cds-events-bus 告警（复用存活监控同一条通道与 `isAlertCdsEvent`）。只告警不自动改——单机误自愈会打断人工抢修 |
| feat | cds | 发布目标配置变更历史：20 个可审计字段白名单 diff（全量递归会被 `updatedAt` 刷成噪声），每目标 50 条上限，`privateKeyRef` 只留指纹，删目标时清桶；新增 `GET /releases/targets/:id/changes` |
| feat | cds | DORA 四项指标进发布中心：发布频率（回滚不计，否则回滚越多显得发布越频繁）、变更失败率、恢复时长（同目标内找恢复，未恢复的单列不混进 p50）、变更前置时间（发布发起时记 commit 时间，全仓此前没有该数据）；样本不足一律 `null` 并给「最近 30 天仅 N 次发布」的诚实文案，不编造精确假数字 |
| feat | cds | 存活监控故障挂发布记录，能回答「是哪次发布引入的」 |
| test | cds | 新增阶段三回归约 200 例，含远端回收的**对抗性**边界套件（让保护对象恰好落在最该淘汰的位置上，确认仍活着）与多条「一行接线掉了不会红」的源码守卫 |
| fix | cds | 修掉三处「建好却没接上」：`buildReleaseLogSnapshot` 全 src 无人调用（SSE 仍手搓 filter）、`release-remote-watcher` 整个模块无人 import（定时器从不启动，漂移告警达成度实为 0）、漂移告警出口未注册（退化成 console.warn）——三者全量测试都是绿的，属于典型的静默退化 |
| fix | cds | 共用目录判据补规范化（Codex P1）：`/opt/site` 与 `/opt/site/` 此前被裸字符串比较判成不共用，共用保护被关掉，远端回收会把另一个目标台账里的成品当孤儿删掉——直接砍到别人的生产；判据抽成 `isSameRemoteDirectory` 并加守卫 |
| fix | cds | 预检裁剪保住被 run 引用的结论（Codex P2）：此前只按条数与时间窗淘汰，同一目标再做 20 次预检就能把在途 run 依据的那份删掉，留下指向空气的审计链接；被引用的记录同时不占淘汰名额，否则条数上限形同虚设 |
| fix | cds | 故障归因上状态页（Codex P2）：后端 uptime API 一直返回 `releaseId` / `releaseAgeMs`，前端既没声明也没渲染，「是哪次发布引入的」记录了但用户看不到；文案用「疑似」，不把时间相邻说成因果 |
| rule | doc | 新增 `.claude/rules/predicate-and-wiring-discipline.md`：把 25+ 条 review 意见归纳成四种形状（判据太窄 / 链路只建到一半 / 判据分裂漂移 / 测试反向锁死 bug 或静默空跑）与五条机械自查，核心判据是「改动删掉后测试仍全绿 = 需要一条守卫」 |
| fix | cds | 自动恢复补落时间戳（Codex P2）：探测失败后 `restorePreviousAfterFailedProbe` 把上一版本推回去此前**只写日志**，不落 run 也不落时间戳，原 run 仍是 failed；DORA 恢复配对因此找不到恢复者，把几秒就自愈的失败算成「进行中故障」一直挂到下次成功发布，恢复时长与 ongoingCount 双双失真。改为在失败 run 上盖 `autoRestoredAt`——不新建 run，那不是一次发布，造假 run 会污染发布频率与变更失败率的分母 |
| fix | cds | 监控被关闭时发布中心说实话（Codex P2）：`CDS_UPTIME_ENABLED=0` / `CDS_UPTIME_RELEASE_ENABLED=0` 时快照源照常注册但记录永远建不出来，健康列永久显示「稍后自动开始探测」这个不会兑现的承诺，而实时探测已经拿掉了——那一列就永远在骗人；改为不注册源并传入区分两个开关的关闭原因 |
| chore | cds | 三个碎片文件合并为一个（Codex P1）：同一 PR 的变更必须落在同一个碎片里（CLAUDE.md §4），否则发版合并与后续维护会丢失 PR 级的整体性 |
| fix | cds | 预检复用绑定目标配置指纹（Codex P1）：复用键此前只有 branchId/targetId/previewUrl/operator/commitSha，运维在两分钟复用窗口里改掉 host / 凭据 / appPath / 发布命令 / healthcheckUrl 后键照样命中，旧结论被套到一台连通性、仓库身份、脚本都没验证过的机器上；指纹清单直接复用变更历史那张白名单表，不另立第二份，存量无指纹记录一律重跑 |
| fix | cds | 自动恢复配对改用探测失败时刻（Codex P2，修上一版空转）：`autoRestoredAt` 落在 `failRun` 之前，恒早于 `finishedAt`，而上一版拿它与 run 终态时刻比大小，条件恒为 false，整条修复在生产上是空转；新增 `autoRestoreStartedAt` 作为故障窗口起点。上一版用例之所以是绿的，是因为它手写了一个现实中不可能出现的时间顺序——测试编码了作者的假设而不是真实时序 |
