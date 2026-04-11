| feat | prd-api | PR Review V2 后端：新增 PrReviewErrors 统一错误码与 PrReviewException 领域异常，消灭 404 歧义（REPO_NOT_VISIBLE vs PR_NUMBER_INVALID） |
| feat | prd-api | PR Review V2 后端：新增 GitHubOAuthService，用 HMAC(Jwt:Secret) 签名 state 实现无状态 CSRF 防护，支持 code→token 兑换与 /user 信息拉取 |
| feat | prd-api | PR Review V2 后端：新增 GitHubPrClient，happy path 单次调用 + 404 两步探测（先查 /pulls 失败再探 /repos 区分仓库可见性） |
| feat | prd-api | PR Review V2 后端：新增 PrReviewController 十端点（auth status/start/callback/disconnect + items CRUD/refresh/note），严格按 userId 隔离 |
| feat | prd-api | AdminPermissionCatalog 新增 pr-review.use 权限位，与旧 pr-review-prism.use 并存 |
