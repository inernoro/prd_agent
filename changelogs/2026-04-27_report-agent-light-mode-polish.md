| fix | prd-admin | 修复周报 Agent 浅色模式下硬编码深黑阴影与白色文字对比度问题，弹窗/抽屉/popover 切换为暖咖啡色羽化阴影 |
| feat | prd-admin | 浅色模式按钮系统完整改造：Button 组件接入 useDataTheme，4 个 variant 浅色版（primary 暖橙实色 #CC785C / secondary 纯白卡片+hairline / danger 柔红 / ghost 透明），暗色保持原视觉 |
| fix | prd-admin | 周报 Agent ZoomControl/ThemeControl segment 切换器选中态浅色下走 var(--accent-claude)，替代原硬编码蓝色 rgba(59,130,246,.15) |
| fix | prd-admin | GlassCard 浅色下阴影从 rgba(0,0,0,0.5) 纯黑改为 var(--shadow-card) 暖咖啡微影,移除浅色下无效的白色 inset 高光,纸感更轻盈 |
| refactor | prd-admin | 周报详情页(panel + 独立 page)tab 选中态去除背景填充,从"加粗+背景+下划线"3 层信号收敛为"加粗+下划线"2 层；删除 tab 上无意义的评论数徽章 |
| refactor | prd-admin | 周报独立详情页删除每个 section 标题右侧的彩色短色条,章节色记忆点统一集中到数字徽章上(实色 + 暖色软阴影),与面板版徽章实现对齐 |
| fix | prd-admin | 全局 Dialog 组件浅色适配:不再依赖 glassPanel(themeComputed 性能模式下会用暗色覆盖 --glass-bg-start/end),浅色直接走纯白卡片+暖咖啡羽化阴影+浅灰 modal-overlay;SystemDialog 的 prompt input 浅色下走 var(--bg-input) 替代硬编码 rgba(6,6,7,1) |
