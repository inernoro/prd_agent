| feat | prd-admin | SharesPanel scoped 模式新增「本站点统计」按钮：与「新建分享」并排，触发 ShareAnalyticsDrawer scoped 到当前站点的过滤视图 |
| feat | prd-api | GET /api/web-pages/shares/analytics 新增 ?siteId 参数：把统计范围收窄到单个站点 |
| fix | prd-admin | DocBrowser 右键菜单加 createPortal + z-[10000]，修复被祖先 overflow:hidden 裁剪 / 被低层弹窗盖住的展开问题 |
| feat | prd-admin | DocBrowser 右键菜单加「在新窗口打开」+「复制条目链接」两个只读项，避免 share 视图等 readonly 上下文菜单空壳 |
| feat | skill | create-visual-test-to-kb v2.1 强制新增「需求一一对应表」段：archive_report.py 校验 + standard-v2 §6.4 + zz-report 模板提供示例。杜绝"用户提了 10 条只对应 6 条"的茫然 |
