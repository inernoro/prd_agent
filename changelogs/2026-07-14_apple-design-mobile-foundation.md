| refactor | prd-admin | 移动端 App Store 设计系统底座双皮肤修复:appStore.tsx(AppStoreHero/Pill/ShelfCard/轮播小点)与 MobileBottomSheet 从直接 import AS_COLOR 改走 useAppStoreColors,浅色主题不再白底浮暗卡(治全站"更多"弹层 OverflowMenu 浅色破皮) |
| docs | prd-admin | 新增 doc/plan.frontend.apple-design-migration.md:Apple 设计双轨迁移活状态看板(手机端重构 + PC 端底座统一) |
| feat | prd-admin | appStore 组件集新增 4 个原语:AppStoreGrid(智能体宫格)/AppStoreChips(分类横滑)/AppStoreResumeCard(继续上次)/AppStoreTipCard(每日小技巧),配套 token gridIconSize/gridGap/chipHeight |
| fix | prd-admin | MobileAssetsPage 接入 useAppStoreColors 双皮肤,消除整页硬编码 rgba(255,255,255,x)(白底浮暗卡),类型徽章改走 iOS 系统色;themeHardcodeBaseline 相应下调锁定清偿 |
| feat | prd-admin | MobileHomePage 从自研工作台/夜光皮肤整体重构为 App Store Today 加厚版(今日大标题 + 继续上次 + 今日精选轮播 + 常用应用宫格 + 近7日数据 + 每日小技巧 + 我的动态 + 推荐智能体货架 + 沉淀与档案),全接入 useAppStoreColors 双皮肤 + AS_* token,硬编码清零 |
| fix | prd-admin | MobileHomePage 今日精选大卡从 3:4 竖版海报改 16:11 横版(智能体卡无铺满图时 3:4 中间大片空、观感奇怪);AppStoreFeaturedCarousel/AppStoreFeatured 新增可选 aspect 参数(默认 3:4 不影响其他调用) |
| fix | prd-admin | 浅色主题内容卡从 surface(浅灰叠浅灰、糊在背景里)改用新增 AS_COLOR.card token(浅=纯白 #fff / 暗=悬浮灰 #1C1C1E),恢复 iOS grouped 清爽白卡;AppStoreResumeCard/TipCard/ShelfCard、首页近7日/动态/档案卡、MobileAssetsPage 卡片统一改 C.card |
| fix | prd-admin | AppStoreAppIcon 圆角从固定 12px 改按尺寸等比(iOS superellipse ≈22.4%),避免大尺寸图标显方 |
| feat | prd-admin | AppStoreAppIcon 实装 iOS squircle 连续圆角(SVG mask 超椭圆 n=4.5 + filter:drop-shadow 令阴影跟随形状),取代 CSS 圆弧圆角,更接近苹果 app icon;border-radius 保留作 mask 不支持兜底 |
| fix | prd-admin | MobileTabBar 底座2:激活态从白/黑字+金色下划线改 iOS systemBlue(icon/label/指示条统一走 AS_COLOR.blue),贴近 iOS tab bar;明暗双皮肤对象结构保留不动 |
| fix | prd-admin | MobileProfilePage 接入 App Store 设计系统:纯黑/白卡双皮肤(C.card)、菜单与平台能力配色改 iOS 系统色、角色徽章/退出按钮硬编码色改 AS_COLOR、SF 字体;硬编码清零 |
| fix | prd-admin | MobileNotificationsPage 接入 App Store 设计系统:notificationTone 四档改 iOS 语义色轻底、已处理卡改 C.card、var 令牌改 C.*、SF 字体;硬编码清零 |
| feat | prd-admin | 首页布局从 App Store Today 商店范式改为「摘要」仪表盘(iOS 健康摘要风,用户拍板):去掉页内大标题/日期(AppShell 已有顶栏)、去掉智能体海报大卡与轮播、智能体降级为底部紧凑货架;排序改为 继续上次→常用应用→近7日→动态→档案;近7日改 iOS 彩色大数(无按日序列不编造迷你图);新增 AS_TYPE.groupTitle(20px) 紧凑区块标题档 |
| fix | prd-admin | 首页 demo 差距复盘修复:宫格/档案/继续上次图标从平色(from==to)改回 iOS 双色渐变(接 AGENT_ACCENT SSOT,补 document-store 词条);AppStoreAppIcon 字形比例 0.55→0.48、描边 2→1.9(不再拥挤);近7日 0 值降灰不上鲜艳色;继续上次次要行右侧只留时间(长标题不再被挤没);AppStoreGrid 补 badge 角标,更新中心未读数恢复 |
| feat | prd-api | /api/mobile/stats 新增按日序列 daily(会话/消息/生图/Token 逐日桶,tzOffsetMinutes 按用户本地时区切日界),供首页七日迷你趋势柱 |
| feat | prd-api | /api/home/recent-work 新增诚实进度 progress/progressLabel:仅带状态机的实体给进度(当前为缺陷 draft→closed 十态映射),其余类型 null 不画进度条 |
| feat | prd-admin | 首页近7日卡改健康摘要式 2x2(大数 + 真实七日迷你柱 MiniBars,全 0 显示哑柱不造假);继续上次接 progress 进度条与状态标签;契约 MobileStats.daily/RecentWorkItemDto.progress 同步,getMobileStats 自动携带时区 |
| fix | prd-admin | 首页七日迷你柱重设计:改 Apple 健身/屏幕时间图表范式(每日全高浅轨道 + 底部填充,轨道走 pillBg token 双主题适配,sqrt 缩放让偏态小值可见);修复真实数据下全 0/尖刺分布渲染成"一排丑点"的问题(用真实数据形态本地复现丑态并对比验证后落码) |
