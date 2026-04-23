| feat | prd-admin | 周报 Agent 团队视图重构：左侧新增按周垂直导航（当前周默认展开成员、历史周折叠、懒加载累加）+ 顶部周号/日期快速跳转，右侧点击成员就地嵌入周报详情 |
| feat | prd-admin | 周报 Agent 团队视图左侧导航升级：新增「年」分组层（【YYYY】 – 团队名）+ 周支持独立展开/收起，周名改为「N月第M周」中文命名；顶部跳转输入框替换为年/周双下拉选择器；每周成员列表仅显示已提交者（按提交时间倒序） |
| feat | prd-admin | 周报 Agent 左侧导航交互精简：周下拉去掉「W17 ·」冗余前缀只保留中文周名；选择周即跳转（移除独立"跳转"按钮）；折叠状态改为 allow-list 语义（默认仅展开当前选中周+当前 ISO 年），保证「加载更早 8 周」新进来的周全部默认折叠 |
| refactor | prd-admin | 周报 Agent 左侧导航移除「跳回本周」按钮，顶部精简为年/周双下拉一行 |
| feat | prd-admin | 周报 Agent 头部新增三档字号缩放（标准/大/特大，缩放比 1.0/1.15/1.3），用 CSS zoom 同步放大字体与图标；偏好存 sessionStorage，仅作用于周报 Agent 内容区，TabBar 和控件本身保持标准尺寸 |
| feat | prd-admin | 周报详情改为三栏布局：新增右侧 280px Rail（点赞段 + 已阅段），已阅从右上角按钮+Popover 改为常驻列表、点赞从底部浮动栏迁到右栏内竖向显示，嵌入模式与独立路由模式共用 |
| refactor | prd-admin | 周报详情右栏顶部对齐正文：Return banner 移至三栏容器上方，右栏前增 aria-hidden 占位 Tabs，保证缩放/banner 出现时右栏仍与中栏正文 GlassCard 顶边对齐 |
| feat | prd-admin | 周报 Agent 头部新增"暗色/浅色"主题切换（默认暗色），通过 scope 化 [data-theme="light"] 覆盖 tokens.css 里的 --bg-*/--text-*/--border-*/--glass-*/--shadow-card 变量，仅在周报 Agent 容器内生效；偏好存 sessionStorage |
| fix | prd-admin | 修复周报 Agent 浅色模式整体视觉未切换：AppShell 的 <main> 在 ReportAgentPage scope 外，背景 var(--bg-base) 取到仍是暗色。改为进入周报 Agent 时把 data-theme 同步挂到 documentElement，组件卸载/切回暗色时清除，保证整个视口跟随切换且不污染其他页面 |
| fix | prd-admin | 再次修复浅色模式：根因是 src/lib/themeApplier.ts 把 17 个 CSS 变量作为 inline style 写到 <html> 上（特异性 1,0,0,0），完全压制 [data-theme="light"] 规则。给 tokens.css 里浅色块所有变量加 !important（作者 !important 高于无 !important 的 inline style），并补齐 --nested-block-*、--list-item-*、--table-* 等 themeApplier 管理但之前漏覆盖的变量 |
| feat | prd-admin | 周报 Agent 浅色模式视觉精修：新增 useDataTheme hook（MutationObserver 监听 documentElement.dataset.theme），让 inline style 能感知主题；ReportEditor 的 sectionThemes 整宽色条、AI banner、退回 banner、已提交 banner、必填徽章、source badge（AI/MAP 等）在浅色模式下 alpha 调低 + border 加深，避免大色块喧宾夺主；ReportDetailPage 的 Return Dialog overlay、退回 banner、评论 chip 同步浅色化 |
