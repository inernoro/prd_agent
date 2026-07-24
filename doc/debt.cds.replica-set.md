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
| 16 | open(熔断) | **大库整库克隆在共享宿主上无安全路径**：对 prdagent（2.69G）的 mongodump 管道克隆六轮验收四次打崩生产 mongod——R3 同 cgroup 裸奔、R4 辅助容器隔离客户端后仍崩、R5 WT cache 收紧因解析 bug 未生效、R6 收紧全窗口实测生效（2G）仍崩。「限内存即安全」的假设被证伪，根因疑为宿主内存常年吃紧下 restore 写压直接触发宿主 OOM 或 mongod 内部异常（平台日志通道 tail 500 行不足以取证，见 #17） | 复制隔离/保护罩对大库不可用 | 已落安全闸门：源库 dataSize 超 `CDS_REPLICA_CLONE_MAX_MB`（默认 512MB）拒绝克隆并明示原因，小库不受影响。根治候选（需用户拍板）：a) 宿主扩内存/清理容器后重评；b) 专用克隆通道（dump 落文件 + 限速分批 restore / 快照级复制）；c) 给 mongod 容器加 cgroup 内存限额 + 匹配 WT cache（接受重建）。fail-closed 分支（保护建立失败中止克隆）尚无实证运行记录 |
| 17 | open | 崩溃现场不可追溯：`GET /api/infra/:id/logs` tail 上限 500 行，mongod 重启后的清理日志秒级刷满窗口，OOM 与否无法从平台通道取证（R6-P2） | 类似事故只能靠外部监护脚本抓时间线 | 崩溃前日志留存 / 暴露 docker inspect OOMKilled 标志通道 |
| 18 | open | mysql / postgres 克隆路径无源库大小闸门（mongo 已加，R6） | 大 mysql/pg 库克隆理论上同风险（未实测） | 同款 dataSize 预检推广到双引擎 |
