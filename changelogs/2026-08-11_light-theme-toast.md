| fix | prd-admin | 修复浅色主题下 Toast 深底深字不可读：底层改走新增的 --toast-bg-base 主题 token（暗/浅/素色三处双写），不再写死 rgba(8,10,16,0.82) |
| fix | prd-admin | 提高 Toast 底层不透明度（0.82 → 0.94/0.97），修复下层工具栏文字透过提示条的穿透问题 |
| fix | prd-admin | 修复浅色主题下 Toast 语义色图标与动作按钮对比度不足（1.88:1 → 4.10:1）：新增 --toast-accent-* 四色 token，浅色档压到 700 档 |
| fix | prd-admin | 举一反三修同族浮层：TipsDrawer / TipCard 气泡 / ChangelogBell 弹层 / 划词 AI 与批注与配图三浮层 / 批注 sheet / Wikilink 悬浮卡与联想下拉 / DocBrowser 移动抽屉 / 崩溃兜底卡 / 手动触发弹层 统一到新增的 --overlay-panel-bg 与 --overlay-panel-solid |
| fix | prd-admin | 修复 PageHeader tab 凹槽（--tab-container-bg）、Tooltip 箭头、代码块与 Mermaid 源码底色在浅色主题下写死深色 |
| fix | prd-admin | 修复浅色主题下原生 select 仍按暗色方案绘制（米白页面里弹出黑底白字 option 列表） |
| docs | prd-admin | debt.frontend.md 补「浮层/提示层浅色审计」台账：本轮清偿清单 + 17 条显式不做的条目与原因 + 守卫判据剩余缺口 |
| test | prd-admin | 双皮肤硬编码棘轮补三处判据缺口：扫描范围加 .ts（此前只扫 .tsx，导致配色 SSOT glassStyles.ts 从未被扫过）、新增「深色 rgba 当背景」计数、新增 Toast 底层双写接线守卫 |
| fix | prd-admin | 修复 Tooltip 气泡与箭头不同源：新增双写 --tooltip-bg/--tooltip-border，气泡不再复用暗色下仅 3% 白的 --glass-bg-end（该值靠 backdrop blur 成形，SVG 箭头吃不到 blur 会消失） |
| fix | prd-admin | 修复验收 fail 的镜像缺陷：底翻成浅色后，浮层内为深底调的浅紫/浅蓝/白系文字消失。45 处写死浅色前景统一到新增的 --accent-fg-* 双写族（原 --toast-accent-* 并入，避免两套名字指同一件事） |
| fix | prd-admin | 修复 Mermaid 图在浅色主题下浅字压浅底：mermaid 主题改为按 data-theme 双套配置并在主题切换时重烘；容器底改走 --nested-block-bg |
| fix | prd-admin | 修复暗色主题下原生 option 弹出白色列表：option 由 Canvas/CanvasText 系统色改为主题 token（弹层由 UA 绘制，Canvas 的解析结果不可控） |
| test | prd-admin | 棘轮补第 4 条判据「写死的浅色前景」（color: 里感知亮度 > 0.5 的字面色）——前三条只盯背景，本次 45 处镜像缺陷一处都没拦住 |
| fix | prd-admin | 清掉三元分支里残留的写死浅色前景（AI 改写 diff 的增删行文字、教程置顶态、评论孤儿态），此前正则只匹配单值 color 漏掉了三元 |
| test | prd-admin | 新增零容忍守卫：10 个翻过底的浮层面板四类硬编码恒为 0（这批浮层验收连续两轮够不到，只能由源码守卫兜底） |
| test | prd-admin | 修守卫三处判据缺陷：declValue 不认 `}` 导致 JSX style 取值越界误报（全仓 lightFg 1851→1611）、var() 兜底色误判（仅当变量在浅色块有定义才豁免）、hex 只认 6 位漏掉 `#fff` |
| docs | prd-admin | debt.frontend.md 收口三轮验收状态：已验收项与三项拿不到视觉证据的浮层分列，写明卡点是程序化选区触发不了指针事件、下次取证必须用真实指针事件，并声明残余风险可接受 |
| test | e2e | 新增全站双主题对比度审计脚本 `e2e/theme-contrast-audit.mjs`（pnpm audit:contrast）：登录后遍历 48 条路由 × 双主题，对实际渲染的文本/图标算真实对比度，按配色聚合出「影响多少条路由」，把浅色缺陷的验收从人工逐屏改为一次扫全站 |
| fix | prd-admin | 修复分支徽章 BranchBadge 对比度不足：0.85 半透明彩底 + #e2e8f0 只有 2.93:1，改为不透明 800 档色 + 白字 7.09:1。该徽章出现在每一屏，全站对比度审计里 364 处命中归零 |
| fix | prd-admin | 修复前端智能体页浅色主题下深字压深底（1.08:1）：页面钉死暗色画布但文字走全局 token，挂 tokens.css 的 surface-tone-dark 让内部 token 整体切暗，该页命中 24 → 10 |
| test | e2e | 对比度审计新增渐变底像素重采样：祖先链取不到 background-color 时（层叠 linear-gradient / 背景图）改从本屏截图真实采样底色重算，此前这类元素一路穿到页面底色，144 处假阳性（含被误测的 Toast 自身） |
