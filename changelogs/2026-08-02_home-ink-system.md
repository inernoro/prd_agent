| feat | prd-admin | 三个首页（未登录官网 / 桌面首页 / 移动首页）统一到「米多墨系」：暖石墨 + 暖纸双主题、赭红身份色、八色墨带（陶土/焦糖/琥珀/橄榄/松绿/黛青/钢青/钢蓝），紫 / 靛 / 品红全面退出 |
| feat | prd-admin | 桌面首页重做为「工位」：上层收敛为无框状态栏（时钟 + 日期 + 教程等级）+ 一块台面，命令条与近 7 日数字同排，常去入口为台面内无框文字链，在办工作与我的动态并列成两栏行式列表 |
| feat | prd-admin | 首页命令条：斜杠键聚焦、回车打开首个结果、Esc 清空、输入时实时显示命中数（原 kbd 标 ⌘K 但那是全局智能体浮层，名不副实） |
| feat | prd-admin | 「手边的活儿」默认只露 6 条，列底部居中「更多 N 条」就地展开，不跳页；无在办工作时给一行引导而非空盒 |
| feat | prd-admin | 首页目录合并为「全部能力」一片 + 全部/智能体/工具/底座分段筛选器，默认仍展示全部三组；智能体再分三档：你常用的（真实打开次数，未达门槛整档不出现）/ 官方精选（编辑部口径，如实标注不是算法排名）/ 更多智能体 |
| feat | prd-admin | 桌面首页新增「近 7 日 + 我的动态」，与移动首页共用 `lib/homePulse` 同一份真实数据，两端数字不会打架 |
| feat | prd-admin | 新增 `lib/isoWeek.ts`（ISO 8601 周序 SSOT）供首页日期条使用，含跨年归属单测 |
| feat | prd-admin | 新增 `inkPalette` 守卫测试：受管首页与色板出现紫/靛/品红色相（hex / rgb() / hsl() / Tailwind 紫系类）直接 CI 红 |
| refactor | prd-admin | `lib/tileAccent` 色带收敛为 `INK_HUES` 八色相并降饱和，新增 `Accent.text`（明度随主题 65%/36%）修类别色文字在浅色纸面发虚；`lib/agentAccent`、`lib/appStoreTokens` 的移动端色板同源换笔 |
| refactor | prd-admin | `formatCompactNumber` 收敛到 `lib/homePulse` 单一实现，移动端改为转出 |
| refactor | prd-admin | 首页跳转收成唯一出口 `openRoute`，带入口信息的调用自动记打开次数——记账点漏一个，那条路径的启动就永远不计入「你常用的」 |
| fix | prd-admin | 首页点击补记打开次数：此前只有命令面板（⌘K）记账，瓦片点击与在办工作条都不算数，「你常用的」对只用首页的人永远不出现 |
| fix | prd-admin | 主按钮对比度：暗色改「亮一档陶土底 + 深墨字」5.49:1（原白字 3.74:1 不达标），浅色 hover 由压暗改提亮 5.98:1（原 4.18:1）；themeSystem 契约扩到暗浅双向 + hover 态 |
| style | prd-admin | 主题 token 去靛：`--accent-primary`、按钮主色、选择态、聚焦环、门头氛围光、移动 FAB 全部换成赭红家族（暗浅双主题同一支笔） |
| style | prd-admin | 未登录官网底色由冷黑 `#030306` 转为暖石墨 `#0E0C0A`，Logo、CTA、光晕、假素材缩略图同步转暖 |
| polish | prd-admin | 清晰度专项：首页字号一律取整（1x 屏上分数 px 会让字形发虚）、去掉标题/副标题的文字投影、小字提权重与对比、门头氛围雾再压一档、台面描边改 border-default |
| polish | prd-admin | 卡片插画对比度上调（`--media-art-filter` 暗 contrast 1.05→1.18 / 浅 1.10→1.20，暗色不再压暗到 0.88 透明度），200px 缩略图下细节不再糊 |
| polish | prd-admin | 移动首页密度微调：区块间距 24→18、组标题 20→17、卡片圆角 16→12，与桌面同一套刻度 |
