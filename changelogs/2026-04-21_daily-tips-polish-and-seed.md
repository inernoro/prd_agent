| fix | prd-admin | 小贴士抽屉触发按钮从右上角铃铛改到右下角 Lightbulb(48px 圆形 + 紫色渐变 + hover 上浮),避免跟 AdminNotification 的 Bell 图标撞风格;抽屉从底部向上弹出,卡片阴影收紧、渐变边框更柔 |
| feat | prd-api | AdminDailyTips 新增 `POST /api/admin/daily-tips/seed` 一键幂等植入 8 条内置默认 tip(按 SourceId 去重),用于新环境 / 清空后让管理员把 seed 变成真实数据;返回 insertedCount/skippedCount/totalDefaults |
| feat | prd-admin | 小技巧管理页工具栏新增「一键植入默认」按钮;空状态改为 Sparkles 大图标 + 说明文案 + 两个 CTA(一键植入 / 从零新建),不再只是干瘪的「暂无」提示 |
