| feat | prd-api | 作品广场改为热度排序（带时间衰减）+ _id 稳定 tiebreaker，消除翻页重复、新作品自然冒泡 |
| perf | prd-api | Executive 排行榜/团队页改为 MongoDB 服务端 $group 聚合，消除全集合 Find 进内存 + per-user N+1 |
| fix | prd-api | 修正缺陷"已解决"口径：未解决缺陷不再被计入解决数 |
| feat | prd-admin | Executive 统计页缺陷三列合并为单列「缺陷」（提交+解决），每个指标列加问号说明 tooltip（口径/怎么+1/排除异常，文案后端下发） |
| fix | prd-api | 作品广场热度分基准时间按 10 分钟取桶，修复偏移分页跨请求 $$NOW 漂移导致的边界作品重复/漏项 |
| test | prd-api | 新增作品广场热度公式单元测试 + Executive 排行榜聚合交叉验证集成测试 |
