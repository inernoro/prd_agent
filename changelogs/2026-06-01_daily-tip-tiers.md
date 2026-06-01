| feat | prd-api | DailyTip 加 `Tier` 字段（basic/advanced），basic 完成一次永不再弹（用 sentinel Version=int.MaxValue 写入 LearnedTips），advanced 走 Version 递增层叠推进 |
| feat | prd-api | /api/daily-tips/visible 响应携带 Tier 字段，前端可据此显示「升级」徽章 |
| feat | prd-api | seed tips 全部补 Tier：feature-release 类（2 条周报/知识库 + 新增 1 条网页托管本周改动）= advanced；其余基础操作教程 = basic |
| feat | prd-api | 新增 seed: `webpages-basics`（basic 4 步：空间模型 + dropzone + 投放面板）+ `webpages-feature-2026w22-pill-controls`（advanced 5 步：分级头部、排序/分组 pill、视图切换、整页提亮） |
| feat | prd-admin | 网页托管补 10 个 data-tour-id 锚点：webpages-root / webpages-header-actions / webpages-space-bar / webpages-space-add / webpages-sort-pills / webpages-group-pills / webpages-view-toggle / webpages-dropzone / share-dock-panel |
