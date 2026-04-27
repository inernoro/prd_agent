| fix | prd-admin | tokens.css 补齐 4 个缺失 token: --bg-primary/secondary/tertiary + --border-primary/secondary,在 :root(暗色) 和 [data-theme="light"] 同时定义。修前周报 Agent 122 处 var(--bg-secondary) 等使用全部 fallback 到 unset/transparent,浅色下面板看起来"灰蒙蒙不通透"——这是浅色 UX 问题最大的根因 |
| fix | prd-admin | DailyLogPolishPopover 移除暗色硬编码 bg-[#0f1014] + border-white/10 + 半透明白叠加,改用 var(--bg-elevated)/var(--border-primary)/var(--bg-secondary);model 名 alpha 从 rgba(255,255,255,0.4)(对比度 2.1:1)改为 var(--text-muted) |
| fix | prd-admin | MarkdownImportModal 删除 9 处 var(--xxx, fallback) 中的白色/暗色 fallback,token 缺失时不再走错误兜底色(违反 cds-theme-tokens.md 第 1 条) |
| fix | prd-admin | ReportDetailPage 浅色 bulletClr 从 rgba(15,23,42,0.7)(对比度 3.5:1,不达 WCAG AA)改为 rgba(15,23,42,1) |
| feat | prd-admin | 新增 hooks/useStatusChipConfig.ts —— 周报状态 chip 颜色 SSOT。MyReportsList/ReportMainView/ReportDetailPage/WeekNavRail 4 套各自实现的 statusConfig 统一收口,alpha 从 0.08/0.10/0.12/0.4/0.5 混用收敛到 getSemantic() 规范(浅色 1.0/0.10/0.22 暗色 0.9/0.08/0.15);MyReportsList NotStarted P0 contrast(浅色 alpha 0.5)被该 hook 自动修复 |
| fix | prd-admin | UsageGuideOverlay/ReportDetailPage/DailyLogPanel 共 4 处 hover 用 rgba(255,255,255,0.X) 半透明白(浅底上看不见),改用 var(--bg-secondary) |
