| feat | cds | 发布步骤模型成为一等公民：执行器按 ReleasePlan.steps 汇报「第 N/共 M 步」，前端不再用正则从日志反推步骤，并清除发布中心的本仓脚本名硬编码（CDS 恢复成通用产品） |
| feat | cds | 发布 ETA：新增独立的生产发布耗时台账（不复用 DeployDurationMode 的 release，那是极速版构建模式，语义不同会互相污染），发布进行中显示「预计还需 MM:SS（近 N 次中位）」，样本不足时给诚实文案而非编造数字 |
| feat | cds | 生产存活监控：存活探测新增 URL 型发布目标，走 ReleaseTarget.ssh.healthcheckUrl，状态页出现生产目标的可用率与故障时间线；复用既有 uptime-metrics 纯函数，不另起一套聚合 |
| feat | cds | 发布生命周期事件上 cds-events-bus（started/succeeded/failed/rolled-back），告警通道与存活告警共用一条 |
| feat | cds | 发布 SSE 流补 id: 行，支持 Last-Event-ID 标准续传，与分支部署流对齐 |
| test | cds | 新增阶段二回归约 100 例（步骤模型/ETA/存活目标/事件/SSE 续传），含多个「防再修一边」的唯一判定源守卫 |
