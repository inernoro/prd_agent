| fix | prd-admin | 修复文学创作投稿时为每张配图创建独立 visual 投稿导致首页刷屏的问题，改为仅创建一个 workspace 级别的 literary 投稿 |
| fix | prd-admin | 文学创作手动投稿增加配图检查，无配图时提示先生成 |
| feat | prd-admin | 首页作品广场卡片增加管理员悬浮撤稿按钮 |
| feat | prd-api | 新增管理员撤稿 API (DELETE /api/submissions/{id}/admin-withdraw) |
| feat | prd-api | 新增历史数据清理端点 (POST /api/submissions/cleanup-literary-visual)，清除文学创作误建的 visual 投稿 |
| feat | doc | 新增投稿画廊展示规格文档 (spec.submission-gallery.md)，明确视觉创作单图投稿 vs 文学创作 Space 投稿的粒度差异 |
