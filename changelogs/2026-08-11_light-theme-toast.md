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
| fix | prd-admin | 清空全站对比度审计剩余命中（82 → 0）：本轮覆盖 arena / pr-review / pa-agent / library / visual-agent / speech-agent / tapd-bug / shortcuts / my-assets 等 24 条路由 |
| fix | prd-admin | 新增 --accent-primary-solid 与配套 --accent-on-solid：品牌色 --accent-primary 暗色档 #D97757 配白字只有 3.12:1，凡「实心填充 + 白字」改走 solid 档（暗 #B0523A / 浅 #A64B35，5.0~5.7:1）。已接 chat 新建会话、SpaceBar 空间切换、快捷指令三处按钮 |
| fix | prd-admin | 修复 ShortcutsPage 引用了从未定义过的幽灵 token var(--accent)：三个实心按钮实际没有底色，白字直接压米白页面 1.2:1。全部改指 --accent-primary(-solid) |
| fix | prd-admin | 修复共享 Badge 的 success/danger/warning 三档字色写死 500 档，落在同色 12% 淡底上（浅色主题 1.74:1）：统一改走双写的 --accent-fg-*，同一枚徽章出现在多少页就修好多少页 |
| fix | prd-admin | 修复 pa-agent 顶栏文字直接压在 7s/9s 呼吸渐变上：底色亮度随动画在 (153,192,253)~(129,127,166) 之间摆，对比度不确定。顶栏改铺不带呼吸层的 --pa-bg-base 并抬到渐变之上 |
| fix | prd-admin | 修复 library 落地页（固定浅色画布）三处品牌色对比不足：#16A34A→#15803D、#F97316→#C2410C、#64748B→#475569，四个 library 页面同步保持配色一致 |
| fix | prd-admin | 修复 visual-agent 低 alpha 前景（rgba(199,210,254,.42~.55) / rgba(255,255,255,.35~.45)）与 SizePickerPanel 尺寸按钮，统一走 --text-muted 与 --accent-fg-violet |
| fix | prd-admin | 修复 speech-agent 白字压 violet-500/90 按钮（3.67:1）：主按钮提到 violet-600；同页 violet-100/emerald-300 等为暗底设计的浅色前景改走 token |
| fix | prd-admin | 剥掉 30 处 text-[color:var(--accent-fg-*)]/NN 的 alpha 后缀：浅色档已是 700/800 实色，再叠 70~80% 会把对比度拉回阈值以下 |
| fix | prd-admin | 修复知识库宇宙图左下操作提示裸 #555 压在星云画布上（1.0:1）：改为 --overlay-panel-solid 不透明浮层 + --text-secondary（半透明档不行，canvas 上 backdrop-filter 救不回来） |
| fix | prd-admin | 其余单点修复：automations 新建按钮、email-agent 分类 chip 与图标、infra-services / learning-center / report-agent / tech-doc-format-agent / project-route-agent 的浅色前景、task-tree 主按钮 #7c5cff→#6d3fe8、marketplace 分隔点用边框 token 当字色、DesktopAssetsPage 四枚统计图标、tapd-bug 必填红与告警琥珀 |
| test | e2e | 对比度审计补 WCAG 1.4.3 Incidental 例外：失效控件（disabled / aria-disabled，含祖先）不计入。此前空数据页上 disabled:opacity-40 的按钮被反复报成缺陷（/arena 发送 1.78:1，但它本来就点不动） |
| test | e2e | 对比度审计重采样改取元素框内众数色，不再单点采正中：隐前景那步偶尔被 React 重渲染抹掉，正中恰好压着字形就采到文字色本身，报出 fg===bg、比值 1.00 的假阳性（/pa-agent 的 A- 按钮） |
| test | prd-admin | 新增「同色调淡底 + 同色调浅字」源码棘轮 sameHueTintRatchet：底铺 rgba(某色,0.1~0.2)、字却写死同色 300/400/500 档，暗色成立、浅色下两层一起被暖纸底稀释 → 1.4~2.1:1。全仓扫出 553 处 / 158 个文件，正是用户「翻一页坏一页」的病根 |
| fix | prd-admin | 按上述判据清扫 553 → 10：底一律不动，前景统一改走双写的 --accent-fg-*。覆盖 marketplaceTypes 的 CONFIG_TYPE_REGISTRY、theme.ts 的 ACCENT_STYLES、difficultyMeta、defect/report/product/pr-review 等 130+ 文件 |
| fix | prd-admin | 修复 difficultyMeta 三档（学习中心与教程抽屉共用）：初级 1.56:1 / 中级 1.42:1 / 高级 2.06:1 → 5.5~5.9:1；同页「已学会」chip 与进度环底槽（白 10% 描边在暖纸上完全隐形）一并修 |
| fix | prd-admin | 补 .surface-tone-dark 的 --accent-fg-* 全族：钉死暗画布的页面此前拿不到暗色档语义前景，把浅色前景 token 化会反向变成深字压深底 |
| fix | prd-admin | 修复浅色档液态玻璃「发虚」：--glass-bg-end 相对亮度 0.8263 与页面底 #EEEAE3 的 0.8257 只差 0.0006，卡片下半截等于溶进背景、没有边界。整条渐变抬到页面底之上（收尾留 ΔL≈0.072），边框 14% → 18% |
| test | prd-admin | 修 themeSystem 一条反向锁死 bug 的断言：原来逐字要求 ACCENT_STYLES.text 必须是 rgba 字面量——而那正是「淡底压浅字」的错误实现，谁修 bug 谁 CI 红。改为断言必须走 var(--accent-fg-*) |
| test | e2e | 对比度审计判据补两处：失效控件按 WCAG 1.4.3 Incidental 例外不计；渐变底重采样改取元素框内众数色，不再单点采正中（隐前景偶被 React 重渲染抹掉，正中压着字形就采到文字色，报 fg===bg 的 1.00 假阳性） |
