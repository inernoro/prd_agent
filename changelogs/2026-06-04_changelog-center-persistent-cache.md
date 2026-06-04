| feat | prd-api | 更新中心数据终身存储到 MongoDB（changelog_snapshots），加载只读存量绝不空白 |
| feat | prd-api | 更新中心后台固定周期自动刷新（默认 4h，Changelog:RefreshIntervalHours 可配），与用户访问解耦 |
| feat | prd-api | 更新中心新增 SSE 推送端点 /api/changelog/stream，后台刷新有更新时主动推到页面 |
| feat | prd-admin | 更新中心头部展示「更新时间 + 更新规则（每 N 小时自动刷新·终身缓存）+ 实时同步状态」 |
| feat | prd-admin | 更新中心订阅 SSE，服务器有更新自动推送并静默重读存量，无需手动刷新 |
| fix | prd-api | 更新中心冷实例 hydrate 到陈旧快照时也后台静默 revalidate，与热缓存路径对称（修复重启后首请求停在旧快照需等 Worker 周期的不对称） |
