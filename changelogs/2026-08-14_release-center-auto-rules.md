| feat | cds | 发布中心新增事件驱动的自动发布规则：分支被 push / 开 PR 时自动发到目标环境，支持分支 glob、路径过滤与手动批准 |
| feat | cds | ScheduledJob 新增 push 调度类型，GitHub push webhook 命中分支后触发对应规则，复用既有并发/审批/回滚/运行记录 |
| refactor | cds | 定时驱动判据收敛成 isTimerDrivenSchedule 单一来源，替换散在四处的 type !== 'manual' |
