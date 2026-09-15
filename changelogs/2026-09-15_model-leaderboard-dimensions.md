| feat | prd-api | 模型排行榜从 1 个榜扩到 11 个维度（文本/图像理解/搜索/文档/代码/文生图/图像编辑/文生视频/图生视频/视频编辑 + 原有 Agent 榜） |
| feat | prd-api | 解析器支持对战分榜结构（Elo 分数、置信区间含非对称写法、投票数、上下文窗口、初步标注），形状按页面实际结构判定并与目录声明校验 |
| feat | prd-api | 新增 GET /api/model-leaderboard/boards 分榜目录端点；手动同步支持 ?board= 只同步单个榜 |
| fix | prd-api | 修正「只有 Agent 榜能拿到数据」的错误结论——此前试的是不存在的路径，404 兜底页里的一句 Loading leaderboard 被误当成懒加载骨架 |
| feat | prd-admin | 榜单页新增维度切换器（按对话理解/编程智能体/图像生成/视频生成四组），分数榜与 Agent 榜两套列各自渲染 |
| test | prd-api | 解析守卫从 14 条扩到 27 条，新增分数榜真实片段 fixture 与分榜目录一致性断言 |
| fix | prd-api | 修复 ArenaLeaderboardFetcherTests 编译失败（error CS0234）：测试项目不引用 PrdAgent.Api，被测文件须逐个 Compile Include，此前漏链导致这批守卫从落地起从未编译过 |
| fix | prd-api | model_leaderboard_snapshots 补进 DataSyncScope.Excluded（外站公开数据的本地缓存，跨实例搬运无意义且会误导来源） |
