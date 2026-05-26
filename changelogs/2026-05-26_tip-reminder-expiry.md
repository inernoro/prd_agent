| feat | prd-admin | 新功能小技巧公告：周报编辑器升级、知识库阅读体验升级两条 feature-release tip 默认推送给所有用户 |
| feat | prd-api | 小技巧过时机制：feature-release/bug-fix 类 tip 默认 7 天后过期；defect-fix 修复提醒 14 天改 7 天 |
| feat | prd-api | 首页提醒过时机制：AdminNotification 默认 7 天后过期，过时提醒不再堆在首页（显式指定过期时间的不受影响） |
| fix | prd-api | 修复 DailyTip seed/reset 克隆时丢失 StartAt/EndAt，导致内置 tip 无法携带过期窗口 |
