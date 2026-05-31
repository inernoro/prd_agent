| feat | prd-api | 网页托管新增评论能力：站点评论 CRUD + owner 开关（hosted_site_comments 集合 + HostedSite.CommentsEnabled），分享页/站内双入口，复用分享可见性+密码门禁 |
| feat | prd-admin | 网页托管评论 UI：分享页 CommentsSection 访客读/登录评，站点卡「评论管理」按钮打开预览弹窗内嵌评论面板 + 允许评论开关 |
| fix | prd-api | 修复评论功能 CDS 编译失败：补齐 HostedSiteService 6 个评论方法实现 + AddCommentRequest 改名避免与 PmAgent 重名 |
