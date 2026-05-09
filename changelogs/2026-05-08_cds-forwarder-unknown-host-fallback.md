| feat | cds | forwarder route=null 时 fallback 转给 master worker 端口(默认 5500),保留原 Host → master 用 ProxyService.serveStartingPageV2 等丰富等候/错误页处理(分支 building/error/stopped 状态用户看到友好页面而非 plain 503) |
| feat | cds | RouteRecord 加 preserveHost 字段:fallback 路由设 true 跳过 Host 改写,master 才能 detectBranch |
| test | cds | 新增 2 个 ProxyHandler 测试:unknown host fallback 转 master 保 Host / 没配 fallback 走原 503 plain page,1507 全绿 |
