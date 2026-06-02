| feat | prd-api | 里程碑第二波：依赖/门禁——PmMilestone 增 DependsOn(前置里程碑，环检测保持 DAG)；ListMilestones 派生 blocked/blockedBy(前置未达成即受阻)；标记达成加依赖门禁(前置未全达成则拒绝) |
| feat | prd-api | 里程碑交付物关联：PmMilestone 增 Deliverables(weekly/decision/link 引用 + 标题快照)，Create/Update 落库 |
| feat | prd-api | 风险关联里程碑：PmRisk 增 RelatedMilestoneId，CreateRisk/UpdateRisk 落库 |
| feat | prd-admin | 里程碑详情抽屉新增：前置里程碑多选(受阻提示)+交付物 composer(周报/决策/外链)+反查威胁本里程碑的风险；标记达成受验收+依赖双门禁 |
| feat | prd-admin | 里程碑卡片新增 受阻/交付物数/前置数 标识；风险登记册可关联里程碑(下拉+卡片 chip) |
| feat | prd-admin | 甘特图里程碑菱形支持拖拽改期(owner/leader)：拖动实时显示新日期，松手落库 dueAt |
