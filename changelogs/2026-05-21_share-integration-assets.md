| fix | prd-admin | **历史兼容性修正**：撤回 C3 引入的 ShortLinkRouter 错误 Navigate（workflow → `/share/workflow/` 路由不存在；document_store → `/public/share/` 路由不存在）。改为：workflow 显示 UnsupportedTargetError（与历史一致）；document_store Navigate 到 `/library/share/{token}` 与 DocumentStorePage 创建分享 URL 对齐 |
| fix | prd-api | 撤回 C5 引入的 DocumentStoreController 错误 shareUrl：`/public/share/{token}` → 恢复 `/library/share/{token}`（前端历史 URL，与 DocumentStorePage 一致；事实自查：App.tsx 无 `/public/share/` 路由） |
| feat | prd-admin | 「我的资产」页加「分享」tab（按用户诉求集成而非独立页）：复用 MySharesPage 组件，支持 URL `?tab=shares` 直达，切 tab 同步到 URL（可复制可分享） |
| feat | prd-admin | WebPagesPage ShareDialog 成功提示加「查看所有分享 →」链接，新标签打开 `/assets?tab=shares` |
| docs | doc/debt.share-link-security.md | 记录事实自查发现的历史缺陷：知识库 `/library/share/:token` 前端 SPA 路由不存在（独立缺陷，非本次引入）；工作流分享无专用 ViewPage |
