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
| fix | prd-admin | Codex review 二轮修复：选「随系统」在 Safari 14 之前的浏览器上直接抛（那些 MediaQueryList 只有 addListener，没有 addEventListener），整档功能用不了；新增 lib/mediaQuerySubscribe 共享订阅带老旧回退，watchSystemThemeChange 改走它 |
| test | prd-admin | 新增 mediaQuerySubscribe 用例（6 例）：现代/老旧/两者皆无/SSR 四种环境的订阅与取消订阅行为，外加「老旧回退不许再抄第五份」棘轮与「随系统不自己 addEventListener」守卫；已跑红绿闭环 |
| test | prd-admin | Codex review 三轮：新增「首屏由 render() 落 pos」接线守卫——原守卫只断言 defaultWidgetLeft 的返回值，删掉 render 里那两行落 inline style 的代码它照样全绿，而徽章会退回 CSS 默认 left:12px 压住贴底头像；顺带修了自己判据里的形状 8（初判据把注释掉的 `// render();` 也当成证据，红绿闭环时不变红才发现，已收紧成只认整行调用） |
| fix | prd-admin | Codex review 四轮：用户菜单里的外观三选项此前是 DropdownMenu.Item + 自己写 role="radio"，子元素 role 覆盖掉 Item 给的 menuitem，菜单里挂出几个裸 radio，屏幕阅读器读到的结构与导航上下文是坏的；改用 Radix 原生 RadioGroup / RadioItem（落 role="group" 与 role="menuitemradio" + aria-checked），选中态由 RadioGroup 的 value 驱动 |
| test | prd-admin | 新增 test-utils/sourceScan 的 stripComments：源码扫描类守卫扫之前先去注释。本 PR 同一个坑连踩三次（addEventListener 误红、注释掉的 render() 被当成调用、role="radio" 命中解释性注释），三次都在打补丁收紧正则；改为在判据前统一去注释，并把二轮/三轮/四轮那三条判据都收到它上面。含 7 例行为用例（行注释/块注释/JSX 注释/字符串与模板串不误伤/转义引号），另加 3 例菜单单选角色守卫；均跑红绿闭环 |
