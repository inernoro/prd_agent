| feat | prd-api | 每日小贴士新增定向推送 + 交互统计(奥卡姆剃刀方案):`DailyTip` 内嵌 `Deliveries: List<DailyTipDelivery>` 记录(UserId / Status: pending/seen/clicked/dismissed / ViewCount / MaxViews / PushedAt / LastSeenAt / ClickedAt / DismissedAt),不新开集合 |
| feat | prd-api | AdminDailyTips 新增 `POST /{id}/push`(推送给用户,支持 reset 重置) + `GET /{id}/stats`(汇总 + 每用户状态 + 展示名),DailyTips 新增 `POST /{id}/track`(seen/clicked/dismissed,seed-* 自动忽略) |
| feat | prd-api | DailyTips/visible 过滤器扩展:有 Deliveries 的 tip 只对列表内且未 dismissed、未超过 MaxViews 的用户可见;被投递用户视为定向置顶,返回 `deliveryStatus/viewCount/maxViews` |
| feat | prd-admin | 小技巧管理:每条 tip 新增「推送」按钮 → `PushDialog` 挑用户 + 设置展示上限 + 重置开关,同屏展示投递列表(头像占位 / 状态徽章 / 展示次数 / 最后查看时间 / 汇总 chip) |
| feat | prd-admin | TipsDrawer 打开时自动 `track(seen)`,CTA 点击 `track(clicked)`,用户关闭 `track(dismissed)`;TipsRotator 点击 `track(clicked)`,补齐后台统计链路 |
