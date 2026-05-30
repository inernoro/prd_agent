# debt.web-hosting-comments

> 类型：debt（工程债务台账） | 模块：网页托管评论 | 状态：active | 更新：2026-05-30

## 背景

为「网页托管允许被评论」落地的评论能力，记录本次交付的已知边界与后续可补项。

## 已知边界（本次交付未做，刻意留尾）

| 项 | 现状 | 后续可补 |
|----|------|---------|
| 评论回复/盖楼 | 仅平铺单层评论，无 `ParentCommentId` | 如需讨论串，仿 `ReportComment.ParentCommentId` 扩展 |
| 评论编辑 | 仅支持发表 / 删除（软删 `IsDeleted`），不支持编辑 | 加 `PUT comments/{id}`，仿 ReportComment 编辑路径 |
| 实时推送 | 发表后本地乐观插入，不走 SSE；他人评论需刷新 | 复用 `GET /api/branches/stream` 模式做评论流 |
| 防刷 | 评论无独立速率限制（仅借分享 view 门禁） | 如遇滥用，加 per-user / per-site 滑动窗口（仿 `EnforceShareAccessAsync`） |
| 通知 | owner 不会收到「有人评论了你的站点」通知 | 接 `admin_notifications` 或团队活动流 |
| 合集分享评论 | 合集分享（多站点）评论只挂到 `sites[0]` 首个站点 | 如需逐站点评论，前端按 site 分区 + 后端按 siteId 查询 |
| 索引 | `hosted_site_comments` 未建索引（遵守 no-auto-index 规则） | DBA 手动建 `(siteId, createdAt)` 复合索引，写入 `doc/guide.mongodb-indexes.md` |

## 权限模型（已实现）

- 读：站内路径走 `GetByIdAsync`（owner / 团队成员）；分享路径走分享可见性 + 密码门禁（owner-only / logged-in / public）。访客未登录也可读公开分享评论。
- 写：恒需登录。站内路径需对站点有访问权；分享路径需过门禁 + 站点 `CommentsEnabled`。
- 删：评论作者本人 或 站点 owner。
- 开关：仅 owner / editor 可切换 `CommentsEnabled`（默认 true，存量站点反序列化为 true）。

## 关联

- 后端：`HostedSiteComment.cs`、`HostedSiteService.cs`（评论段）、`WebPagesController.cs`（评论端点）、`IHostedSiteService.cs`（DTO）
- 前端：`components/web-hosting/CommentsSection.tsx`、`components/web-hosting/SitePreviewModal.tsx`、`pages/SharedSitePage.tsx`、`services/real/webPages.ts`
