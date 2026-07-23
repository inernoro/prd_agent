| feat | cds | 复制集模式 MVP-1：单服务粒度多版本并排（BranchEntry.replicaSets + ReplicaSetService，成员从保留不可变镜像秒起、禁源码回退，分支停止/删除级联收割） |
| feat | cds | forwarder 复制集分流：路由组 replicaGroup + 权重加权随机 + 粘性（query __rs / header x-cds-replica / cookie cds_rs），成员直达子域 <slug>-<memberId>.<root> |
| feat | cds | 分支抽屉新增「复制集」页签（版本并排/权重/直达链/提升/一键退回普通模式）；资源卡对复制集化服务加堆叠徽章特殊标识 |
| feat | cds | 复制集 REST API：/api/branches/:branchId/replica-sets 系列端点 + Activity Monitor 中文 label 全量登记 |
| docs | doc | 新增 design.cds.replica-set 设计文档（四条硬要求 + 边界决策 + 一键隔离数据库 MVP-2 规划） |
| test | cds | 新增 route-resolver 复制集分流单测 + forwarder-route-publisher 复制集路由契约测试 |
