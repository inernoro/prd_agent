| fix | prd-admin | 知识库访客记录抽屉：登录访客渲染真实头像（原永远显示通用占位图标）、暗色面板改不透明避免页面头部穿透、补 createPortal + ESC 关闭、停留时长为 0（leave 信标未送达）显示「—」而非误导性「< 1 秒」 |
| fix | prd-admin | 知识库访客记录列表行紧凑化：缩小行内边距/头像、时间+停留靠右填充原本空荡的右侧 |
| fix | prd-admin | 修复 DocBrowser 文档列表前导图标大小不一：图标外包 flex-shrink-0 容器，避免长标题时 SVG 被 flexbox 压缩 |
| fix | prd-admin | 移除 DocBrowser 订阅条目的状态小圆点（出错红点等），不再为单个小点占用整行徽章行 |
| feat | prd-api | 新增知识库访客聚合报表端点 GET /stores/{id}/analytics（按天趋势/24h时段/文档排行/停留分布/KPI，MongoDB $facet 聚合，支持时间档 days + 本地时区 tz） |
| feat | prd-admin | 访客记录抽屉升级为聚合报表：时间档切换（7/30/90天）、KPI 扩展（平均停留/回访率/跳出率）、访问趋势折线 + 24h时段柱图（ECharts）、停留分布条、文档访问排行、CSV 导出 |
| feat | prd-api | 新增账号级访客总计端点 GET /stores/analytics-summary（聚合我名下所有知识库的总访问/独立访客/总停留） |
| feat | prd-admin | 知识库「我的空间」统计行内联扩展账号级总计：在「共 N 个知识库 · M 篇文章」后追加 总访问/访客/总停留 |
| feat | prd-api | 访客报表/明细端点重构为「按 storeIds 聚合」可复用，新增账号级 GET /stores/analytics-all 与 /stores/view-events-all（聚合我名下所有知识库） |
| feat | prd-admin | 知识库列表页新增「统计」按钮（分析全部知识库），知识库内「访客」按钮改为「统计」（分析本库）；ViewersDrawer 支持 account 范围复用同一报表 |
| feat | prd-admin | 账号级访客总计数字 count-up 缓动 + 整段淡入，避免异步加载后突然蹦出撑宽统计行 |
| fix | prd-admin | 知识库列表页统计行左右重排：功能区（库数/文章数）居左，统计区（访问/访客/停留）移到右侧，统计按钮再往右 |
| feat | prd-api | 访客聚合报表新增「知识库访问排行 topStores」「标签访问统计 tagStats（lookup 文档标签聚合）」，文档排行/流水补 storeId 供点击跳转 |
| feat | prd-admin | 访客统计抽屉新增 最受欢迎文档(可点击跳转)/知识库访问排行(可点击)/标签访问统计；点击文档排行或流水中的文档直达对应知识库并打开该文档 |
