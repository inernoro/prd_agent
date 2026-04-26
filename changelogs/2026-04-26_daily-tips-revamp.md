| feat | prd-api | DailyTip 加 Version 字段 + User.LearnedTips,新增 POST /api/daily-tips/{id}/mark-learned 端点;visible 过滤按 (SourceId, Version) 判定,管理员升 Version 时已学会用户重新看到 |
| feat | prd-admin | TipsDrawer 顶栏左侧加「我已学会」按钮,Tour 走完最后一步自动 markLearned;右下抽屉 store 新增 markLearned action |
| feat | prd-api | 内置 seed 重写:删除「大全套 11 步」,新增 6 条真流程引导(自定义导航顺序排第一 + 涌现首颗种子 + 上传首个技能 + 写首份周报 + PR 审查 + 视觉创作首图) |
| feat | prd-admin | NavLayoutEditor / EmergenceNode 探索按钮 / Marketplace 上传技能按钮 / PrReview URL 与提交按钮 / Visual prompt 与开始按钮 都补齐 data-tour-id |
| chore | prd-api | AdminDailyTipsController.Seed 端点支持自动清理 deprecated seed(showcase-all-features) |
