| refactor | cds | 重构 CDS 自更新状态可观测链路:新增 self-status-cache 权威缓存 + cds-events-bus 单一事件总线,消除 /api/self-branches 500 + /api/self-status?probe=remote 重复请求循环 |
| feat | cds | 新增 GET /api/cds-events SSE 统一通道,前端只需一条长连接;新增 POST /api/self-refresh 任务化刷新接口 (202 + jobId) |
| fix | cds | /api/self-branches、/api/self-status、/api/pending-imports 失败时永远返 200 + degraded,不再 4xx/5xx;鉴权失败仍返 401/403 |
| feat | cds/web | 新增 useCdsEvents hook(全局单例 EventSource + 状态机:idle/connected/degraded/refreshing/updating/disconnected/error),GlobalUpdateBadge + MaintenanceTab 合并订阅,移除独立轮询 + fallback polling |
| fix | cds/web | 修复快速切换路由时 cds-events SSE 触发浏览器原生重连风暴 — onerror 中显式 close + 自家 exponential backoff 接管,防止 Cloudflare 400 spam |
| fix | cds/web | RouteFallback 用 CdsLogoLoader 替换裸"加载中..."文本,跟品牌一致 |
| fix | cds/web | DashboardErrorBoundary 改为右下角小 toast (createPortal + position:fixed z-99999),严禁占满主区;chunk-load 失败 5s 冷却内自动 reload(原 60s 过长) |
| fix | cds/web | ApiError 增 transient 标志,Cloudflare 边缘 400/5xx + 空 body + 无 requestId 时识别为抖动,UI 文案精简为"网络抖动,稍后自动恢复"(完整诊断到 console);BranchListPage 三处 refresh 路径在 transient 时静默保留 lastKnownGood,不再弹横幅 |
