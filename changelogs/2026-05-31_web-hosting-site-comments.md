| feat | prd-admin | 站点分享页评论改右下角浮动按钮 + 右侧滑出抽屉，访客不必下滚即可评论 |
| fix | prd-admin | 站点评论入口对团队 viewer 角色开放（去掉 canShare gate），「允许访客评论」开关仅 owner/editor 可见 |
| fix | prd-api | 豁免 POST/GET /api/web-pages/{siteId}/comments 的 WebPagesWrite 权限闸门，团队 viewer 成员可读/可评（service 层 GetByIdAsync 自鉴权），保留 comments-enabled 开关写权限 |
