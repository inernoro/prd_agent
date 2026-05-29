| fix | prd-api | 收紧划词评论写权限：私有库即便有分享链，第三方登录用户也不能写评论（PR #685 Bugbot/Codex High），canCreate 改为仅 owner + 公开库登录用户；List 仍允许分享访客读评论气泡 |
| fix | prd-api | owner-only 合集分享改逐站点验证团队权限：每个目标站点都需 owner 或团队成员，杜绝跨团队成员越权拿到非己团队站点（PR #685 Codex P1）。错误提示从"仅限创建者/团队"改为"含一个或多个你无权访问的站点" |
| fix | prd-api | 抽取 EnforceShareVisibilityAsync 共享方法，SaveSharedSiteAsync 同步加 Visibility 校验，防止 /save 端点绕过 /view 的 owner-only 防盗（PR #685 Codex P2） |
| fix | prd-admin | ShareAnalyticsDrawer 加 fetchIdRef stale-response 守卫，rangeDays 快速切换 7→30→90 时慢响应不再覆盖新结果（PR #685 Cursor Bugbot Medium） |
