| fix | prd-admin | 教程抽屉改**轮播模式**:头部显示 `‹ 2/5 ›` 分页器,一次只渲染当前 tip 一张卡片;`maxHeight` 从 `calc(100vh - 180px)` 降到 `min(360px, calc(100vh - 180px))`,不再挡住页面其他内容 |
| feat | prd-admin | TipsDrawer 抽屉卡片新增**步骤提示徽章**:`📍 N 步 · 跳转 → 高亮 → 点击`,让用户一眼看到教程深度 |
| fix | prd-admin | SpotlightOverlay 找不到目标元素时不再静默失败:6s 超时后显示**橙色友好失败卡片**,说明原因(当前页面还没数据 / 目标元素不可见)+ Selector + 「跳过这一步」+「关闭引导」两个按钮;解决「点 library-publish / changelog-weekly 跳转后没反应」的困惑 |
| perf | prd-admin | SpotlightOverlay 轮询频率 150ms × 50(7.5s)改成 250ms × 24(6s),tick 次数减半;TipsDrawer seen 上报从「一次性打全量 tips 的 N 条 API」改成「轮播切换时只打当前一条」,减少列表推送时的一次性 API 风暴 |
