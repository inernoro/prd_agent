| feat | prd-api | 新增 GET /api/executive/team-insights：团队洞察四段式真实聚合（团队状态/需要关注/成员画像/价值流），指标口径与不可得项由后端 SSOT 下发 |
| feat | prd-admin | 团队洞察改版为结论优先四段式面板，综合排行榜降级为可折叠明细 |
| fix | prd-admin | 修正综合分口径缺陷：图片合计与视觉生图/文学配图/上传参考图重复计分、日均一次即满分的归一化抹平真实差距 |
| fix | prd-admin | 移除排行榜奖牌 emoji，改用序号与语义色（CLAUDE.md 规则 0） |
| test | prd-admin | 新增团队洞察接线与空值判据守卫测试（端点登记 + null 指标不得退化成 0） |
