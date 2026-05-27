| feat | prd-api | 项目路由智能体新增独立的 GitHub Device Flow OAuth 端点：POST /api/project-route-agent/github/device/start · poll · DELETE /github/connection。复用 IGitHubOAuthService 但不再让用户跳 /pr-review |
| feat | prd-admin | 新增 GitHubAuthModal 内联授权弹窗（Device Flow）：显示验证码 + 复制 + 「打开 GitHub 输入」按钮 + 自动轮询完成检测，全程在项目路由智能体页面内 |
| feat | prd-admin | GitHubStatusCard：「去授权」改为打开内联 Modal（不跳出）；已授权时「管理」改为「断开授权」内联 confirm |
| refactor | prd-admin | clone 失败仓库的「授权 GitHub 后重试」按钮也改用 Modal，不再跳 /pr-review |
