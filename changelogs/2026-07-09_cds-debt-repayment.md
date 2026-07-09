| perf | cds | state 持久化拆分：webhook 投递与项目活动流从 global 单文档拆到独立 collection（cds_webhook_deliveries / cds_activity_logs，diff-based 增量写 + legacy 回退读零迁移），消灭「追加一条日志重写整份 global 文档」的写放大。注意：拆分后若回滚到旧版 CDS，会丢这两类诊断日志的增量（分支/项目等控制面数据不受影响）；索引 DDL 见 guide.platform.mongodb-indexes，待 DBA 手建 |
| feat | cds | 分支隔离补强：平台自动向分支容器注入 BULLMQ_PREFIX=分支slug（与 per-branch 库名同一 SSOT），杜绝多分支共用 Redis 时 BullMQ 抢 job 串台。行为变化：项目 customEnv / profile.env 显式定义者优先不覆盖，逃生阀 CDS_BULLMQ_PREFIX_INJECTION=0 可整体关闭；brandai 手填的 BULLMQ_PREFIX 验证通过后可删 |
| fix | cds | 分支级网络隔离收尾：janitor 清理与启动残留 prune 两处删分支路径补 removeBranchNetwork，空的 cds-br-* 网不再随分支删除堆积（清网失败不阻断删除） |
| feat | cds | 资源回收对账：janitor 周期 sweep 新增孤儿 infra 容器对账报告（只报不删，进 sweep report + 系统事件告警）；分支显式删除新增按 cds.branch.id label 的遗留 app 容器清扫（best-effort） |
| feat | cds | 极速版入口校验：webhook 进极速版等待前先查分支 tree 是否有 branch-image.yml（结果 10 分钟缓存），缺文件直接置 CI 失败并给出「切源码编译」归因文案，不再死等 15 分钟看门狗；GitHub API 异常时保持原 waiting 行为 |
| feat | cds | 验收中心 export 协议支持可选分页（limit 1-500 + cursor 游标，(createdAt,id) 稳定排序，响应带 page 元信息）；不传参时响应与旧协议逐字节兼容，坏 cursor 返回 400 |
| fix | prd-api | CDS Agent 工作流节点在完全没有系统级 runtime profile 时不再硬报错，改为提示并尝试以 CDS Lite 模式直跑（Lite 不可用时仍显式失败），全新环境开箱可用 |
| polish | prd-admin | claude-sdk 用户可见文案诚实化：6 处改为「Claude sidecar runtime（自研 sidecar，Anthropic 协议；runtime 标识 claude-sdk）」，不再暗示完整接入官方 SDK（机器值不变） |
| refactor | cds | 预览等待页收敛：forwarder 等待页迁入 loading-pages SSOT（快照锁字节级等价），删除零调用的 buildTransitPageHtml 死代码（约 290 行）；loading-pages 伪双主题 light 块改为诚实单主题标注 |
| docs | doc | 债务台账综合对账：performance / state-json / branch-isolation / nginx-loading-pages / removed-branch-pages / acceptance-center / agent D4 / sdk-executor D16 / backlog-matrix 逐项勾销或修正账实不符（含「per-branch infra 容器」错误前提改写）；38 个 smoke-cds-agent 脚本加 RETIRED 头随台账整组退役；cross-project-isolation 清单新增通道 7（BULLMQ_PREFIX） |
| test | cds | 新增单测：mongo-split 拆分 round-trip/legacy 回退/淘汰 deleteOne/seed 拒绝二次（4 例）、env-provenance BULLMQ_PREFIX 注入（4 例）、janitor 孤儿扫描（3 例）、loading-pages 快照（3 例）、极速版入口校验（2 例）、peer-sync 分页（1 例） |
