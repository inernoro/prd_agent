| fix | prd-api | 用户改名后级联同步周报域所有冗余姓名快照（团队成员/周报作者/审阅人/退回人/日常打点/点赞/浏览），新增 POST /api/users/backfill-display-names 一次性回填历史数据 |
| fix | prd-admin | 团队周报列表卡片改用 flex-1 撑满剩余视口，去掉 max-h-540 魔数避免宽屏下方大块空白 |
| feat | prd-admin | 日常记录 Todo 标签的"计划周次"新增"本周"选项，与已有"下周"/"下下周"组成三选一 |
| feat | prd-admin | 日常记录右栏"快捷分类"替换为"待办计划"面板，按本周/下周/下下周三组聚合所有 Todo 条目 |
