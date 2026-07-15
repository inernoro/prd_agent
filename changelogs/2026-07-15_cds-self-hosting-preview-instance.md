| feat | cds | 新增预览实例模式（CDS_PREVIEW_INSTANCE=1）：CDS 可托管 CDS 自身分支预览，宿主操作命令统一拦截为友好提示，self-update/部署接口返回明确的预览实例说明，验收 CDS 改动不再需要 self-update 生产实例 |
| feat | cds | 预览实例首启 seed 演示项目与三态示例分支（running/error/idle），空库也有内容可验收；新增公开端点 GET /api/instance-mode 与 Shell 顶部预览实例提示条 |
| feat | cds | 新增 cds-self 独立项目 compose 合同（cds/cds-compose.selfhost.yml），同仓库第二项目承载子 CDS 构建，主项目分支零额外构建开销 |
| docs | doc | 新增 design.cds.self-hosting 设计文档（预览实例边界、多构建取舍、实验田域名等后续路线），同步 index.yml 与 guide.list.directory.md |
| docs | doc | 新增 guide.cds.host-migration 宿主迁移 Runbook（必迁三样、调度器/并发闸核对、缓存预热、极速版首拉限流、选机 CPU 优先） |
| fix | cds | 项目删除连带容器物理清理：先 docker rm -f 分支/项目 infra 容器、后删网络（修正旧实现先删网络必然失败的顺序错误），系统级 infra（cds-state-mongo）免删，响应体如实声明 containerTeardown |
| feat | cds | 新增孤儿容器收割器：每小时把 state 中无 owner 的 cds-managed 容器停掉（只停不删），带 label 过滤/空库守卫/docker 查询失败放弃/系统容器免死/CDS_ORPHAN_CONTAINER_REAPER 逃生阀，处置写 server-event 留痕 |
| docs | doc | 新增 design.cds.lifecycle-atomicity 架构文档：五类原子性问题分类（级联残缺/顺序错误/检测无动作/吞错无兜底/两阶段写窗口）+ 24h 日志 68 孤儿容器实证 + 对账收敛架构原则与后续波次 |
