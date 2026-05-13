| fix | prd-admin | 修复左侧 sidebar 菜单数量与「我的导航」设置页数量不一致的问题 |
| fix | prd-admin | navRegistry: /document-store 权限从 access 改为 document-store.read，与后端 Controller 守卫对齐 |
| fix | prd-admin | 导航顺序页：范围切换控件移入「我的导航」标题行，消除标题行上方空白区域 |
| fix | prd-admin | navRegistry: /web-pages 路由守卫回退为仅 web-pages.read，写权限用户无法实际加载页面 |
| fix | prd-admin | 恢复「设置」页面在侧边栏和「可添加」池中的可见性，移除错误的三重隐藏封锁（SIDEBAR_HIDDEN_APPKEYS + launcherCatalog 过滤 + 未入 DEFAULT_NAV_ORDER）|
| fix | prd-api | AdminMenuCatalog: settings 条目标签从「数据运维」更正为「设置」，图标从 Server 改为 Settings |
