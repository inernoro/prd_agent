| fix | prd-admin | 侧栏头像真正贴到底：移除 globals.css 里为「左下角 CDS 徽章」留的 52px 底部空位——CDS widget 桌面端早已改锚右侧安全区，这段留白只是把头像顶高了 52px |
| feat | prd-admin | 皮肤切换从侧栏挪进用户菜单，改为横排三选项：白天（太阳）/ 黑夜（月亮）/ 随系统（电脑），点选不关菜单，当场看到整屏换肤 |
| feat | prd-admin | 外观偏好新增「随系统」：跟随 prefers-color-scheme，选中后系统深浅一变页面实时跟着变 |
| refactor | prd-admin | 新增 themeModeRegistry 作为外观选项唯一数据源（标签/描述/图标），侧栏用户菜单、设置-皮肤设置、周报工具条三处改为消费它，不再各写一份 OPTIONS |
| fix | prd-admin | 加「随系统」的涟漪修复：移动端首页皮肤与分享阅读页主题钮原先直接拿偏好比 'dark'/'light'，选随系统时永远判 false（DOM 已暗、组件按浅色渲染）；新增 useResolvedThemeMode 统一取解析后的明暗 |
| test | prd-admin | 新增 themeModeRegistry 守卫（11 例）：三选项顺序与图标装配、system 双向解析、三处入口都走注册表、落 DOM 前先 resolve、两处涟漪点不许再比较偏好；cdsCompatibility 守卫改为盯 CDS widget 的右锚判据。均跑过红绿闭环 |
