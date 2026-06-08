| perf | prd-admin | 更新中心 ChangelogBell / AppShell / AgentLauncherPage 均改用 daysLimit=8 拉 current-week，避免每次页面加载都拉 260kB 全量碎片 |
| perf | prd-admin | 历史发布版本详情改为 IntersectionObserver 懒加载：仅第一个版本（未发布）立即拉，其余版本卡片进视口才拉，避免一次性 700kB 详情压栈 |
| perf | prd-admin | 历史发布渲染逻辑：summary 模式（entriesOmitted=true）下即使 days/highlights 都为空也渲染卡片，让 IntersectionObserver 能挂上 |
| fix | prd-admin | 实时日志 chip 计数显示 0 的 bug：首屏拉一次 limit=80 让 totalCount 准确，不进入轮询 |
