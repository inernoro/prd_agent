| fix | prd-admin | 修复移动端登录后黑屏：新增 MobileSafeBoundary 错误边界（渲染异常不再静默卸载整棵树），MobileHomePage 改用 Promise.allSettled 避免单个 API 失败导致整页空白 |
| fix | prd-admin | AppShell 根容器补 min-height:100dvh，修 iOS Safari 地址栏收缩引发的高度抖动/黑带 |
| fix | prd-admin | 修复 ChangelogBell 窄屏下无限 re-render + 请求风暴：selectRecentEntries 每次返回新数组触发 useSyncExternalStore 循环，改为组件侧 useMemo 派生 |
| feat | prd-admin | 全局 window.error / unhandledrejection 自动捕获到 sessionStorage 环形缓冲，/_dev/mobile-audit 新增诊断视图（自动扫所有路由黑屏/JS 报错，客户端错误面板实时刷新） |
| feat | prd-admin | 新增 mobileCompatibility 注册表 + MobileCompatGate：limited 页顶部黄色 banner 提示受限，pc-only 页中央门槛卡（继续/复制链接），full 页无感知 |