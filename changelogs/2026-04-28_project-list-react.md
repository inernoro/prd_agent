| feat | cds | 将 `/project-list` 接入 React 项目列表基础版：列表、空状态、新建、删除、进入项目、legacy default 迁移/残留清理都走 `apiRequest()`；fresh install 保持 0 项目，不再展示空 `default` 横幅；存储默认路径收敛到 MongoDB `mongo-split` 多 collection |
| feat | cds | 在 React 新建项目 Dialog 中加入 GitHub 仓库选择器：读取 `/api/github/repos?page=N`，支持搜索、加载更多、选中后自动填充 clone URL；未连接 Device Flow 时引导到 `/cds-settings#github` |
| feat | cds | 在 React 项目列表加入 clone progress：pending/error 项目可开始或重试克隆，新建 Git 项目后自动打开 SSE 进度 Dialog，展示 `/api/projects/:id/clone` 流式日志 |
| feat | cds | 将 clone 后自动配置下沉到后端：`POST /api/projects/:id/clone` 成功后自动检测技术栈并创建默认 BuildProfile，减少“创建项目后还要手填 profile”的步骤 |
| feat | cds | 用 GitHub clone URL 创建项目时自动记录 `githubRepoFullName` 并默认开启 push 自动部署；首次 webhook 会回填 installation id，让 repo picker 到 webhook 自动化连成一条链 |
| feat | cds | 在 React 项目卡片加入项目级 Agent Key 管理：只读列出现有 key，签发前确认并仅显示一次明文，吊销前二次确认 |
| feat | cds | 将 Agent pending import 审批迁入 React 项目列表：`/project-list?pendingImport=<id>` 自动打开记录，可预览 YAML、批准应用或拒绝留痕 |
| feat | cds | 在 React 项目列表 header 加入“下载技能包”和“全局通行证”：技能包直连 `/api/export-skill`，全局 Key 支持签发、列表、吊销并保留二次确认 |
| polish | cds | 新建项目流程简化：粘贴 Git 仓库 URL 即可自动推导项目名，项目名称不再是创建仓库项目前的必填阻塞项 |
| polish | cds | 重排 `/project-list` 首屏信息层级：项目控制台统一承载统计、安装技能包、全局 Key、Agent 记录、快速 Git URL 创建与项目行操作，项目卡从大卡片改为横向操作行 |
| refactor | cds | 抽出共用 `MetricTile` 信息块，替换项目列表、项目设置统计、分支详情和集群设置里的重复 `Metric/Stat` 小组件 |
| test | cds | 更新 pending-import 路由测试，不再假设 fresh install 自动存在 `default`；legacy default 兼容测试改为显式 seed |
| test | cds | 更新 global-agent-keys 路由测试，项目级 key 权限边界用显式 seed 的 legacy default 项目验证 |
