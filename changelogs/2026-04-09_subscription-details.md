| feat | prd-admin | 知识库订阅详情：新增订阅详情抽屉，展示状态卡（上次/下次同步、错误信息）、调整同步间隔、暂停/恢复、立即同步，并以时间线呈现"最近变化记录" |
| feat | prd-admin | 文件树为最近 24 小时内有更新的订阅文件标记 (new) 徽标，订阅条目右侧增加同步状态彩点指示器 |
| feat | prd-admin | 文档预览顶栏对订阅来源文件展示版本徽标（GitHub 类显示 #shortSha），点击直接打开订阅详情 |
| feat | prd-api | 新增 document_sync_logs 集合，订阅同步只在内容真正变化或出错时落库（无变化只更新 LastSyncAt），避免日志膨胀 |
| feat | prd-api | URL 订阅同步使用 If-None-Match / If-Modified-Since 条件请求 + ContentHash 兜底，避免被源站封控 |
| feat | prd-api | 新增 GET /entries/{id}/sync-logs 与 PATCH /entries/{id}/subscription 端点，支持查看变化日志 + 暂停/调整间隔 |
| feat | prd-api | DocumentEntry 增加 IsPaused / LastChangedAt / ContentHash / LastETag / LastModifiedHeader 字段 |
| refactor | prd-api | GitHubDirectorySyncService.SyncDirectoryAsync 改为返回 GitHubDirectoryDiff，由 Worker 决定是否落变更日志 |
