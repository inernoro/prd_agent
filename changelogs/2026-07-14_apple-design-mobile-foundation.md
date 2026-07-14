| refactor | prd-admin | 移动端 App Store 设计系统底座双皮肤修复:appStore.tsx(AppStoreHero/Pill/ShelfCard/轮播小点)与 MobileBottomSheet 从直接 import AS_COLOR 改走 useAppStoreColors,浅色主题不再白底浮暗卡(治全站"更多"弹层 OverflowMenu 浅色破皮) |
| docs | prd-admin | 新增 doc/plan.frontend.apple-design-migration.md:Apple 设计双轨迁移活状态看板(手机端重构 + PC 端底座统一) |
| feat | prd-admin | appStore 组件集新增 4 个原语:AppStoreGrid(智能体宫格)/AppStoreChips(分类横滑)/AppStoreResumeCard(继续上次)/AppStoreTipCard(每日小技巧),配套 token gridIconSize/gridGap/chipHeight |
| fix | prd-admin | MobileAssetsPage 接入 useAppStoreColors 双皮肤,消除整页硬编码 rgba(255,255,255,x)(白底浮暗卡),类型徽章改走 iOS 系统色;themeHardcodeBaseline 相应下调锁定清偿 |
| feat | prd-admin | MobileHomePage 从自研工作台/夜光皮肤整体重构为 App Store Today 加厚版(今日大标题 + 继续上次 + 今日精选轮播 + 常用应用宫格 + 近7日数据 + 每日小技巧 + 我的动态 + 推荐智能体货架 + 沉淀与档案),全接入 useAppStoreColors 双皮肤 + AS_* token,硬编码清零 |
| fix | prd-admin | MobileHomePage 今日精选大卡从 3:4 竖版海报改 16:11 横版(智能体卡无铺满图时 3:4 中间大片空、观感奇怪);AppStoreFeaturedCarousel/AppStoreFeatured 新增可选 aspect 参数(默认 3:4 不影响其他调用) |
| fix | prd-admin | 浅色主题内容卡从 surface(浅灰叠浅灰、糊在背景里)改用新增 AS_COLOR.card token(浅=纯白 #fff / 暗=悬浮灰 #1C1C1E),恢复 iOS grouped 清爽白卡;AppStoreResumeCard/TipCard/ShelfCard、首页近7日/动态/档案卡、MobileAssetsPage 卡片统一改 C.card |
| fix | prd-admin | AppStoreAppIcon 圆角从固定 12px 改按尺寸等比(iOS superellipse ≈22.4%),避免大尺寸图标显方 |
| feat | prd-admin | AppStoreAppIcon 实装 iOS squircle 连续圆角(SVG mask 超椭圆 n=4.5 + filter:drop-shadow 令阴影跟随形状),取代 CSS 圆弧圆角,更接近苹果 app icon;border-radius 保留作 mask 不支持兜底 |
