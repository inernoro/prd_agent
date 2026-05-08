| feat | prd-api | WeeklyPosterAnnouncement 加 SeenBy: List<string>（已看过的用户ID）；GET /current 过滤掉当前用户已读，新增 POST /api/weekly-posters/:id/mark-seen 端点（AddToSet 去重） |
| feat | prd-admin | 海报弹窗"已读"改走后端持久化：weeklyPosterStore.dismiss 调 markWeeklyPosterSeen API；用户登录看过一次后跨会话/跨设备都不再弹，发布了新海报（不同 id）时所有用户再弹一次 |
| fix | prd-api | ControllerIdentityExtensions 补 GetUserIdOrNull 扩展（替代 WeeklyPosterController 用过但未声明的 helper） |
