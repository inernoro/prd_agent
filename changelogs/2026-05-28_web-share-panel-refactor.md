| feat | prd-admin | 网页托管分享面板重构：点击「分享」按钮改为弹出列表 + 续期 + 取消 + 新建一体化面板（参考知识库分享模式），不再直接生成单个链接 |
| feat | prd-admin | 分享创建表单新增「谁能访问」选项：仅我自己/团队成员（默认）/ 任何登录用户 / 任何人；防止链接被复制后被外部长期访问 |
| feat | prd-admin | 分享列表新增过期 7 天宽限期：已过期但 ≤ 7 天的链接保留显示并可一键续期 30 天，避免链接突然失效 |
| feat | prd-admin | 网页托管页右上角新增「分享统计」按钮 → 弹出 Drawer，展示活跃链接/PV/独立 IP/Top 链接/时间线（参考 Cloudflare 简化版） |
| feat | prd-admin | 分享列表展示新增 visibility chip、独立 IP 数、续期次数 |
| feat | prd-api | WebPageShareLink 新增 Visibility / RenewalHistory / UniqueIpCount 字段；分享访问加 visibility 校验（owner-only / logged-in / public） |
| feat | prd-api | 新增 POST /api/web-pages/shares/{shareId}/renew 续期端点（仅创建者，过期 ≤ 7d 宽限期内仍可续期） |
| feat | prd-api | 新增 GET /api/web-pages/shares/analytics 用户分享统计聚合端点（活跃链接、时间窗 PV、独立 IP、Top 链接、时间线） |
| feat | prd-api | 新增 GET /api/web-pages/{siteId}/share-logs 站点级分享访问日志端点 |
| feat | prd-api | 新增 GET /api/admin-web-pages/share-diagnostics/{token} 管理诊断端点：返回链接完整状态 + 续期审计 + 最近访问 + 一句话诊断 |
| feat | prd-api | CreateShare 加 forceNew 参数：分享面板每次显式创建新链接，避免旧链接被静默覆盖（"莫名其妙过期"的根因之一） |
| fix | prd-api | ListShares 过滤改为「未过期 OR 过期 ≤ 7 天」：超过 7 天的过期链接不返回列表但保留 DB 行用于审计 |
| fix | prd-api | HostedSiteBackfillService 新增一次性 BackfillShareVisibility：把发布前已存在的非 visit 分享 Visibility 迁移为 public，保护旧链接不被新默认 owner-only 误断 |
| fix | prd-admin | ShareViewPage 处理 403/visibility_denied：未登录提示登录入口；已登录非 owner 显示"仅创建者可访问" |
