| fix | cds | 部署在途（building/starting/restarting）不再被总览谎报成「分支未运行」：分支状态的七档枚举不再折叠成布尔值传给面板 |
| fix | cds | 指标历史轮询的并发取舍抽成 latest-wins 闸门：慢请求后回不拽回旧窗口、请求持续超时不饿死轮询、A→B→A 的旧响应不串台 |
