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
