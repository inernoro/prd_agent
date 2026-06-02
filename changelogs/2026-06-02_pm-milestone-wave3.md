| feat | prd-api | 里程碑第三波：AI 里程碑建议——新增 pm-agent.milestone-suggest AppCaller + PmAgentService.SuggestMilestonesAsync + SSE 端点 projects/{id}/milestones/suggest(限 owner/leader，依据业务目标/团队目标/任务/计划周期建议分阶段里程碑含验收标准与建议日期) |
| feat | prd-api | 里程碑基线：PmMilestone 增 BaselineDueAt(立项时计划日快照)；ListMilestones 返回 baselineDueAt/driftDays(当前计划-基线)；MilestoneRequest 增 resetBaseline 重设基线；旧数据首次改期自动回填基线 |
| feat | prd-admin | 里程碑面板三视图切换：时间轴 / 月历(MilestoneCalendar) / 基线趋势(echarts: 基线·当前计划·实际达成对照) |
| feat | prd-admin | 新增 MilestoneSuggestPanel：SSE 流式 AI 建议里程碑草稿，可编辑(名称/说明/日期/验收项)+「按顺序串联前置依赖」批量创建 |
| feat | prd-admin | 里程碑详情抽屉展示基线计划日 + 滑移天数 + 重设基线；卡片展示「基线 +N 天」推迟标识 |
