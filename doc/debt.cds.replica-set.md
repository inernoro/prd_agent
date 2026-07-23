# debt.cds.replica-set — 复制集模式工程债务台账

> 关联：`design.cds.replica-set.md` | 创建：2026-07-23（MVP-1 落地时）

| # | 状态 | 债务 | 影响 | 偿还方向 |
|---|------|------|------|----------|
| 1 | open | 一键隔离数据库（dbMode=isolated + 数据克隆）未实现，API 对 isolated 返回 501 | 成员与主容器共享库，实验版本写坏共享数据的风险仍在 | MVP-2：db-clone 服务（mongodump/mysqldump/pg TEMPLATE 三适配），克隆完成才切流；隔离库保留语义 + 数据快照列表 |
| 2 | open | scheduler / auto-lifecycle 冷却分支时不感知复制集成员 | 分支被调度器休眠时成员容器可能继续运行占资源（显式 stop / delete 路径已级联收割） | scheduler coolFn 复用分支 stop 的成员级联；或复制集化分支视同 color-marked 不驱逐（设计文档既定方向） |
| 3 | open | promote 在 deploy 派发成功后立即解散复制集，不等 run 终态 | 若版本部署中途失败，成员已被收割，主容器仍是旧版本（入口不受损，但「提升」未达成需人工重试） | promote 改为跟踪 runId 终态后再解散；失败回滚为「保留成员」 |
| 4 | open | 成员物化的启动日志只保留内存尾部 40 行进 statusMessage，无独立日志入口 | 成员启动失败时排障信息有限（可用容器名走 docker logs） | 复制集页签接 container-logs 按 containerName 查询 |
| 5 | open | 成员直达子域未接 HTTPS 证书边界校验之外的墓碑/等待页 | 成员 provisioning 期间访问直达链会落 forwarder 等待页兜底，体验可接受但无成员级文案 | forwarder 等待页识别成员路由，给「成员启动中」文案 |
| 6 | open | remote executor 分支（executorId 指向远端）未支持复制集 | 远端分支的成员物化会在 master 本机起容器，端口/网络错位 | addMember 对 executorId 非 embedded 的分支直接拒绝并提示（待补） |
