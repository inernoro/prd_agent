| feat | cds | ProjectListPage 卡片大气化（向 Railway 看齐）：卡片高度 ~280px，标题 17px，中间是 dot-grid 工作区画布带 GitHub / GitBranch / 状态图标 glyphs，底部「运行中 · 0/3 服务在线 · owner/repo」状态行；卡片网格 gap 拉到 5（=20px），workspace 改 wide（1360px），hero 上下 padding 加大到 28px，主操作按钮 size=lg |
| refactor | cds | BranchListPage 顶部彻底重做：移除左侧 320px「跟踪 + 远程」两栏列表（用户反馈日常用不到）。改成顶部一个搜索框：focus 时下拉显示已跟踪 + 远程分支建议；点击跟踪行直接切到主区；点击远程行触发部署预览；输入文字过滤；Enter 直接走粘贴预览路径 |
| refactor | cds | BranchListPage 主区域改为全宽独享：选中分支的 BranchCard 占满 1360px 工作区，未选中时大空状态引导用户用顶部搜索；运维 / 容量 / 主机 / 执行器 / 批量等保持在 OpsDrawer 抽屉里 |
