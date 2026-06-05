| feat | prd-api | 里程碑第一波：PmMilestone 增 OwnerId/OwnerName(负责人) + AcceptanceCriteria(验收标准 DoD 清单)；CreateMilestone/UpdateMilestone 落库；标记达成加验收门禁(有验收项且未全勾选则拒绝)；ListMilestones 返回 owner/验收完成数/计划-实际偏差 slippageDays |
| feat | prd-api | 里程碑健康度改为前瞻式：除临近截止(≤3天)外，进度落后于时间消耗(SPI<0.85)即 at_risk，给足补救窗口 |
| feat | prd-api | 逾期提醒 worker：里程碑提醒改为定向到里程碑负责人(未设回退 leader)，并纳入临近截止(非仅逾期) |
| feat | prd-admin | 里程碑详情抽屉(MilestoneDetailDrawer)：负责人(UserSearchSelect)+验收标准清单(增删/勾选/编辑)+说明+关联目标+其下任务+进度+计划/实际偏差，验收未全勾选禁止标记达成 |
| feat | prd-admin | 里程碑卡片整卡可点进详情，新增负责人/验收 X-Y/延期或提前天数 展示；新增与编辑统一走详情抽屉 |
