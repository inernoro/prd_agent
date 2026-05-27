| perf | prd-api | 更新中心读取改为 serve-stale-while-revalidate：缓存陈旧时先返回旧值再后台静默刷新、按 key 去重防惊群、保留期 24h，生产冷启动不再卡 GitHub 拉取 |
| perf | prd-api | 更新中心新增启动预热（ChangelogCacheWarmer），首个用户请求前先把历史发布/待发布拉好放进缓存 |
| feat | prd-api | 更新中心 GET 端点下发 Cache-Control: private, no-cache（freshness-first）：浏览器每次向后端校验，杜绝「迟迟不更新」；秒开由前端 sessionStorage 首屏 + 后端内存缓存 ms 级响应兜底 |
