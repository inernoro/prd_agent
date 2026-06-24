# debt.web-hosting.comments

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
| 索引 | `hosted_site_comments` 未建索引（遵守 no-auto-index 规则） | DBA 手动建 `(siteId, createdAt)` 复合索引，写入 `doc/guide.platform.mongodb-indexes.md` |

## 权限模型（已实现）

- 读：站内路径走 `GetByIdAsync`（owner / 团队成员）；分享路径走分享可见性 + 密码门禁（owner-only / logged-in / public）。访客未登录也可读公开分享评论。
- 写：恒需登录。站内路径需对站点有访问权；分享路径需过门禁 + 站点 `CommentsEnabled`。
- 删：评论作者本人 或 站点 owner。
- 开关：仅 owner / editor 可切换 `CommentsEnabled`（默认 true，存量站点反序列化为 true）。

## 验收状态（2026-05-31 已通过）

- 前端：`pnpm tsc --noEmit` 0 error、`pnpm lint` 改动文件 0 告警。
- 后端：CDS 远端编译——期间修复 3 轮真实编译错误（接口未实现 CS0535×6、`AddCommentRequest` 与 PmAgent 重名 CS0101、前端评论入口未接线 TS6133），最终 deploy 流水线全绿、L1/L2/L3 探针 200。
- API E2E（灰度直连，AI 密钥 impersonate）：列表/发表/再查/开关/关闭后发表 403/重开/删除 8 条用例全过；存量站点 `commentsEnabled` 反序列化为 true。
- 视觉验收：Playwright 真人路径 10 张截图（站点卡评论管理弹窗发表/开关 + 分享页访客只读 + 登录可评）全部通过，已归档知识库并自查可打开。
- 报告分享链：https://fervent-meitner-lcue8-claude-prd-agent.miduo.org/s/lib/ftDV5mobkfHt?entry=7f3cdff238d640448019536ba23f75a7
- 早前「CDS building 30 分钟」判断有误：实为容器构建失败进入 error 态（CDS proxy 把 error 也包成 `status` JSON 返回 200，误导了轮询）；真正根因是编译错误，看 `branch logs --profile api-prd-agent` 才暴露。

## 关联

- 后端：`HostedSiteComment.cs`、`HostedSiteService.cs`（评论段）、`WebPagesController.cs`（评论端点）、`IHostedSiteService.cs`（DTO）
- 前端：`components/web-hosting/CommentsSection.tsx`、`components/web-hosting/SitePreviewModal.tsx`、`pages/SharedSitePage.tsx`、`services/real/webPages.ts`
