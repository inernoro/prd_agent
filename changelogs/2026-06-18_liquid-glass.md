| feat | prd-admin | 新增液态玻璃三方对照评估页(labs/liquid-glass):现有重模糊做法 vs B清晰棱光 vs A SVG真折射并排对比,供选型 |
| feat | prd-admin | App背景加极淡彩色光晕(.app-aurora,双主题):此前全站接近纯黑平底导致液态玻璃无内容可折射,光晕给玻璃"有活干"的深度,克制不伤正文对比度 |
| fix | prd-admin | 液态玻璃默认开启:DEFAULT_THEME_CONFIG.performanceMode 由 performance 改 quality,此前默认性能模式导致全站GlassCard走实底降级、液态玻璃从不渲染 |
| feat | prd-admin | 液态玻璃改用B方案:全站GlassCard质量模式blur大幅下调(40→14px)+边缘棱光/镜面反光+暗色底色提一档,清晰度优先不靠重模糊 |
| feat | prd-admin | 共享弹窗改液态玻璃:遮罩降不透明度(0.72→0.40)+backdrop模糊让繁忙页面映照出来,面板由实底改半透磨砂玻璃(blur24+棱光镜面),所有走Dialog/prd-dialog-content的弹窗一并升级 |
| feat | prd-admin | 头像菜单新增「液态玻璃」一键开关:点击不关菜单,当场切换全局玻璃开/关(performance↔quality),无需进设置中心皮肤页 |
| polish | prd-admin | 全局 aurora 背景光晕温和加强(暗色 5 团色斑透明度 +~35% 并扩大范围),让半透卡片(--bg-card 白@0.08)与玻璃面板背后透出更明显的淡彩底色;浅色主题不变 |
| fix | prd-admin | 修复 aurora 背景被内容区遮挡:<main> 背景由不透明 var(--bg-base) 改 transparent,让外层 .app-aurora 彩色光晕透到内容区,半透卡片/玻璃面板才能折射到淡彩底色而非平底色(aurora 自身以 var(--bg-base) 收底,floor 色不变) |
| perf | prd-admin | 性能模式下停掉全局 aurora 背景动画并回退 var(--bg-base) 实底,去除全屏大渐变持续重绘的视觉负载(玻璃关闭时无需可折射底色) |
| fix | prd-admin | 液态玻璃性能模式/reduced-motion 边界统一退实底:shouldReduceEffects 纳入 prefers-reduced-motion,与性能模式同路径由 themeApplier 把 --glass-bg 整体切实底并打 data-perf-mode(卡片/弹窗/所有玻璃面统一退实底);头像菜单徽章用 shouldReduceEffects 判定(auto 在 Windows 降级时显示「已关闭」);弹窗面板在两路径下恢复近实底背景 + 遮罩回退 rgba(0,0,0,0.72),避免半透失焦 |
| fix | prd-admin | reduced-motion 反应性闭合:initializeTheme 监听 prefers-reduced-motion 变化重跑 applyThemeToDOM(含老 Safari addListener 回退);新增 useReducedMotion 钩子(useSyncExternalStore),Dialog 遮罩与头像玻璃徽章随 OS 偏好运行中变化即时重渲染,消除滞后 |
| fix | prd-admin | 液态玻璃评估页(labs)对照卡响应式:初始位置按舞台实测宽度铺开,并用 ResizeObserver 在窄屏/缩放时把三张卡夹回可视范围,避免被 overflow:hidden 裁出舞台 |
