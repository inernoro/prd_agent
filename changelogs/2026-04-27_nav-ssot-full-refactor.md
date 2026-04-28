| refactor | prd-admin | 全改造导航 SSOT：新建 src/app/navRegistry.tsx 集中声明所有用户可见路由 + nav 元数据；App.tsx <Routes> 通过 .map() 渲染 NAV_REGISTRY；launcherCatalog 改为薄派生层。加新 Agent / 页面 = 在一处写一行 entry，路由+导航+Cmd+K 自动同步 |
| feat | prd-admin | 新增 src/app/RouteGuards.tsx 提取 RequireAuth/RequirePermission 守卫，供 navRegistry 和 App.tsx 共享 |
| feat | prd-admin | 新增 src/pages/MyAssetsPage.tsx，把 App.tsx 内联的移动/桌面分流逻辑独立出来 |
| feat | prd-admin | 强化 navCoverage 测试：5 项校验（path 唯一 / shortLabel ≤4 字 / icon 非空 / path 以 / 开头 / App.tsx 字面量路由全部在 ALLOW_LIST 或 registry） |
