| fix | cds | publisher /api/ convention 总是写 prefix route(原 apiSvc !== defaultProfile guard 在 api == default 时跳过,Cursor Bugbot Medium 提议为对齐 master detectProfileFromRequest 无条件行为 + 防 resolver 行为变化导致路由分叉)|
| fix | cds | forwarder-main handleDiagnostic 用 path 部分(去 query string)匹配端点,原 url === '/path' 不匹配 cache-busting `?v=1` 让监控/LB 看 forwarder 不健康,Cursor Bugbot Low |
