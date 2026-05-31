| feat | prd-api | 新增「AI 大事早知道」资讯雷达后端代理（GET /api/ai-news/latest），代理 ai-news-radar 公共源 + 5min 内存缓存 + 6h stale 保底 |
| feat | prd-admin | AI 资讯改为「首页更新中心卡 teaser + 更新中心页 AI 大事时间线」：首页卡片底部偶尔跳出一条资讯标题，点进更新中心看时间分组资讯卡网格（全部/精选 + 加载更多往下翻）|
| feat | prd-api | AI 资讯返回上限 60 → 200，供更新中心时间线「加载更多」往下翻 |
| refactor | prd-admin | 移除首页常驻资讯大侧栏（视觉过重），首页恢复纯净单列布局；资讯逻辑抽到 components/ai-news/ 共享模块 |
| feat | prd-admin | 「AI 大事」默认改为单列新闻流时间线(左时间脊+来源 favicon+标题),可切换网格视图;favicon 加载失败回退分类图标 |
| feat | prd-api | AI 资讯透传 ai_signals 命中关键词数组,供前端做附加标签 |
| feat | prd-admin | 「AI 大事」时间线信息升级:左侧绝对时间轴(HH:MM)+来源身份行(favicon+来源名+站点)+加粗大标题+多标签(分类+命中关键词),每条独立富信息卡 |
| feat | prd-api | 新增「AI 大事」一句话解读：POST /api/ai-news/commentary 按资讯 id 批量调 LLM 生成编辑点评(基于标题/来源/分类)，落 ai_news_enrichments 缓存去重；注册 AppCaller prd-admin.ai-news.commentary::chat |
| feat | prd-admin | 「AI 大事」时间线改为流动新闻 feed(去掉每条独立边框,改细分隔线)，每条新增 AI 一句话解读(渐进拉取+生成中呼吸占位)，让资讯有内容、活起来 |
| fix | prd-admin | 「AI 大事」时间线视觉重做:三列布局(时间/脊/内容)修掉圆点压时间 bug;AI 解读去掉半透明圆角玻璃框,改扁平报刊导语(细实线+文字),整体更干净 |
| feat | prd-api | 「AI 大事」默认改为抓文章 meta 摘要(og:description/description)做内容片段,缓存 Excerpt;新增 POST /api/ai-news/excerpt(匿名,只抓 feed 内已知 URL 防 SSRF);AI 解读降级为抓不到摘要时的备用 |
| feat | prd-admin | 「AI 大事」内容片段默认显示文章摘要(无标签新闻 dek),抓不到才回退 AI 解读(带「AI解读」标签);渐进抓取 |
| feat | prd-admin | 「AI 大事」新增分类筛选:头部下方一排可横向滚动的 chip(全部/精选 + 各 aiLabel 分类,带图标+计数+分类色),点击按分类过滤 |
