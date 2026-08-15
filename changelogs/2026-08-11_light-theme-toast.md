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
| fix | prd-admin | 修复知识库分享页「皮肤完全反过来」：星图/双链图是钉死暗底的区域，但区域内的正文走 var(--text-*)，浅色主题下该 token 解析成深藏青 → 深字压近黑面板，实测 1.05:1（标题因为写死浅色所以可见，正文全糊）。给 DocumentGalaxyView / UniverseGraphPage / ReaderPanel 三处根容器标 surface-tone-dark，token 翻回暗色档后正文 17.46:1 |
| fix | prd-admin | 同型镜像缺陷全仓清扫：容器钉死暗底、子树却用 token 取字色的还有 20 个文件 34 处（视觉创作工作台、PA 档案面板、涌现画布、同步中心、模型管理等），逐个标 surface-tone-dark |
| fix | e2e | 远端对比度审计改走 node fetch 代理穿透（复用 CDS 验收技能的 proxyroute），沙箱里终于能对真站点+真实数据跑审计。此前误判「chromium 没有出网」，导致两轮只能靠源码推算 |
| docs | doc | debt.frontend 记下沙箱出网解法与教训：报「做不到」之前先扫仓库现成技能；远端真实数据审计与本地空桩差一个数量级（空桩报 0，真实数据每屏 5~20 处） |
| test | prd-admin | sameHueTintRatchet 判据补三个缺口：认 #hex 字面量（此前只扫 rgba）、认 accent 键（注册表惯用）、新增判据 C 认「一值两用」——同一个变量既被拼成 `${x}22` 淡底又直接当字色。判据 C 是真实规模最大那次事故（144 处）的形状，A/B 对它完全瞎 |
| fix | prd-admin | 修 AppShell notificationTone 与 ChangelogBell TYPE_COLOR_MAP 两处一值两用（36 条路由各一处）：底保持淡色调、字改走双写 token |
| fix | prd-admin | ArenaPage 空态 27 处写死白字改走 token —— 该屏外层无深底，浅色档下就是白字压暖纸（实测 1.01~1.2:1） |
| fix | e2e | 远端审计补渐变重采样（本地版一直有、远端漏了）：元素坐在 radial-gradient 上时 backgroundColor 透明，祖先链会一路取到页面底，把「深色渐变页上的浅字」误报成缺陷。task-tree 整页栽在这上面，照误报改会造新 bug |
| fix | prd-admin | 教程中心承接卡落地方案 A（用户选）：七级帽子拆双皮肤——暗色档保持石墨→暖银的提亮递进，浅色档另配石墨→暖青铜的加深递进（5.3~6.6:1，原来 Lv.3 只有 1.86:1 且越高阶越看不见）；卡片补实底与描边；进度环底槽改走 --nested-block-bg |
| fix | prd-admin | 修 Codex P1：surface-tone-dark 只覆盖半套 token，暗岛内用 var(--bg-elevated) 等 14 个表面 token 时会「近白字压浅暖底」（arena 两个下拉实例，全仓 6 个文件受影响）。补齐 14 个并加守卫，红绿闭环验过 |
| chore | repo | 修 Codex P2：116 个审计截图共 23MB 被误提交入库，git rm --cached 移除；.gitignore 从枚举目录名改成 .audit-*/ 前缀通配，换 AUDIT_OUT 也堵得住 |
| fix | prd-admin | 修 Codex 第二轮 P2：surface-tone-dark 按「真实消费」补齐 41 个 token（上一轮按族名清单只补 14 个，--overlay-panel-solid 以 overlay 开头就漏了）；守卫判据同步从族名清单换成消费关系 |
| feat | prd-admin | 新增 useSurfaceTone：解析元素**所处表面**的明暗而非全局主题。Mermaid 图接上后不再在深色岛里用浅色调色板（原约 1.1:1） |
| fix | e2e | 两个审计脚本补覆盖账本：跳过/报错不再静默吞掉，收尾打印实际覆盖对数、写 coverage.json，未全覆盖以非零码退出 |
| fix | e2e | 修 Codex 第三轮 P1：页内 slice(0,60) 发生在渐变重采样**之前**，候选超 60 的页面尾部真实缺陷被永久丢弃、且前 60 条被重采样纠正后报告会显示 0。改为全量返回，展示上限挪到渲染层并自报省略了多少组 |
| fix | e2e | 修 Codex 第三轮 P2：两个审计脚本改为每主题独立 context。此前在同一 page 上反复 addInitScript，light 那份跑到 dark 时仍常驻、两份都写主题 key 而执行顺序未定义，dark 轮可能整轮被判「主题未生效」跳过 |
| fix | prd-admin | 修 Codex 第四轮 P2：拆 accent/fg 时漏了两个 success 分支——只改 accent 没改 fg，「缺陷已解决」通知底绿字紫。补上并加成对守卫（红绿闭环验过） |
| fix | e2e | 修 Codex 第四轮 P1：渐变底候选在「近似达标」时被提前丢弃，重采样再也看不到它。改为 needsEye 一律留到重采样后再判 —— 这个修复当场挖出一处此前被藏住的真实缺陷 |
| fix | prd-admin | arena 主视觉徽章里的剑图标压在 HERO_GRADIENT 上用了 --text-primary，实测 2.82:1（图标线需 3:1）。改用该渐变配套的 HERO_GRADIENT_FG，复扫归零 |
| fix | e2e | 修 Codex 第五轮三条测量失真：WCAG 大字阈值是磅被当成 CSS 像素用（18.66/14 → 24/18.67），18.66~24px 正文与 14~18.67px 粗体被错误放宽到 3:1；前景未计元素与祖先累计 opacity，opacity-50 的字按全强度算；重采样用视口截图配视口坐标，屏下渐变元素一律采空。三条都导致少报 |
| chore | e2e | 审计排除 CDS 注入的分支徽章（#bt-branch-badge）：平台浮层不在仓库源码里、本 PR 改不了，不排除会让每条路由稳定多报一处、淹没真实回归 |
| fix | e2e | 修 Codex 第六轮 P1（最实质的一条）：路由清单只从 navRegistry 取，漏掉 App.tsx 里的嵌套写法。实测 48 → 80 条，漏的 32 条里就有本 PR 改过的 /skills /weekly-poster /data-transfers /notifications —— 审计一边跳过我改的屏、一边报「覆盖完整」 |
| fix | e2e | 修 Codex 第六轮 P1：pageerror 被静默吞掉，页面崩成错误边界仍算「已覆盖且干净」。改为记账并在跑 AUDIT_FN **之前**判掉（否则错误边界自己的配色会污染报告） |
| chore | doc | 移除 doc/assets 下两张无人引用的对照截图（810 KiB），与本 PR 刚写进 debt 的「扫描产物不入库」自相矛盾 |
| fix | prd-admin | 修 Codex 第七轮 P2：sameHueTintRatchet 的「按主题分支跳过」判据太宽，命中注释与 DOM 属性字符串就跳过整个文件——AppShell 因此被整体排除，而它正是这条守卫为之而建的文件。收紧为「剥注释后仅认 useDataTheme( / isLight 标识符 / [data-theme= 选择器」，11 个文件重回检查范围 |
| fix | prd-admin | 修 Codex 第七轮 P1：我的 token 改造把 --accent-fg-* 放进了钉死暗底的容器，浅色档下深字压深底（ProductGraphCanvas 抽屉实测约 1.9:1）。同型全仓 33 个文件 49 处，逐处补 surface-tone-dark |
| fix | e2e | 修 Codex 第七轮 P1：重采样失败的候选留着不可信的近似比值，被调用方按「达标」丢弃。改为标 unresolved 并把比值压 0，报告里与「实测不达标」分开计数 |
| fix | prd-admin | 修 Codex 第八轮实证的产品缺陷：DailyLogPanel 五处无条件写死的 emerald-500/95 压同色 12% 淡底，浅色档实测 2.0:1（需 4.5），改走 --accent-fg-success 后 5.83:1 |
| docs | doc | PR #1374 触发 AGENTS.md §5.5 熔断（Review 修复提交达 8 个 + 同一判据二次收窄），审计工具剩余三项精度记入 debt.frontend 并说明为何不在本 PR 展开 |
| fix | prd-admin | 修 Codex 第九轮：VisualCreationMiniPanel 面板钉死深底却未标暗岛，错误文案约 2.6:1。底色写在具名 style 对象里，自动扫描按「同一开标签」判定够不着，手工补；同轮 rgba 写法的暗底再扫出 DefectCard 2 处、ReviewAgentDimensionsModal 1 处 |
| fix | prd-admin | 修 Codex 第十轮：--nested-block-bg 此前只在 [data-material="solid"] 与浅色档有值，暗色 + 玻璃材质下整个未定义（学习中心进度环底槽直接消失）。补进 :root 与 .surface-tone-dark 两处兜底 |
| fix | e2e | 修 Codex 第十轮：上一轮的累计 opacity 只接了一半——渐变重采样路径既没记录 fgOpacity 也没参与合成，半透明字在渐变底上仍按全强度算。两端补齐 |
| fix | e2e | 两个审计脚本改为「扫出真实缺陷即非零码退出」，此前只有覆盖不全才失败，带缺陷的扫描会报绿 |
| docs | doc | debt.frontend 的对比度审计段按 AGENTS.md §10 精简为四条未解边界，过程与计数归验收知识库；源码路径收进文末「实现来源」小节 |
| fix | prd-admin | 修 Codex 第十一轮：--accent-fg-* 叠 alpha 后缀的漏网 46 处全部剥掉（此前只剥了 30 处）。这族 token 的两档都是按「实色恰好压过 4.5:1」调的，实测最差档 alpha 0.85 是 4.53、0.8 掉到 4.07、0.7 只有 3.35 |
| test | prd-admin | 新增零容忍守卫：全仓 text-[color:var(--accent-fg-*)]/NN 恒为 0。这个形状被抓两次，靠「记得手动剥干净」不成立（红绿闭环验过） |
| fix | e2e | 修 Codex 第十二轮 P1：审计按「请求的路由」记覆盖，不看落地地址。/login /stats /prd-agent 三条都重定向到首页，于是同一份首页命中被计了三次（同轮各 61 处），凭空给总数灌进约 180 条。改为落地路径与目标不符即记 redirected、不计覆盖、不进报告 |
| fix | e2e | 上条的另一半：`/` 原本被 `p !== '/'` 过滤掉、只靠那三条重定向顺带扫到。只排除重定向会把重复计数换成「全站最重要的一屏零覆盖」，因此同一次把 `/` 显式加回路由清单 |
| fix | e2e | 修 Codex 第十二轮 P1：参数化路由（28 条，含 /review-agent/submissions/:id 等详情页）从来没扫过，而 expected 又是从过滤后的清单算的，「132/160」看着像满覆盖。收尾显式打印未覆盖的参数化路由条数并写进 coverage.json |
| fix | prd-admin | 修 Codex 第十三轮 P2：TipCard 与 TipsDrawer 的 accent 一值两用——底翻成 --overlay-panel-bg（浅色档暖纸）后，为暗底调的 pastel 当图标前景只剩 1.4~1.7:1。拆成装饰色（边框/渐变保留原值）与前景色（走双写 token） |
| fix | prd-admin | 顺带清掉文学配图页 5 处写死的 rgba(52,211,153,0.95) 前景（教程气泡正文、锚点移除按钮、右键菜单两项） |
| fix | e2e | 修 Codex 第十三轮 P1：redirected 上一轮只记账没接进不合格判定。判据不是「有重定向就红」——故意的别名落地页本身在清单里会被独立扫，覆盖没丢；只有「跳到谁也不扫的页面」才是真漏洞，那种才红 |
| fix | e2e | 审计跑到一半掉登录：一轮十几分钟，light 从第 55 条、dark 从第 63 条起全部被弹回 /login，27 对（占 162 的 17%）从没量过。检测到落地 /login 就地重登再重试该路由。实测 /users 上一轮报「2 处」（其实扫的是登录页），修好后是 64 处 |
| fix | e2e | 修上一轮自己的判据漏洞：「落地页在 ROUTES 里就算覆盖没丢」把掉登录也放行了（/login 恰好在清单里）。别名跳转与掉登录是两回事，后者永远算失败 |
| fix | prd-admin | 修 Codex 第十三轮 P2：批注线程计数徽章底是 8 色亮色调色板（两个主题同色），前景却走会翻的 --text-primary，暗色档白字压亮底 1.55~3.98:1。新增 --fg-on-bright-fill（两档同值的深字），8 个色全部 4.07~10.48:1 |
| fix | e2e | 修 Codex 第十五轮 P2：重定向判据拿 location.pathname 跟原始 route 串比，而 AUDIT_ROUTES（覆盖参数化/带 tab 页面的唯一入口）传进来的路径基本都带 query，于是那批页面会被自己的判据全判成重定向跳过。改为 pathname 对 pathname，导航仍用完整串 |
| chore | e2e | 删掉误提交的一次性调试脚本 _probe-local.mjs（写死 /home/user/prd_agent 绝对路径，功能与 theme-contrast-audit-local.mjs 重复，无人引用） |
