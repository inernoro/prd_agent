| feat | prd-admin | 首页右上角教程中心换成模型排行榜挂件，轮播 arena.ai Agent 榜前三，点击进入 /model-leaderboard |
| feat | prd-admin | 新增模型排行榜页，五个公开分榜（Agent/代码/文档/视觉/生图）可切，支持仅开源筛选，已注册百宝箱 |
| feat | prd-api | 新增 arena.ai 榜单同步：每天一轮抓取解析落库，只在权威部署跑，抓失败保留旧快照 |
| feat | prd-api | 新增 GET /api/model-leaderboard 与 /top 两个只读端点，全员可见，页面只读库不打外站 |
| refactor | prd-admin | 教程中心等级与进度整体移入左下角头像菜单，与原有「我的学习进度」合并为一条入口 |
| test | prd-api | 新增榜单解析器守卫，fixture 取自真实页面片段，覆盖表头跳过／改版返回空／负分／缺误差范围 |
