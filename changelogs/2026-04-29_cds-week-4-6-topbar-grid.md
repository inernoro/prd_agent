| feat | cds | TopBar 新增 `center` 中间插槽 + `centerWide` flag，允许页面把核心交互内联到导航栏（粘贴 Git URL / 搜索分支），把工作区让给主内容 |
| feat | cds | 新增 DropdownMenu / DropdownItem / DropdownDivider / DropdownLabel 轻量下拉菜单组件，点击外部 / Esc 关闭，z 层级 30 |
| refactor | cds | ProjectListPage 全屏化：移除「接入仓库」hero 卡片与「自动化工具」折叠面板；Git URL 输入框内联到 TopBar 中间，自动化工具（下载技能包 / 全局 Agent Key / Agent 申请记录）进右上角「新建」下拉菜单；Workspace 只剩项目卡网格 |
| refactor | cds | BranchCard 重写为紧凑网格 BranchTile：~360px 宽，状态点+分支名 header、commit/服务/时间元信息行、服务 pills、底部 [预览]+[部署]+[详情] 三按钮固定位置（保留 legacy 用户心智），更多操作（拉取/停止/收藏/调试/标签/重置/删除）收进右上角 kebab 下拉菜单 |
| refactor | cds | BranchListPage 全屏化：移除「预览分支」hero 卡片；分支搜索 + autocomplete 下拉内联到 TopBar 中间；选中跟踪分支跳转分支详情页，选中远程分支触发部署预览；移除单分支 master view，主区改为 BranchTile 3 列网格（按收藏 → 最近活跃排序） |
