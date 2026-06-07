| perf | prd-api | 更新中心三个端点支持瀑布式分页：releases 加 summary 模式（只元数据 + 计数）+ by-version 详情端点；current-week 加 daysLimit/daysOffset；github-logs 加 before cursor |
| perf | prd-api | 三个 DTO 新增 totalEntries/totalCount/hasMore/nextCursor，前端 chip 计数从全量取，不受分页切片影响 |
| perf | prd-admin | 更新中心首屏 payload 从 ~474kB 砍到 ~10kB：releases summary 模式 + current-week daysLimit=4 + github-logs limit=80 |
| perf | prd-admin | 历史发布版本详情按需懒加载：summary 到位后并发拉取 by-version，每个版本独立小请求，首屏即可见 chip 计数和高亮 |
| perf | prd-admin | 待发布日期组瀑布加载：滚动到末尾 1 组内自动 fetch 下一批，IntersectionObserver 触发 |
| perf | prd-admin | 实时日志 cursor 分页：首屏 80 条，滚动到末尾 10 条内自动续接更老批次 |
| refactor | prd-admin | useIncrementalVisible 保留用户滚动进度（total 增长时不重置 visibleCount） |
