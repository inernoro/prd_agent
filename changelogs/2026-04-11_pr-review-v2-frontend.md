| feat | prd-admin | PR Review V2 前端：新增 /admin/pr-review 页面，严格 SSOT + 无 localStorage，整页拆成 5 个组件（200 行主页面取代 1781 行巨石） |
| feat | prd-admin | PR Review V2 前端：GitHubConnectCard 组件——OAuth 整页跳转连接 GitHub，展示已连接 login/头像/scopes，支持一键断开 |
| feat | prd-admin | PR Review V2 前端：AddPrForm 粘贴 PR URL 同步拉取，失败提示保留错误码分类 |
| feat | prd-admin | PR Review V2 前端：PrItemCard 折叠式卡片——基本信息/详情/Markdown 笔记失焦自动保存/刷新/删除 |
| feat | prd-admin | PR Review V2 前端：PrItemList 列表 + 分页 + 空态/加载态区分 |
| feat | prd-admin | PR Review V2 前端：usePrReviewStore（Zustand）严格 SSOT，乐观 UI + 回滚机制 |
| feat | prd-admin | PR Review V2 前端：新增 services/real/prReview.ts 类型化 API 层，注册至 services/index.ts |
| feat | prd-admin | App.tsx / authzMenuMapping 新增 pr-review 路由和权限位 |
