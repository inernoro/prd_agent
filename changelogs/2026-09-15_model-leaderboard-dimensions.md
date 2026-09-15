| feat | prd-admin | 首页右上角教程中心换成模型排行榜挂件，轮播前三，点击进入 /model-leaderboard；教程整体移入左下角头像菜单 |
| feat | prd-admin | 新增模型排行榜页，11 个公开分榜按四组可切（编程智能体/代码能力/文本对话/图像理解/联网搜索/文档理解/文生图/图像编辑/文生视频/图生视频/视频编辑），支持仅开源筛选，已注册百宝箱 |
| feat | prd-admin | 当前维度同步到 URL（?board=text-to-image），刷新保持、可分享、交付能给出落到该维度的深链；URL 里写了不存在的榜退回默认榜 |
| feat | prd-admin | 榜单页内存缓存（切回已看过的维度不再重拉，刷新/同步按钮强制绕过）+ 渐进渲染（首屏 40 行，滚到底追加），治 402 行文本榜的卡顿 |
| feat | prd-api | 新增 arena.ai 榜单同步：每天一轮抓取解析落库，只在权威部署跑，抓失败保留旧快照 |
| feat | prd-api | 解析器支持两种表格形状——Agent 榜六指标（含置信区间、名次区间、会话数与成本单价，方向 ▲▼ 解析进数值符号）与对战分榜（Elo 分数、非对称区间、投票数、上下文窗口、初步标注），形状按页面实际结构判定并与目录声明校验 |
| feat | prd-api | 新增 GET /api/model-leaderboard、/top、/boards 三个只读端点，全员可见，页面只读库不打外站；手动同步在 /api/admin/ 前缀下走「模型管理-写」权限，支持 ?board= 只同步单个榜 |
| fix | prd-api | 修正「只有 Agent 榜能拿到数据」的错误结论——此前试的是不存在的路径，404 兜底页里的一句 Loading leaderboard 被误当成懒加载骨架 |
| fix | prd-api | 写侧 Controller 改用 api/admin/ 前缀：权限中间件按路由前缀查权限，与只读端点同前缀会把只读也一起要求 mds.read，全员可见形同虚设 |
| fix | prd-api | Agent 行必须恰好解析出六个指标，否则整行拒绝——中间某格改写会让后续值整体前移、每个字段挂错名字，而条目数与形状判定照样通过 |
| fix | prd-api | 快照文档 Id 改为由榜名派生的确定性值，消除首次同步时周期任务与手动触发并发插出两条文档的窗口；/boards 读取同时改为重复容忍 |
| fix | prd-api | model_leaderboard_snapshots 补进 DataSyncScope.Excluded（外站公开数据的本地缓存，跨实例搬运无意义且会误导来源） |
| fix | prd-api | 修复 ArenaLeaderboardFetcherTests 编译失败（error CS0234）：测试项目不引用 PrdAgent.Api，被测文件须逐个 Compile Include，此前漏链导致这批守卫从落地起从未编译过 |
| fix | prd-admin | 切维度时旧请求后返回不再覆盖新榜数据（按发起时的榜校验，对不上整份丢弃，缓存照存） |
| fix | prd-admin | 表格布局三连修：模型列不再吃掉全部富余（中间空一大块）、指标条加满宽轨道（长列表右边缘不再是锯齿）、撤掉居中让表格靠边填满画布 |
| test | prd-api | 解析守卫扩到 28 条，fixture 取自真实页面片段，覆盖六指标对位、Down 转负、非对称区间、五列与七列混排、分榜目录一致性 |
