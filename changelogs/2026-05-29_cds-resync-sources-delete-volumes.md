| feat | cds | [项目设置 → 基础设施] 重新同步配置增强:yaml 来源三选一(① 项目根目录的 cds-compose.yml 默认 ② 最近 3 条已审批 PendingImport ③ 手动粘贴),新增 `GET /api/projects/:id/infra/resync/sources` 自动读取项目仓库根目录的 compose 文件 |
| feat | cds | 重新同步删除项新增「同时删除数据卷」复选框(默认不勾=只删容器数据卷保留;勾选=docker volume rm 彻底重装)。后端 execute 接 deleteVolumes 参数,ContainerService 新增 removeNamedVolumes 方法,bind mount 跳过,结果回 volumeRemovals |
