# MAP 管理后台框架（prd-admin）

适用：MAP 平台在 prd-admin 里的页面与智能体。原型由 prd-admin 正式代码构建（cds-design/prototype-build），壳、组件和令牌都取自正式源码。

| R-01 | 页面挂在正式 AppShell（src/layouts/AppShell.tsx），左侧导航来自服务端菜单目录（AdminMenuCatalog），不另画导航 | 自动：原型 DOM 含 AppShell 的侧栏与主区，页面在主区 Outlet 内渲染 |
| R-02 | 颜色只取 src/styles/tokens.css 的语义变量（--bg-*、--text-*、--border-*、--accent-*、--panel-solid、--nested-block-bg），页面组件不写死十六进制；作品本身的画面配色（例如视频模板帧）不受此限，但要与界面隔离在一个组件内 | 自动：页面源码（不含模板画面组件）扫描十六进制与 rgb 字面量为 0 |
| R-03 | 白天（data-theme=light）与黑天（dark）都可读，正文对比度不低于 4.5，状态色用 --accent-fg-* 成对取值 | 自动：两个主题各截一张同画面，正文与背景对比度 ≥ 4.5 |
| R-04 | 图标只用 lucide-react；代码、界面、文案不出现 emoji | 自动：页面源码与渲染文本扫描 emoji 为 0 |
| R-05 | 按钮用 components/design/Button（primary / secondary / ghost / danger），每一屏只有一个 primary 主动作；不可逆操作放次要位置并二次确认 | 人工：逐画面数 primary 按钮 |
| R-06 | 窄屏（小于 768）两栏改为页内切换，375 宽无整页横向溢出；本页新增的可点元素触控高度不小于 44px。公共组件沿用正式实现（例如 SegmentedTabs 为 32px），差异记为框架债务、不在单页改，原型里用 data-qc-touch-exempt 标出 | 自动：375 宽视口 document.scrollWidth 等于视口宽；未标出的可点元素高度 ≥ 44 |
| R-07 | 新智能体在 src/app/navRegistry.tsx 注册（section: toolbox），上线验收前带 wip: true；入口、路径、预览三行随交付给出 | 自动：navRegistry 里有对应 path 与 wip |
| R-08 | 模型调用与长任务显示当前阶段、进度和预计耗时；静止的「加载中」不超过 2 秒；任务在服务端跑，离开页面不取消，回来能恢复 | 人工：从提交到完成逐阶段截图，离开再返回仍是同一任务 |
| R-09 | 用户可见错误先说结果和恢复动作（例如「已保存稿件，可重试这一幕」），内部诊断只进日志 | 人工：逐个错误态核对文案 |
| R-10 | 前端请求走 services/real 与 apiRequest，响应以 success 判断，错误取 error.message；文件上传用直接 fetch + FormData | 自动：新增 services/real 文件只经 apiRequest 发 JSON 请求 |