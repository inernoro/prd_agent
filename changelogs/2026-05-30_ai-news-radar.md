| feat | prd-api | 新增「AI 大事早知道」资讯雷达后端代理（GET /api/ai-news/latest），代理 ai-news-radar 公共源 + 5min 内存缓存 + 6h stale 保底 |
| feat | prd-admin | AI 资讯改为「首页更新中心卡 teaser + 更新中心页 AI 大事时间线」：首页卡片底部偶尔跳出一条资讯标题，点进更新中心看时间分组资讯卡网格（全部/精选 + 加载更多往下翻）|
| feat | prd-api | AI 资讯返回上限 60 → 200，供更新中心时间线「加载更多」往下翻 |
| refactor | prd-admin | 移除首页常驻资讯大侧栏（视觉过重），首页恢复纯净单列布局；资讯逻辑抽到 components/ai-news/ 共享模块 |
| feat | prd-admin | 「AI 大事」默认改为单列新闻流时间线(左时间脊+来源 favicon+标题),可切换网格视图;favicon 加载失败回退分类图标 |
| feat | prd-api | AI 资讯透传 ai_signals 命中关键词数组,供前端做附加标签 |
| feat | prd-admin | 「AI 大事」时间线信息升级:左侧绝对时间轴(HH:MM)+来源身份行(favicon+来源名+站点)+加粗大标题+多标签(分类+命中关键词),每条独立富信息卡 |
