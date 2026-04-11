| refactor | prd-api | 新建 GitHub 基础设施层 `PrdAgent.Infrastructure.GitHub`，参照 LlmGateway 的"独立组件"定位，供 PR 审查工作台、未来的日报/检测等多应用复用同一套 GitHub REST 封装 |
| refactor | prd-api | 抽取 `IGitHubClient` 接口 + 把 `GitHubPrClient`（899 行）从 `Services/PrReview/` 迁移到 `Infrastructure/GitHub/`，实现接口；业务层通过接口注入，和凭证来源（per-user OAuth/per-app PAT/GitHub App token）完全解耦 |
| refactor | prd-api | 抽取 `IGitHubOAuthService` 接口 + 把 `GitHubOAuthService`（Device Flow RFC 8628 + HMAC 签名 flow_token）从 `Services/PrReview/` 迁移到 `Infrastructure/GitHub/`，实现接口 |
| refactor | prd-api | 把 `PrUrlParser`（SSRF 白名单 + URL 解析）从 `Services/PrReview/` 迁移到 `Infrastructure/GitHub/`，作为通用 GitHub PR URL 工具类 |
| refactor | prd-api | 新建 `GitHubException` 基类持有通用 GitHub 错误码（NotConnected/TokenExpired/RepoNotVisible/RateLimited/OAuth/DeviceFlow 等 13 个工厂方法）；`PrReviewException` 改为继承自 `GitHubException`，只保留 PR 审查应用专属的 `ItemNotFound`/`Duplicate` |
| refactor | prd-api | `PrReviewController` 改用 `IGitHubClient` + `IGitHubOAuthService` 接口注入；9 处 `catch (PrReviewException)` 改为 `catch (GitHubException)` 基类捕获（多态兼容），行为零变化 |
| refactor | prd-api | `Program.cs` DI 注册改为接口→实现形式：`IGitHubClient → GitHubPrClient`、`IGitHubOAuthService → GitHubOAuthService`；HttpClient "GitHubApi" 命名客户端配置保持不变 |
| refactor | prd-api | 单测 `PrUrlParserTests.cs` 的 `using` 从 `PrdAgent.Api.Services.PrReview` 改为 `PrdAgent.Infrastructure.GitHub`，测试代码本身无改动 |
| docs | doc | 新增 `doc/design.github-infrastructure.md`，记录 GitHub 基础设施层的分层结构、与 LlmGateway 的异同、per-app 授权模型、未来扩展路径（Commits/Issues/CheckRuns 操作按需追加） |
