| fix | prd-admin | 待发布瀑布加载 offset 计算错误：原 `fragments.length + daysOffset` 会把每批响应的 skip 值二次叠加，从第二次续接起每次跳过几天留下日期组空洞（4→14 应为 4→10），改为 `fragments.length` |
| fix | prd-admin | summary 刷新清空 days 时，本地 `releaseDetailTriggeredRef` 记忆导致详情不再重拉、卡片留空的问题：删本地缓存，以 `entriesOmitted` 为信号，并发去重由 store 端 `loadingReleaseVersions` 兜底 |
| fix | prd-admin | 实时日志 35s 轮询 / 手动刷新会用 first-page 80 条覆盖整个列表，丢掉 cursor 续接的更老历史：刷新路径保留 previous tail（不在 newShas 中的条目）合并 |
| fix | prd-admin | SSE / 后台 `loadCurrentWeek({daysLimit:4})` 会把已通过 loadMoreFragments 累积的 fragments 缩回 4 个：store 端按 date 集合保留 incoming 之外的尾部 |
| fix | prd-api | `MapReleases` 的 `TotalReleases/TotalEntries` 之前从 `view.Releases`（已被 limit 截断）算，chip 计数会偏低：controller 永远以 limit=100 拉 reader，totals 走全量、输出列表按 displayLimit 切片 |
