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
