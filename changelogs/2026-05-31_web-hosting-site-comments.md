| feat | prd-admin | 站点分享页评论改右下角浮动按钮 + 右侧滑出抽屉，访客不必下滚即可评论 |
| fix | prd-admin | 站点评论入口对团队 viewer 角色开放（去掉 canShare gate），「允许访客评论」开关仅 owner/editor 可见 |
| fix | prd-api | 豁免站点维度评论路由（{siteId}/comments 列表+发表、{siteId}/comments-enabled 开关）的 WebPagesWrite 权限闸门，改由 service 层自鉴权（成员可读/评、owner/editor 可改开关），修复团队 viewer/editor 被中间件提前 403 |
