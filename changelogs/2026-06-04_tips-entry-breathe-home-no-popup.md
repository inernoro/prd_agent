| fix | prd-admin | 教程入口呼吸灯常驻:每个页面的「本页教程」入口持续呼吸(新人强脉冲/老人柔和呼吸),让用户随时知道教程存在 |
| fix | prd-admin | 首页(登录落地页)不再自动弹出教程抽屉,只展示通知;首页若有专属教程仍走 Spotlight 自动开讲 |
| fix | prd-admin | 教程抽屉严格按页过滤:当前页绝不展示其他页面的教程(page-guide 及带导览的小技巧只在匹配路由显示,定向私信/纯公告不受限) |
| fix | prd-admin | 重设计右下角通知卡片:左侧等级色条 + 图标徽章 + 两段式底部操作(批量行/单条行),修复按钮换行错乱 |
| feat | prd-admin | 通知新增「免打扰」防打扰机制:可暂停 1 小时/4 小时/今天剩余时间,期间通知不自动弹出只留安静铃铛,点击即恢复 |
| fix | prd-admin | 通知卡固定贴右下角(bottom:20):删除为已移除的「教程小书」预留底距的遗留逻辑(notifCardBottom/FLOATING_DOCK_HEIGHT_EVENT),修复通知卡停在半空中而非真正右下角 |
| fix | prd-admin | 免打扰到期后通知卡自动恢复:snooze 不再置 toastCollapsed,避免免打扰窗口结束后卡片永久收起(Bugbot) |
| fix | prd-admin | matchPageGuide 与抽屉过滤统一 strip query/hash:防止带 query 的 actionUrl 在抽屉显示却不触发 Spotlight/脉冲(Bugbot) |
| fix | prd-admin | 教程抽屉自动展开 effect 把 location.pathname 纳入 deps:修复首页守卫导致导航后 effect 不再触发、整 session 不再自动弹的问题(Bugbot) |
| fix | prd-admin | 教程抽屉 editor 分支也 strip query/hash:与 matchPageGuide/非 editor 分支统一口径,防带 query 的编辑器教程出现「Spotlight 触发但抽屉看不到」漂移(Bugbot) |
