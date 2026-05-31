| feat | prd-admin | 站点分享页评论入口移到顶栏「评论 N」按钮 + 右侧滑出抽屉，PPT/全屏页无需滚动、不遮挡页面控件，并实时展示评论数 |
| feat | prd-api | 有人评论站点时通知站点 owner（系统通知，自评不通知，每条评论幂等一次） |
| fix | prd-admin | 站点评论入口对团队 viewer 角色开放（去掉 canShare gate），「允许访客评论」开关仅 owner/editor 可见 |
| fix | prd-api | 豁免站点维度评论路由（{siteId}/comments 列表+发表、{siteId}/comments-enabled 开关）的 WebPagesWrite 权限闸门，改由 service 层自鉴权（成员可读/评、owner/editor 可改开关），修复团队 viewer/editor 被中间件提前 403 |
