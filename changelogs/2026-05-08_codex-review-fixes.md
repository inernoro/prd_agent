| fix | prd-admin | 海报弹窗 1.5s 自动 markSeen 不再关闭 modal —— 之前 dismiss(id) 同时把 id 加入 closedIds 导致 shouldShowCurrent 变 false，modal 立刻消失。改为 markSeen 静默写后端 SeenBy + sessionStorage，dismiss 仅在用户主动 ✕ 时调用 (Codex P1) |
| fix | prd-api | CronEvaluator 现在按 schedule.Timezone 解释 cron 字段（默认 Asia/Shanghai），cron "0 9 * * *" 真正落在 09:00 CST = 01:00 UTC 而非 09:00 UTC = 17:00 CST。Controller create + WorkflowScheduleWorker 的 next 计算路径都串通 timezone 参数 (Codex P2) |
| test | prd-api | WorkflowSchedule_DefaultValues 断言适配新 nullable CronExpression：Assert.Empty → Assert.Null + 增加 Mode 默认值断言 |
