| refactor | cds | 重构 CDS 自更新状态可观测链路:新增 self-status-cache 权威缓存 + cds-events-bus 单一事件总线,消除 /api/self-branches 500 + /api/self-status?probe=remote 重复请求循环 |
| feat | cds | 新增 GET /api/cds-events SSE 统一通道,前端只需一条长连接;新增 POST /api/self-refresh 任务化刷新接口 (202 + jobId) |
| fix | cds | /api/self-branches、/api/self-status、/api/pending-imports 失败时永远返 200 + degraded,不再 4xx/5xx;鉴权失败仍返 401/403 |
| feat | cds/web | 新增 useCdsEvents hook(全局单例 EventSource + 状态机:idle/connected/degraded/refreshing/updating/disconnected/error),GlobalUpdateBadge + MaintenanceTab 合并订阅,移除独立轮询 + fallback polling |
| fix | cds/web | 修复快速切换路由时 cds-events SSE 触发浏览器原生重连风暴 — onerror 中显式 close + 自家 exponential backoff 接管,防止 Cloudflare 400 spam |
| fix | cds/web | RouteFallback 用 CdsLogoLoader 替换裸"加载中..."文本,跟品牌一致 |
| fix | cds/web | DashboardErrorBoundary 改为右下角小 toast (createPortal + position:fixed z-99999),严禁占满主区;chunk-load 失败 5s 冷却内自动 reload(原 60s 过长) |
| fix | cds/web | ApiError 增 transient 标志,Cloudflare 边缘 400/5xx + 空 body + 无 requestId 时识别为抖动,UI 文案精简为"网络抖动,稍后自动恢复"(完整诊断到 console);BranchListPage 三处 refresh 路径在 transient 时静默保留 lastKnownGood,不再弹横幅 |
| fix | cds/web | apiRequest 加 transient 静默重试 — 检测到 4xx/5xx + 空 body + 无 requestId 自动 500ms 后重试一次,99%+ Cloudflare 边缘抖动用户无感(GET 自动,POST 需 retryTransient:true) |
| feat | cds/web | 新增 useSseConnection hook(通用 SSE 长连接管理:onerror 立即 close + 5s/10s/20s 退避,3 次后停),作为后续 6 处 EventSource 迁移目标 |
| fix | cds/web | 5 处 raw EventSource 加 close-on-error 阻断浏览器原生 3s 重试:CommitInbox / BranchTopologyPage / BranchDetailPage ×2 / BranchListPage ×2 |
| fix | cds/web | ErrorBlock 加 transient 参数,transient=true 时完全不渲染(配合 ApiError.transient),为 20+ 处现有调用提供逃生通道 |
| fix | cds | infra auto-restart crash loop 检测 — 跟踪 lastSuccessfulStart 时间戳,启动后 < 60s 又死的标软失败,N 次软失败后 svc.status=error 停止重试。修复 minio "docker start 永远成功但 5s 后死" 的 30s 死循环 |
| fix | cds/web | App.tsx ErrorToastPortal 硬编码 #fff/#ef4444 改走 hsl(var(--destructive)) token,符合 cds-theme-tokens 双主题规则 |
| fix | cds | Node http.Server.keepAliveTimeout 5s → 65s + headersTimeout 70s,匹配 nginx upstream idle pool 60s。修复 nginx-reverse-proxy 场景下 stale-keepalive 导致 SSE 端点 50% 严格交替 400/200 的根因(SSH 现场诊断证实) |
