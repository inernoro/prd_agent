| feat | prd-api | 周报智能体新增月报：固定四章手写（关联周报 + 本月成果、问题与对策、三位伙伴、建议），新增 report_monthly_reports 与 monthly-reports 接口，不接入 AI |
| feat | prd-api | 团队新增独立的「月报可见性」设置，草稿仅作者可见，可见性判定收敛到 ReportAccessPolicy |
| feat | prd-admin | 周报智能体新增「月报」标签页、月报编辑页（关联周报选择、伙伴选择、自动保存、提交前未完成项提示）与月报详情页 |
| feat | prd-admin | 月报详情页支持点赞、章节评论、划词评论、回复、带图评论、浏览记录与版本时间线，与周报共用同一套组件 |
| fix | prd-api | 周报的评论、点赞、浏览接口改为遵守团队「仅负责人可查看」设置，普通成员不再能读到别人周报下的评论与点赞名单 |
| refactor | prd-api | 周报评论 / 点赞 / 浏览逻辑收敛到 ReportInteractionService，周报与月报共用 |
| refactor | prd-admin | 章节评论区抽为 ReportSectionComments，点赞与评论组件按报告种类走 reportInteractionApi 注册表 |
| feat | prd-admin | 「月报」标签页为负责人新增「团队月报」视图：本月谁已提交、谁还在写，已提交的可直接点进去查看 |
| feat | prd-api | 新增团队月报概览接口；成员提交月报通知负责人、月报收到评论通知作者，通知来源为「月报」并直达那份月报 |
| polish | prd-admin | 「团队月报」按周报团队页重做：左侧月导航 + 团队人数 / 已提交 / 待提交统计（悬停看待提交名单）+ 已提交列表，点成员在右侧直接阅读 |
| feat | prd-admin | 「我的月报」草稿卡片支持修改与删除 |
| feat | prd-api | 月报第三章改为手写伙伴名字 + 多行理由、选填最多 3 位，旧数据回退显示原姓名 |
| fix | prd-api | 团队月报统计把已提交的请假成员也计入已提交，负责人与请假成员免交不计入待提交 |
