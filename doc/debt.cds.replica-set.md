# debt.cds.replica-set — 复制集模式工程债务台账

> 关联：`design.cds.replica-set.md` | 创建：2026-07-23（MVP-1 落地时）

| # | 状态 | 债务 | 影响 | 偿还方向 |
|---|------|------|------|----------|
| 1 | done(2026-07-23) | 一键隔离数据库（dbMode=isolated + 数据克隆） | 已落地：replica-db-clone 三适配（mongodump / mysqldump / pg_dump），克隆完成才启动成员；隔离库保留语义 + 数据快照列表 + 手动删除 drop | 残留边界：克隆是停快照不追增量；pg 源库超大时 pg_dump 耗时（600s 超时上限）；mongo 镜像缺 database-tools 时明确报错不静默 |
| 2 | open | scheduler / auto-lifecycle 冷却分支时不感知复制集成员 | 分支被调度器休眠时成员容器可能继续运行占资源（显式 stop / delete 路径已级联收割） | scheduler coolFn 复用分支 stop 的成员级联；或复制集化分支视同 color-marked 不驱逐（设计文档既定方向） |
| 3 | open | promote 在 deploy 派发成功后立即解散复制集，不等 run 终态 | 若版本部署中途失败，成员已被收割，主容器仍是旧版本（入口不受损，但「提升」未达成需人工重试） | promote 改为跟踪 runId 终态后再解散；失败回滚为「保留成员」 |
| 4 | open | 成员物化的启动日志只保留内存尾部 40 行进 statusMessage，无独立日志入口 | 成员启动失败时排障信息有限（可用容器名走 docker logs） | 复制集页签接 container-logs 按 containerName 查询 |
| 5 | open | 成员直达子域未接 HTTPS 证书边界校验之外的墓碑/等待页 | 成员 provisioning 期间访问直达链会落 forwarder 等待页兜底，体验可接受但无成员级文案 | forwarder 等待页识别成员路由，给「成员启动中」文案 |
| 6 | done(2026-07-23) | remote executor 分支（executorId 指向远端）未支持复制集 | addMember 已对远端执行器分支返回 409 明确拒绝（isRemoteBranch 经 registry 判定） | 后续如需远端支持，成员物化改走 /exec 通道 |
| 7 | open | 灰卡渐显动画固定 2.4s，先于真实就绪结束（独立验收 R1 P3-1） | 创建 30s+ 时卡片提前恢复全彩，仅靠文字/脉冲块提示仍在创建 | 动画时长与 provisioning 状态联动（就绪才去灰），或改持续脉冲直至 running |
| 8 | open | 分流实测「实时日志」实为服务端完成后的逐条回放（R1 P3-2） | 探测进行中仅首行提示，非逐请求实时推送 | probe 端点改 SSE 流式逐请求推送 |
| 9 | open | 存量成员未迁移 res-N 命名规范（R1 P3-3） | 旧随机命名成员（rsXXXX）与新 res-N 并存，追踪性打折 | 一次性迁移脚本或成员重建时自动换名 |
| 10 | open | 成员直达域名响应缺 X-CDS-Replica 标记头（R1 P3-4） | 直达访问无法从响应头确认落点（主入口有头） | forwarder 成员直达路由也注入标记头 |
| 11 | open | 流量舞台一次仅渲染一个服务（R1 P3-5） | 多服务复制集拓扑需回行式逐行看 | 舞台支持多 profile 分区或服务切换器 |
| 12 | open | 副本健康失真已修展示层（TCP 实测 + 红色不可达告警），但 forwarder 分流不摘除坏实例（R1 P1-2 残留） | 不可达副本仍按权重接真实流量，需人工下线或调 0 权重 | forwarder 被动健康：连续 ECONNREFUSED 临时摘除 + 恢复探测回池 |
| 13 | open | 隔离过渡期入口探测 servedBy 短暂变 untagged（复制集路由暂退，R4 P3） | 隔离/失败期间主实例落点在探测里不可辨识 | 过渡期保持 primary 单路由并带标记头 |
| 14 | open | 克隆错误文案头段仍是进度日志，真实原因在尾段（R4 P3，已不再被挤掉） | 可读性一般，需读到尾段 | 错误摘要优先提取匹配 error/failed 的行 |
| 15 | open | 共享 infra 容器无内存上限，mongod WT cache 默认吃半机内存（R4-P0 环境根因） | 任何大写入负载（不限克隆）都可能把 mongod 顶到宿主 OOM | CDS infra 供给时默认加内存上限 + 匹配的 --wiredTigerCacheSizeGB；需评估存量容器重建影响（cross-project-isolation 通道 4） |
| 16 | done(2026-07-24) | ~~大库整库克隆在共享宿主上无安全路径~~ **已根治：mongo 隔离改「专用隔离实例」通道**。终局取证（生命周期取证器 die exitCode=139）：共享 mongod 8.0.20 在本宿主上凡大批量写入随机 SIGSEGV（同 cgroup/辅助容器/WT cache 收紧/单并发/索引串行全部无效；纯读 dump 五次全程安全）。方案：dump 只读共享库落盘 → docker run 独立 mongo:7.0 实例（内存 1.5G 上限、CDS_REPLICA_ISO_MONGO_IMAGE 可覆盖）→ restore 写入专用实例 → 副本连接串覆写直连；快照删除 = 整容器移除。R9 终验闭环 PASS，共享库全程零事件 | 残留边界：共享 mongod 8.0.20 自身的大批量写不稳定性仍在（非克隆路径也可能触发，如未来某功能大批量写共享库）——建议排期升级 mongo 镜像版本（容器重建，需拍板） | — |
| 17 | done(2026-07-24) | 崩溃现场不可追溯 | InfraLifecycleWatcher 常驻 docker events（oom/die/kill/start），GET /api/infra/:id/lifecycle-events 回看；die 137 无 oom=外部 SIGKILL、oom=cgroup OOM、其他=进程自身退出。R7 实战定罪 139 | 残留：只覆盖 cds-infra- 前缀容器；rsdb 专用实例暂不入取证范围 |
| 18 | open | mysql / postgres 克隆路径无源库大小闸门（mongo 已加），且仍走共享实例内克隆 | 大 mysql/pg 库克隆理论上有同类宿主压力风险（未实测出崩溃） | dataSize 预检推广到双引擎；必要时同款专用实例通道 |
| 19 | open | 分支删除后专用隔离实例容器（cds-rsdb-*）无自动清理路径 | 分支连快照台账一起删除后，rsdb 容器脱管残留（不入孤儿清扫范围） | 分支删除流程接 teardownForBranch 并级联 dropReplicaDb；或孤儿清扫认领 cds.type=rsdb + 台账比对 |
| 20 | open | 分支列表卡「复制集 xN」徽章不随抽屉内变更实时刷新（R10 P3） | 下线副本后列表卡计数滞后，整页刷新才对齐 | 抽屉变更后失效列表缓存或走分支 SSE 事件 |
| 21 | open | 整组复制 =「隐藏影子分支」方向已定（用户提议 + 判定采纳，波 6） | 当前 profile 级隔离下其他服务仍写主库，整组真隔离待影子分支 | shadowOf 分支 + 服务注册进主分支 replicaGroup（forwarder 数据面已支持），详见 design.cds.replica-set |
