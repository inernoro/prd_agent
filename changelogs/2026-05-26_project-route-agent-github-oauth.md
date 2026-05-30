| feat | prd-api | project-route-agent 复用 pr-review 的 GitHub OAuth 授权：clone 时把用户 access token 注入 https URL (x-access-token)，私有 / 组织仓库 routemap 现在也能拉 |
| feat | prd-api | GitRepoCacheService.EnsureClonedAsync 新增可选 accessToken 参数 + 自动 mask 错误日志里的 token + clone 成功后把 origin URL 改回不带 token 的形式 |
| feat | prd-api | 新端点 GET /api/project-route-agent/github/status：前端检查授权状态用 |
| feat | prd-admin | 分析视图新增 GitHubStatusCard：未授权时显示「去授权」按钮跳 /pr-review；已授权时显示账号名 + 「管理」链接 |
| feat | prd-admin | 仓库 × 项目路径栏：CloneFailed 状态 + 未授权时挂「去授权 GitHub 后重试」按钮 |
