| fix | cds | 集群执行器 /exec/deploy 路径不再硬编码 projectId='default',接受 master 传入 projectId 并兜底用 resolveProjectForAutoBuild,杜绝远端 executor 创建孤儿分支
| fix | cds | 待审核 compose 导入(pending-import)写入 infra 时按 legacyFlag 公式给容器名加项目前缀,避免两个项目都导入 mongodb 时 docker 容器名冲突
| fix | cds | 项目初始化 bootstrap (initialize main 分支) 用 resolveProjectForAutoBuild 替代硬编码 'default',防止 rename-default 后再次走 init 流程产生孤儿
