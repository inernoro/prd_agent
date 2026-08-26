| feat | prd-admin | 侧栏底部移除「···」按钮，用户菜单改由点击头像打开；头像因此落到侧栏最底部（同时去掉尾部 1px 占位间距） |
| feat | prd-admin | 头像点击语义改为两段：菜单关着时点头像开用户菜单，菜单开着时再点一次头像才进「修改我的头像」；菜单头部加一行提示让这条交互可见 |
| refactor | prd-admin | 用户菜单改受控（modal={false}）：点击判定落在 pointerdown 并 preventDefault，绕开 Radix Trigger 自带的 toggle；展开态用户名按钮退回普通 toggle 按钮，一个 Root 只保留头像这一个锚点 |
| test | prd-admin | 新增 accountAvatarAction 判定源与守卫用例（4 例）：两段点击语义各一例，另加「AppShell 走唯一判定源」「头像是菜单触发器且侧栏不再有 MoreHorizontal」两条源码守卫，已跑红绿闭环 |
| fix | prd-admin | 侧栏头像真正贴到底：移除 globals.css 里为「左下角 CDS 徽章」留的 52px 底部空位——CDS widget 桌面端早已改锚右侧安全区，这段留白只是把头像顶高了 52px |
| feat | prd-admin | 皮肤切换从侧栏挪进用户菜单，改为横排三选项：白天（太阳）/ 黑夜（月亮）/ 随系统（电脑），点选不关菜单，当场看到整屏换肤 |
| feat | prd-admin | 外观偏好新增「随系统」：跟随 prefers-color-scheme，选中后系统深浅一变页面实时跟着变 |
| refactor | prd-admin | 新增 themeModeRegistry 作为外观选项唯一数据源（标签/描述/图标），侧栏用户菜单、设置-皮肤设置、周报工具条三处改为消费它，不再各写一份 OPTIONS |
| fix | prd-admin | 加「随系统」的涟漪修复：移动端首页皮肤与分享阅读页主题钮原先直接拿偏好比 'dark'/'light'，选随系统时永远判 false（DOM 已暗、组件按浅色渲染）；新增 useResolvedThemeMode 统一取解析后的明暗 |
| test | prd-admin | 新增 themeModeRegistry 守卫（11 例）：三选项顺序与图标装配、system 双向解析、三处入口都走注册表、落 DOM 前先 resolve、两处涟漪点不许再比较偏好；cdsCompatibility 守卫改为盯 CDS widget 的右锚判据。均跑过红绿闭环 |
| fix | prd-admin | Codex review 修复：AppShell 之外的独立全屏页（分享阅读页 / 数据同步授权页 / 回调页）选「随系统」后系统切深浅，DOM 不会重新落主题——各自的 effect 只把偏好放进 deps，而 'system' 下偏好不变；新增 useApplyDocumentTheme 共享 hook 把解析后的明暗一并放进 deps，三页统一改用它 |
| fix | prd-admin | Codex review 修复：展开态用户名按钮从 DropdownMenu.Trigger 退回普通 button 后丢了键盘激活（Enter/Space 不发 pointerdown），对键盘用户是死的；补 isMenuKeyboardActivation + onKeyDown |
| refactor | prd-admin | AppShell 删掉自己那份 matchMedia 监听，改为把 useResolvedThemeMode 放进既有 effect 的 deps——「订阅系统深浅」只保留 hook 里这一份实现 |
| test | prd-admin | 新增 4 条守卫：applyDocumentThemeMode 只许在共享 hook 与壳层里调用（防下一个独立页再抄错）、三页都走 hook、hook 与壳层的 deps 都含解析值、用户名按钮 pointer+keyboard 双通道；均跑过红绿闭环 |
