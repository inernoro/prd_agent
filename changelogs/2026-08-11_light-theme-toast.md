| fix | prd-admin | 修复浅色主题下 Toast 深底深字不可读：底层改走新增的 --toast-bg-base 主题 token（暗/浅/素色三处双写），不再写死 rgba(8,10,16,0.82) |
| fix | prd-admin | 提高 Toast 底层不透明度（0.82 → 0.94/0.97），修复下层工具栏文字透过提示条的穿透问题 |
| fix | prd-admin | 修复浅色主题下 Toast 语义色图标与动作按钮对比度不足（1.88:1 → 4.10:1）：新增 --toast-accent-* 四色 token，浅色档压到 700 档 |
| fix | prd-admin | 举一反三修同族浮层：TipsDrawer / TipCard 气泡 / ChangelogBell 弹层 / 划词 AI 与批注与配图三浮层 / 批注 sheet / Wikilink 悬浮卡与联想下拉 / DocBrowser 移动抽屉 / 崩溃兜底卡 / 手动触发弹层 统一到新增的 --overlay-panel-bg 与 --overlay-panel-solid |
| fix | prd-admin | 修复 PageHeader tab 凹槽（--tab-container-bg）、Tooltip 箭头、代码块与 Mermaid 源码底色在浅色主题下写死深色 |
| fix | prd-admin | 修复浅色主题下原生 select 仍按暗色方案绘制（米白页面里弹出黑底白字 option 列表） |
| docs | prd-admin | debt.frontend.md 补「浮层/提示层浅色审计」台账：本轮清偿清单 + 17 条显式不做的条目与原因 + 守卫判据剩余缺口 |
| test | prd-admin | 双皮肤硬编码棘轮补三处判据缺口：扫描范围加 .ts（此前只扫 .tsx，导致配色 SSOT glassStyles.ts 从未被扫过）、新增「深色 rgba 当背景」计数、新增 Toast 底层双写接线守卫 |
