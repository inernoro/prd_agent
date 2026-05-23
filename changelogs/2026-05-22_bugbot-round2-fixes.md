| fix | prd-admin | 修复 Bugbot Medium：WebPagesPage「查看所有分享」链接 `/assets?tab=shares` → `/my-assets?tab=shares`（`/assets` 是 admin 资产管理页无 shares tab，`/my-assets` 才是 MyAssetsPage） |
| fix | prd-api | 修复 Bugbot High：WebPagesController ViewShare + SaveSharedSite 透传速率限制 429（之前被 switch 默认分支映射成 404），并设置 Retry-After header |
| fix | prd-admin | 修复 Bugbot Medium：ShareTeamWeekDialog handleClose 恢复安全默认（usePassword=true + 重新生成强密码），不再重置为 false 撤销密码保护默认 |
| fix | prd-api | 修复 Codex P1：工作流分享无前端展示页，撤销 WorkflowAgentController 的 ShortLink allocate + 不返回 shortShareUrl，避免暴露打不开的数字短链；移除未使用的 IShortLinkService 注入 |
| feat | prd-api/prd-admin | MyShareItem 加 `viewable` 字段：document_store（SPA 路由缺失）+ workflow（无展示页）标 false；前端「我的分享」对 viewable=false 的类型显示"展示功能开发中"提示而非死链 |
| docs | doc/debt.share-link-security.md | 更新 workflow / document_store 分享对外展示未实现的台账 |
