| refactor | prd-admin | 移动端 App Store 设计系统底座双皮肤修复:appStore.tsx(AppStoreHero/Pill/ShelfCard/轮播小点)与 MobileBottomSheet 从直接 import AS_COLOR 改走 useAppStoreColors,浅色主题不再白底浮暗卡(治全站"更多"弹层 OverflowMenu 浅色破皮) |
| docs | prd-admin | 新增 doc/plan.frontend.apple-design-migration.md:Apple 设计双轨迁移活状态看板(手机端重构 + PC 端底座统一) |
| feat | prd-admin | appStore 组件集新增 4 个原语:AppStoreGrid(智能体宫格)/AppStoreChips(分类横滑)/AppStoreResumeCard(继续上次)/AppStoreTipCard(每日小技巧),配套 token gridIconSize/gridGap/chipHeight |
| fix | prd-admin | MobileAssetsPage 接入 useAppStoreColors 双皮肤,消除整页硬编码 rgba(255,255,255,x)(白底浮暗卡),类型徽章改走 iOS 系统色;themeHardcodeBaseline 相应下调锁定清偿 |
| feat | prd-admin | MobileHomePage 从自研工作台/夜光皮肤整体重构为 App Store Today 加厚版(今日大标题 + 继续上次 + 今日精选轮播 + 常用应用宫格 + 近7日数据 + 每日小技巧 + 我的动态 + 推荐智能体货架 + 沉淀与档案),全接入 useAppStoreColors 双皮肤 + AS_* token,硬编码清零 |
