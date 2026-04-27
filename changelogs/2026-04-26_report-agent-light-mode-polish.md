| fix | prd-admin | 浅色 --bg-card 从 rgba(26,26,31,0.05)(米底上视觉差 < 4% L,卡片"浮"不起来)改为纯白 #FFFFFF + hairline 描边,Anthropic Claude.ai 同款层级处理 |
| fix | prd-admin | 浅色 shadow 全栈替换为暖色调 rgba(89,65,50,X) 咖啡棕系 — 米底 #FAF9F5 配冷色调 rgba(15,23,42,X) 阴影色相不和。新增 --shadow-card-sm/--shadow-card-active token,8 处 inline shadow 收口到 token |
| fix | prd-admin | 状态 chip eyebrow 排版收紧 — 字号 10px → 9px,tracking 0.04em → 0.08em,font-medium → font-semibold,删除浅色 1px border(顶级做法只用 bg + color,不叠 border 制造视觉噪音) |
| fix | prd-admin | 浅色模式禁用所有非 modal 的 backdrop-filter blur(12px) — 米底上 blur 无意义反耗渲染。MyReportsList/HistoryTrendsPanel(MetricCard)/PersonalSourcesPanel/TemplateManager 4 处卡片改纯白 + hairline,只有 modal overlay 保留 blur(4px) |
| fix | prd-admin | 进度条配色克制化 — 进行中从 Claude 橙 / 蓝改为 rgba(15,23,42,0.32) slate hairline,只在 100% 时上 sage 完成色。避免"未完成 = 警告"误读,Linear/Notion 同款 |
| feat | prd-admin | TeamDashboard / TemplateManager 4 处大字号标题统一上 var(--font-serif) + letter-spacing -0.01em,与 ReportDetailPanel/ReportMainView 已有 serif 标题保持一致,editorial 风更纯粹 |
