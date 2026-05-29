| fix | prd-api | 收紧划词评论写权限：私有库即便有分享链，第三方登录用户也不能写评论（PR #685 Bugbot/Codex High），canCreate 改为仅 owner + 公开库登录用户；List 仍允许分享访客读评论气泡 |
| fix | prd-api | owner-only 合集分享改逐站点验证团队权限：每个目标站点都需 owner 或团队成员，杜绝跨团队成员越权拿到非己团队站点（PR #685 Codex P1）。错误提示从"仅限创建者/团队"改为"含一个或多个你无权访问的站点" |
| fix | prd-api | 抽取 EnforceShareVisibilityAsync 共享方法，SaveSharedSiteAsync 同步加 Visibility 校验，防止 /save 端点绕过 /view 的 owner-only 防盗（PR #685 Codex P2） |
| fix | prd-admin | ShareAnalyticsDrawer 加 fetchIdRef stale-response 守卫，rangeDays 快速切换 7→30→90 时慢响应不再覆盖新结果（PR #685 Cursor Bugbot Medium） |
| fix | prd-api | CapsuleExecutor 工作流自动分享(autoShare=public/password)显式传 visibility=public，修复新默认 owner-only 导致外部分享链返回 visibility_denied 的 regression（PR #685 Codex P2） |
| fix | prd-api | ListInlineComments 读权限收紧到 valid share context：私有库须带未撤销+未过期的有效 shareToken 才能读评论，不再靠"存在任意分享链"放行（PR #685 Codex P1）；新增 ?shareToken= 参数 |
| fix | prd-admin | DocBrowser 新增 inlineCommentShareToken prop，分享视图透传分享 token 读私有库评论气泡；InlineCommentDrawer 同步透传 |
| fix | prd-api | EnforceShareVisibilityAsync 复制 SiteIds 新 list 再 Insert，避免原地 mutate 实体污染下游（PR #685 Bugbot Low） |
| fix | prd-admin | SharesPanel refreshShares 加 fetchIdRef stale-response 守卫（PR #685 Bugbot Low） |
| fix | prd-api | ListInlineComments 的 shareToken 校验补 EntryId 匹配：单文档分享 token 不能越权读整 store 评论（PR #685 Codex P1） |
| fix | prd-admin | fetchIdRef stale guard 改用 try/finally 保证 loading 清理：仅 latest 请求清，stale 让位避免 spinner 卡死（PR #685 Bugbot Medium）。SharesPanel + ShareAnalyticsDrawer 同步 |
| chore | prd-admin | 删 dead code listShareLogsForSite（services/real + index.ts re-export），无 consumer（PR #685 Bugbot Low） |
