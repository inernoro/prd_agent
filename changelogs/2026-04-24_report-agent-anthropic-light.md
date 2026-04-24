| feat | prd-admin | 周报 Agent 浅色模式全面 Anthropic 化：引入 Claude 橙 `#CC785C` accent + Source Serif 4 衬线标题 + 全局文字色加深到 slate-900（对比度从 2.5:1 提升至 7:1） |
| refactor | prd-admin | ReportMainView/MyReportsList/HistoryTrendsPanel 状态 chip & 进度条硬编码 rgba 迁移到 `getSemantic()`，解决草稿/未开始等 chip 文字 alpha 0.5 导致的"发虚"问题 |
| feat | prd-admin | 周报详情页/编辑器/侧栏/Markdown 渲染器的标题字号提升 + 应用衬线字体，具备编辑性气质 |
| refactor | prd-admin | 周报浅色模式精修二轮：章节 header 去大色块（纯白 + 3px 左侧色条 + hairline），AI 生成 banner 去紫色面板改单竖线，必填标签改单字符 `*`，编号徽章改 slate-900 单色数字，项目符号改深色 |
| feat | prd-admin | 周报卡片按完成率三色分级（完成=moss 柔绿 / 进行=amber 琥珀 / 未填=slate 灰），进度条 100% 改柔和墨绿 `#5A8F5E`，卡片团队名提到 20px serif 并新增 eyebrow status tag 位于标题上方 |
| feat | prd-admin | 全部/本周/上周筛选改 segmented control 风（单轨道 + 白 thumb + hairline）；TabBar 浅色下选中态 thumb 改实色白面板替代透明玻璃，解决米底上看不见的问题 |
| refactor | prd-admin | 浅色模式底色从 `#f1ece5` 改 Anthropic 官方暖白 `#FAF9F5` — 降饱和 13%→3% + 提亮 92%→97%，解决"底色太黄"问题；同步轻化 shadow + hairline，避免黑框感 |
