| feat | prd-admin | 三个首页（未登录官网 / 桌面首页 / 移动首页）统一到「米多墨系」：暖石墨 + 暖纸双主题、赭红身份色、八色墨带（陶土/焦糖/琥珀/橄榄/松绿/黛青/钢青/钢蓝），紫 / 靛 / 品红全面退出 |
| feat | prd-admin | 桌面首页密度重做：门头压成两行（日期条 + 问候与提示同排）、命令条 44px、常去入口改实体小瓦片、目录瓦片一行六个；结构改由实体面板承担，去掉贯通全宽的装饰横线 |
| feat | prd-admin | 桌面首页新增「近 7 日 + 我的动态」工作带，与移动首页共用 `lib/homePulse` 同一份真实数据，两端数字不会打架 |
| feat | prd-admin | 新增 `inkPalette` 守卫测试：受管首页与色板出现紫/靛/品红色相（含 rgb()、Tailwind 紫系类）直接 CI 红 |
| refactor | prd-admin | `lib/tileAccent` 色带收敛为 `INK_HUES` 八色相并降饱和；`lib/agentAccent`、`lib/appStoreTokens` 的移动端色板同源换笔 |
| refactor | prd-admin | `formatCompactNumber` 收敛到 `lib/homePulse` 单一实现，移动端改为转出 |
| style | prd-admin | 主题 token 去靛：`--accent-primary`、按钮主色、选择态、聚焦环、门头氛围光、移动 FAB 全部换成赭红家族（暗浅双主题同一支笔） |
| style | prd-admin | 未登录官网底色由冷黑 `#030306` 转为暖石墨 `#0E0C0A`，Logo、CTA、光晕、假素材缩略图同步转暖 |
| polish | prd-admin | 移动首页密度微调：区块间距 24→18、组标题 20→17、卡片圆角 16→12，与桌面同一套刻度 |
| refactor | prd-admin | 首页上层重做为「状态栏 + 台面」：容器从四个（问候区/搜索框/瓦片行/三面板）收敛到一个，近 7 日降级为命令条右侧的数字条，常去入口降级为台面内无框文字链 |
| polish | prd-admin | 在办工作改单行条目（收件箱节奏），类别色只留图标芯片；智能体名/状态/时间三列右对齐成栏，与「我的动态」等高对齐，台面底边齐平 |
| fix | prd-admin | 修掉工作带左栏下方的空白：收起态由 8 条改 12 条（两栏等高），超出部分走「全部 N」展开 |
| polish | prd-admin | 清晰度专项：首页字号一律取整（1x 屏上分数 px 会让字形发虚）、去掉标题/副标题的文字投影、小字提权重与对比、门头氛围雾再压一档、台面描边改 border-default |
| polish | prd-admin | 卡片插画对比度上调（`--media-art-filter` 暗 contrast 1.05→1.18 / 浅 1.10→1.20，暗色不再压暗到 0.88 透明度），200px 缩略图下细节不再糊 |
| feat | prd-admin | 智能体分三档回答「我该点哪个」：你常用的（agentSwitcherStore 真实打开次数，未达门槛整档不出现）/ 官方精选（编辑部口径，如实标注不是算法排名）/ 更多智能体 |
| feat | prd-admin | 「手边的活儿」默认只露一半（6 条），列底部居中「更多 N 条」就地展开，不跳页 |
