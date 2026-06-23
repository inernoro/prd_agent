| fix | cds | 修复 CDS 系统更新弹窗"目标分支"下拉选中后不关闭（选中回焦输入框时被 onFocus 重新打开）|
| fix | cds | 修复"重启未确认"频繁误报：除 daemonReadyAt 外，用进程启动时间 __CDS_PROCESS_STARTED_AT 兜底确认重启完成；server.ts 顶层判定同步对齐并对 web-only 更新判 not_required |
| fix | cds | 修复集群统计 embedded 主节点 CPU/内存/容器数/分支数恒为 0：新增 refreshEmbeddedMasterLoad，按需从 os + 主节点状态重算真实负载 |
| feat | cds | 项目列表页与项目页右上角新增"运维监控"入口，性能(含容器总数)/执行器/活动三页签展示，取代单列长滚动 |
| perf | prd-admin | Dockerfile 增加 pnpm BuildKit 缓存挂载，避免每次分支预览构建从零重装依赖 |
| perf | cds | Dockerfile 增加 pnpm BuildKit 缓存挂载 |
| polish | cds | 分支等待页 ETA 文案标明为"本项目"口径并带构建模式(发布版/热加载)，澄清非单分支均值 |
| polish | cds | 发布弹窗增加发布前检查/提交任务/发布进行中的阶段反馈与"已用时"计时，消除等待期空白(2 秒原则) |
