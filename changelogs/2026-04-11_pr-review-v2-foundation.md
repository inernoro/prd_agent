| feat | prd-api | PR Review V2 基础：新增 GitHubUserConnection / PrReviewItem / PrReviewSnapshot 模型，奠定 per-user OAuth 审查路径 |
| feat | prd-api | PR Review V2：新增 PrUrlParser（owner/repo/number 抽取 + SSRF 白名单），伴随 30+ 单测覆盖协议/host/路径逃逸/编码绕过/非法编号/字符越界 |
| feat | prd-api | PR Review V2：在 MongoDbContext 注册 github_user_connections 与 pr_review_items 集合 |
| feat | doc | 新增 doc/design.pr-review-v2.md：以 OAuth 为根的 PR 审查工作台顶层设计，定义 MVP 边界、错误分类、下线计划 |
