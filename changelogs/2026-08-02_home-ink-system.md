| feat | prd-admin | 三个首页（未登录官网 / 桌面首页 / 移动首页）统一到「米多墨系」：暖石墨 + 暖纸双主题、赭红身份色、八色墨带（陶土/焦糖/琥珀/橄榄/松绿/黛青/钢青/钢蓝），紫 / 靛 / 品红全面退出 |
| feat | prd-admin | 桌面首页重做为「工位」：上层收敛为无框状态栏（时钟 + 日期 + 教程等级）+ 一块台面，命令条与近 7 日数字同排，常去入口为台面内无框文字链，在办工作与我的动态并列成两栏行式列表 |
| feat | prd-admin | 首页命令条：斜杠键聚焦、回车打开首个结果、Esc 清空、输入时实时显示命中数（原 kbd 标 ⌘K 但那是全局智能体浮层，名不副实） |
| feat | prd-admin | 「手边的活儿」默认只露 6 条，列底部居中「更多 N 条」就地展开，不跳页；无在办工作时给一行引导而非空盒 |
| feat | prd-admin | 首页目录合并为「全部能力」一片 + 全部/智能体/工具/底座分段筛选器，默认仍展示全部三组；智能体再分三档：你常用的（真实打开次数，未达门槛整档不出现）/ 官方精选（编辑部口径，如实标注不是算法排名）/ 更多智能体 |
| feat | prd-admin | 桌面首页新增「近 7 日 + 我的动态」；移动首页的 `useMobileHomeData` 同时改为复用 `lib/homePulse`（此前它自己又拉了一遍 stats/feed），两端同一个 hook、同一份数据，数字不会打架，失败处理也只需修一处 |
| feat | prd-admin | 新增 `lib/isoWeek.ts`（ISO 8601 周序 SSOT）供首页日期条使用，含跨年归属单测 |
| feat | prd-admin | 新增 `inkPalette` 守卫测试：受管首页、品牌 token（按 token 名圈定，语义色槽除外）出现紫/靛/品红色相（hex / rgb() / hsl() / Tailwind 紫系类）直接 CI 红；另有一条守卫禁止「accent 当底 + 白字」的 3.12:1 组合 |
| refactor | prd-admin | `lib/tileAccent` 色带收敛为 `INK_HUES` 八色相并降饱和，新增 `Accent.text`（明度随主题 65%/36%）修类别色文字在浅色纸面发虚；`lib/agentAccent`、`lib/appStoreTokens` 的移动端色板同源换笔 |
| refactor | prd-admin | `formatCompactNumber` 收敛到 `lib/homePulse` 单一实现，移动端改为转出 |
| refactor | prd-admin | 首页跳转收成唯一出口 `openRoute`，带入口信息的调用自动记打开次数——记账点漏一个，那条路径的启动就永远不计入「你常用的」 |
| fix | prd-admin | 首页点击补记打开次数：此前只有命令面板（⌘K）记账，瓦片点击与在办工作条都不算数，「你常用的」对只用首页的人永远不出现 |
| fix | prd-admin | 9 处主操作面从「`--accent-primary` 当底 + 硬编码白字」（暗色 3.12:1）迁到 `--button-primary-bg/fg` 这对已被守卫钉住的 token |
| fix | prd-admin | 百宝箱两处用户气泡（基础能力 / 快速创建向导）此前是 accent 渐变底 + `--text-primary` 字，暗色只有 2.92:1，同迁到按钮 token 对；渐变里引用的 `--accent-secondary` 全仓从未定义，一并去掉 |
| fix | prd-admin | 色带守卫补两个漏判口子：tokens.css 改按「完整声明」解析（逐行正则会整条跳过 `--home-ambient-background` 这种多行值，往首页氛围光塞紫色照样绿）；「accent 底 + 浅色字」判据改为按括号深度读值 + 按 JSX 开标签配对（原判据读到第一个逗号就断，渐变形态全漏；邻近窗口配对则会把兄弟元素的文字色误报 3 处） |
| fix | prd-admin | 首页「近 7 日 / 我的动态」取数失败此前会渲染成「全零 + 你还没用过」——等于当着老用户面说他什么都没干过。两路各记成败（`resolveHomePulse` 纯函数，reject / `success:false` / `data` 缺失一律算没取到），无数据时显示 `--` 而非 0，动态给「取不到 + 重试」，有旧数据则保留并标注可能不是最新；移动首页同款处理。两个端点各自成败，用量单独挂了也给看得见的说明 + 重试（原来只挂 title，触屏没有悬停等于什么都没说）；留着上一轮列表时也明说「没能刷新，这份是上一次取到的」+ 重试，不默不作声地把过期数据当现状 |
| fix | prd-api | `/api/mobile/feed` 逐来源查库时单个失败原本被静默吞掉、照样返回 200，前端把「两个来源都查挂了」读成「你还没用过」。新增 `degradedSources` 如实报出没取到的来源 |
| fix | prd-api | `/api/mobile/feed` 不再产出 PRD 会话：PRD 解读智能体 Web 端已下线，列出来只是一条点了没反应的条目，还会占掉 limit 名额把真能点的动态挤出这一页 |
| fix | prd-admin | 首页动态流不再列死链：指向已下线路由（`/prd-agent`、`/stats`）的条目在共享 hook 层滤掉，清单与 App.tsx 的重定向路由由守卫对账；**先过滤再截断**，并按 3 倍多取几条补位——否则最新几条恰好都是死链时列表会被清空，页面转头说「你还没用过」 |
| fix | prd-admin | 色带守卫的禁色下限由 244 压到 225：这个 PR 换掉的那批老靛色恰好落在 234-241，判据画在 244 等于把它们原样贴回来照样全绿。门头主标题渐变末端那支色相 233 的长春花蓝同批转暖（换笔前留下的尾巴，最大一块字反倒还是冷的） |
| fix | prd-admin | 首页动态空态原来写「用过知识库、周报、生图或缺陷之后，动态会出现在这里」，但 `/api/mobile/feed` 只查视觉工作区与缺陷——用户照做两件仍是空的。文案改成只承诺端点真会返回的来源，并加守卫从 Controller 解析实际产出类型对账 |
| fix | prd-admin | 移动首页色板（`pages/mobile-home/shared.ts`）漏在守卫外：视觉创作 `#A78BFA`、更新中心 `#F472B6` 一直在移动首页显示，换成陶土 / 黛青，受管范围补上该模块 |
| fix | prd-admin | 官网与 Arena 主 CTA 的品牌渐变对白字只有 2.23~3.62:1，7 处 13-15px 标签迁到深墨字（复用 `--button-primary-fg`，暗浅同值），渐变起点 `#C8623A` 抬到 `#CE6B41` 让最暗那档也过 4.5；守卫逐档算「色标 x 两主题文字色」 |
| chore | prd-admin | 清掉 `surface.css` / `ToolEditor` 里 6 处 `var(--accent-primary-rgb, 99, 102, 241)` 与 `var(--accent-primary, #818cf8)` 的靛色兜底字面量（token 恒有定义，兜底永不生效，但会把紫色抄回来） |
| fix | prd-admin | 主按钮对比度：暗色改「亮一档陶土底 + 深墨字」5.49:1（原白字 3.74:1 不达标），浅色 hover 由压暗改提亮 5.98:1（原 4.18:1）；themeSystem 契约扩到暗浅双向 + hover 态 |
| style | prd-admin | 主题 token 去靛：`--accent-primary`、按钮主色、选择态、聚焦环、门头氛围光、移动 FAB 全部换成赭红家族（暗浅双主题同一支笔） |
| style | prd-admin | 未登录官网底色由冷黑 `#030306` 转为暖石墨 `#0E0C0A`，Logo、CTA、光晕、假素材缩略图同步转暖 |
| polish | prd-admin | 清晰度专项：首页字号一律取整（1x 屏上分数 px 会让字形发虚）、去掉标题/副标题的文字投影、小字提权重与对比、门头氛围雾再压一档、台面描边改 border-default |
| polish | prd-admin | 卡片插画对比度上调（`--media-art-filter` 暗 contrast 1.05→1.18 / 浅 1.10→1.20，暗色不再压暗到 0.88 透明度），200px 缩略图下细节不再糊 |
| polish | prd-admin | 移动首页密度微调：区块间距 24→18、组标题 20→17、卡片圆角 16→12，与桌面同一套刻度 |
