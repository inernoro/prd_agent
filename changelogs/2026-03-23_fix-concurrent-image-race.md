| fix | prd-api | 修复文学创作投稿只显示 5/8 张图：不再过滤 ArticleInsertionIndex 为 null 的图片，简化为 Space 整体查询 |
| refactor | prd-api | Worker 更新 AssetIdByMarkerIndex 改用 MongoDB 原子 $set，消除并发竞争 |
