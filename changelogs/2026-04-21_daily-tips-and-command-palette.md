| feat | prd-api | 新增每日小贴士(DailyTip)后端:Model + 两个 Controller(用户侧 `/api/daily-tips/visible` + 管理侧 `/api/admin/daily-tips` 增删改查),Controller 内置 fallback 种子,DB 空时兜底 8 条内置 tips;缺陷闭环桥接:缺陷被修复时自动生成定向 tip 推送给原始提报人 |
| feat | prd-admin | 新增每日小贴士前端:右上角 `TipsDrawer` 悬浮铃铛 + 定向 tip 徽章 + session 维度关闭,首页副标题 `TipsRotator` 轮播,跳转后 `SpotlightOverlay` 在目标 DOM 上播放脉冲光圈(via `data-tour-id`) |
| feat | prd-admin | 新增全局命令面板(⌘/Ctrl + K):统一搜索智能体 + 后端菜单目录 + 快捷操作(首页/百宝箱/设置/更新中心),键盘上下导航 Enter 进入,`createPortal` 渲染遵守 frontend-modal 3 硬约束 |
| feat | prd-admin | 设置页新增「小技巧」Tab:管理员 CRUD 表单(文本/卡片/聚光灯三种类型),显示来源(manual/seed/defect-auto),支持定向到特定用户 |
| fix | prd-admin | 超宽屏 4 个快捷链接卡过大问题:限制单卡最大宽度,避免 1920+ 显示器下横向铺满 |
| feat | prd-admin | 新增可复用 DOM 标记 `data-tour-id`:首页副标题/搜索框/4 个快捷入口,供 tip spotlight 系统定位 |
