| feat | cds | 复制集模式 MVP-1：单服务粒度多版本并排（BranchEntry.replicaSets + ReplicaSetService，成员从保留不可变镜像秒起、禁源码回退，分支停止/删除级联收割） |
| feat | cds | forwarder 复制集分流：路由组 replicaGroup + 权重加权随机 + 粘性（query __rs / header x-cds-replica / cookie cds_rs），成员直达子域 <slug>-<memberId>.<root> |
| feat | cds | 分支抽屉新增「复制集」页签（版本并排/权重/直达链/提升/一键退回普通模式）；资源卡对复制集化服务加堆叠徽章特殊标识 |
| feat | cds | 复制集 REST API：/api/branches/:branchId/replica-sets 系列端点 + Activity Monitor 中文 label 全量登记 |
| docs | doc | 新增 design.cds.replica-set 设计文档（四条硬要求 + 边界决策 + 一键隔离数据库 MVP-2 规划） |
| test | cds | 新增 route-resolver 复制集分流单测 + forwarder-route-publisher 复制集路由契约测试 |
| feat | cds | 复制集 MVP-2 一键隔离数据库（保留）：replica-db-clone 三引擎整库克隆（mongo/mysql/postgres），成员启动前先克隆再切库；隔离库快照台账 + UI 数据快照列表 + 手动删除 drop |
| feat | cds | 复制集添加成员支持「共享主库 / 一键隔离库」选择；成员行显示隔离库徽标；远端执行器分支明确拒绝复制集化 |
| polish | cds | 复制集「一个 + 号」简化（对标 Railway）：+ 副本一键把当前版本再起同版本实例并自动均分流量，历史版本并排降级为次级入口 |
| docs | doc | design.cds.replica-set 增补波4「数据库保护罩」（盾形按钮 + 分阶段真实进度 + 一致性校验）与波5「数据回写」（binlog/oplog/逻辑复制槽）设计规划 |
| polish | cds | 复制集 Railway 式芯片交互：资源卡每个应用芯片右上角「+」小按钮 + 数量菜单（1/2/3 个副本确认即成），芯片显示 xN 实例数、启动中光环脉冲；分支列表卡新增「复制集 xN」发光标识（配置仅存分支、删分支即消失） |
| feat | cds | 复制集可观测/可校验（用户五诉求）：成员命名规范化 res-N；每个复制集响应带 X-CDS-Replica / X-CDS-Replica-Group 标记头；副本容器注入 CDS_REPLICA_ID / CDS_REPLICA_INSTANCE 实例指纹；面板「分流实测」按钮走服务端真实入口探测并按响应头统计落点分布 |
| fix | cds | 分流实测改原生 http.request（fetch 静默丢 Host 头导致误记 100% 主版本的真 bug） |
| polish | cds | 复制集面板布局收紧：成员行信息与操作紧邻成组左对齐，废除左右两端拉开 |
| feat | cds | 数据库保护罩：数据库芯片锁按钮一键克隆隔离副本（异步 + 进度轮询 + 芯片环绕动画），副本入数据快照台账保留 |
| fix | cds | 验收 P1 双修：分流实测 path 由后端按服务 pathPrefixes/api-convention 推导（此前写死 / 打在前端容器永远 100% 主版本）；芯片「+」数量菜单 createPortal 挂 body（此前被芯片行 overflow 裁剪不可见） |
| feat | cds | 复制集面板全量重设计：方案A 行式视图（每服务一行：服务名/实例块/流量条/加号，次要操作收进「管理」展开）+ 方案B 流量舞台拓扑（点阵网格、入口-实例层-数据层自上而下、贝塞尔曲线连线、基础设施虚线边） |
| feat | cds | 复制隔离数据库（profile 级）：连接线上「复制隔离」按钮两步动画（第1步克隆入保护罩框、主库不动；第2步副本整体切至隔离库），旧连线灰色留影加断开标记，「回切主库」可逆且快照保留 |
| feat | cds | 后端 isolateProfile/revertProfile API（POST /replica-sets/:profileId/isolate 与 /revert-db）：guard-N 命名单次克隆 + 逐成员重物化换库，ProfileReplicaSet.isolated 台账 |
| polish | cds | 新增副本走灰卡渐显可撤回；「退回普通模式」更名「关闭复制集」；分流实测升级串流模式（逐请求服务端往返）+ 实时日志 + 终局环形仪表盘 |
