| feat | prd-admin | 网页托管页右上角新增"投放面板"（ShareDock），拖拽站点卡片到 🌍公开 / 📤分享 / 🗑️回收站 三个槽位即可一键操作，交互参考 macOS Dock 安装隐喻 |
| feat | prd-admin | 新增 `/u/:username` 个人公开主页（无需登录），聚合展示用户所有 Visibility=public 的托管网页，支持封面、浏览量、标签展示 |
| feat | prd-api | HostedSite Model 新增 `Visibility`（private/public）+ `PublishedAt` 字段；新增 `PATCH /api/web-pages/:id/visibility` 端点切换可见性 |
| feat | prd-api | 新增 `PublicProfileController.GetProfile`（`GET /api/public/u/:username` `[AllowAnonymous]`），按用户名聚合公开托管站 |
| feat | prd-api | 新增 `InboxItem` Model 骨架 + `inbox_items` 集合注册（跨系统数据导入通道，Controller/Service/Device Flow 留待下次迭代开发） |
