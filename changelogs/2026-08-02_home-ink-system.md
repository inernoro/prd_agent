| feat | prd-admin | 三个首页（未登录官网 / 桌面首页 / 移动首页）统一到「米多墨系」：暖石墨 + 暖纸双主题、赭红身份色、八色墨带（陶土/焦糖/琥珀/橄榄/松绿/黛青/钢青/钢蓝），紫 / 靛 / 品红全面退出 |
| feat | prd-admin | 桌面首页密度重做：门头压成两行（日期条 + 问候与提示同排）、命令条 44px、常去入口改实体小瓦片、目录瓦片一行六个；结构改由实体面板承担，去掉贯通全宽的装饰横线 |
| feat | prd-admin | 桌面首页新增「近 7 日 + 我的动态」工作带，与移动首页共用 `lib/homePulse` 同一份真实数据，两端数字不会打架 |
| feat | prd-admin | 新增 `inkPalette` 守卫测试：受管首页与色板出现紫/靛/品红色相（含 rgb()、Tailwind 紫系类）直接 CI 红 |
| refactor | prd-admin | `lib/tileAccent` 色带收敛为 `INK_HUES` 八色相并降饱和；`lib/agentAccent`、`lib/appStoreTokens` 的移动端色板同源换笔 |
| refactor | prd-admin | `formatCompactNumber` 收敛到 `lib/homePulse` 单一实现，移动端改为转出 |
| style | prd-admin | 主题 token 去靛：`--accent-primary`、按钮主色、选择态、聚焦环、门头氛围光、移动 FAB 全部换成赭红家族（暗浅双主题同一支笔） |
| style | prd-admin | 未登录官网底色由冷黑 `#030306` 转为暖石墨 `#0E0C0A`，Logo、CTA、光晕、假素材缩略图同步转暖 |
| polish | prd-admin | 移动首页密度微调：区块间距 24→18、组标题 20→17、卡片圆角 16→12，与桌面同一套刻度 |
