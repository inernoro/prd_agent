# GitHub 基础设施层（Infrastructure.GitHub） · 设计

> 状态：落地中 · 定位同 `design.llm-gateway.md` · 关联 `rule.app-identity.md`

---

## 1. 管理摘要（30 秒看懂）

**目的**：把 GitHub REST API 的调用能力沉淀为一个可复用的基础设施组件 `PrdAgent.Infrastructure.GitHub`，和 `PrdAgent.Infrastructure.LlmGateway` 同级。**PR 审查工作台**、**周报**、未来的**日报**和**其他检测**类功能都通过接口注入来使用它，**不再有任何业务模块自己写 `HttpClient` → `api.github.com` 的胶水代码**。

**核心关切**：
1. **不重复造轮子**——PR Review V2 里写的 899 行 `GitHubPrClient` 不应被锁在 `Services/PrReview/` 目录下，它天生就是通用组件；周报和未来的检测功能需要同一批能力
2. **Per-app 授权**——每个消费方自己决定 access token 从哪里来（per-user OAuth、per-app PAT、GitHub App installation token），基础设施不关心凭证来源
3. **零行为回归**——PR 审查 V2 在 main 里刚上线，重构必须对用户完全不可见，API 响应字段、前端页面、错误码一个不变

**一句话定位**：
> `IGitHubClient` + `IGitHubOAuthService` 是封装 GitHub REST API 的后端 SDK。它们和 `ILlmGateway` 是兄弟关系——都在 `Infrastructure/` 下独立存在，通过 DI 注入，不和任何具体业务绑定。

**不做什么**：
- 不做 AI 相关的任何事情（这是 GitHub 基础设施，不是 AI 组件）
- 不做权限判定（那是 Controller 层的 `[Authorize]` + 权限点的职责）
- 不强制统一的 token 账号（各应用自己授权自己的连接）
- 不做响应缓存（每次都打实网，避免"快照过期"歧义）
- 不重新发明错误分类——PR Review V2 里已经做得很好，直接沿用

---

## 2. 为什么是"基础设施"而不是"PrReview 的一部分"

### 2.1 消费方矩阵

| 消费方 | 现状 | 使用的 GitHub 能力 |
|---|---|---|
| **PR 审查工作台**（pr-review，V2） | ✅ main 上线 | Device Flow OAuth + 拉 PR 快照 + 拉 PR 历史（commits/reviews/comments/timeline/check-runs） |
| **周报 Agent**（report-agent） | ✅ main 生产中 | `GitHubConnector` + `GitSyncWorker` 每 5 分钟轮询，拉 commits（自己写的 165 行 HttpClient 胶水代码） |
| **日报 / 其他检测** | 未来 | 未知，可能需要 commits / PRs / issues / check-runs |
| **桌面自动更新** | ✅ main 生产中 | 前端 `DesktopDownloadDialog` 直接调 `api.github.com/repos/.../releases/latest` —— **不迁移**（前端范畴，不在后端基础设施范围内） |

三个后端消费方都需要"调 GitHub + 解析响应 + 分类错误"，但今天只有 PR 审查做得好。把它抽出来就等于让周报、日报、未来的检测功能**都继承同一套质量**：SSRF 白名单、体积截断、404 两步探测、限流错误分类……不用每个消费方都从头再写一遍。

### 2.2 和 LlmGateway 的相似点与差异

| 维度 | LlmGateway | GitHub 基础设施 |
|---|---|---|
| 定位 | 大模型调用的统一入口 | GitHub REST API 的统一入口 |
| 目录 | `Infrastructure/LlmGateway/` | `Infrastructure/GitHub/` |
| 主接口 | `ILlmGateway.SendAsync/StreamAsync` | `IGitHubClient.FetchPullRequest/FetchHistory/...` |
| DI 注册 | `AddScoped<ILlmGateway, LlmGateway>()` | `AddScoped<IGitHubClient, GitHubPrClient>()` |
| 凭证管理 | `AppCallerCode` + 模型池三级调度 | 调用方自己传 `accessToken`（per-user/per-app/per-installation 都支持） |
| 错误模型 | `GatewayResponse.ErrorCode` | `GitHubException.Code` + `HttpStatus` |
| 审计日志 | `llmrequestlogs` 集合 | 目前无——可以后续补（见 §6 扩展路径） |
| Adapter 多态 | OpenAI / Claude 两家 | 不需要——GitHub 只有一家 |

**结论**：**借鉴"独立组件"的定位，不继承"多 Provider 调度"的复杂度**。GitHub 只有一家，不存在"换 Provider"的需求，所以不需要 Adapter 模式、不需要调度器、不需要模型池概念。接口面是 pure HTTP client wrapper。

---

## 3. 目录与文件

```
prd-api/src/PrdAgent.Infrastructure/GitHub/
├── IGitHubClient.cs              ← 接口：PR 操作
├── IGitHubOAuthService.cs        ← 接口：OAuth Device Flow
├── GitHubPrClient.cs             ← 实现（原 Services/PrReview/GitHubPrClient.cs，899 行）
├── GitHubOAuthService.cs         ← 实现（原 Services/PrReview/GitHubOAuthService.cs，370 行）
├── PrUrlParser.cs                ← 工具类（原 Services/PrReview/PrUrlParser.cs，126 行）
└── GitHubException.cs            ← 通用 GitHub 错误基类（新建）

prd-api/src/PrdAgent.Api/Services/PrReview/
└── PrReviewErrors.cs             ← 只保留 PR 审查专属错误，PrReviewException 继承 GitHubException
```

**说明**：
- DTOs（`GitHubPrHistoryDto` / `GitHubPrCommitDto` / `PrFileSummary` 等）随 `GitHubPrClient.cs` 一起迁移到 `PrdAgent.Infrastructure.GitHub` 命名空间
- `PrReviewSnapshot` / `PrReviewItem` 仍在 `PrdAgent.Core.Models`——它们是业务数据模型，不是 GitHub 原始 DTO
- `PrReviewModelInfoHolder` / `LlmStreamDelta` / `PrAlignmentService` / `PrSummaryService` **不动**——这些是 PR 审查的业务层，消费基础设施但不属于基础设施

---

## 4. 接口设计

### 4.1 IGitHubClient

```csharp
public interface IGitHubClient
{
    Task<PrReviewSnapshot> FetchPullRequestAsync(
        string accessToken, string owner, string repo, int number,
        CancellationToken ct);

    Task<PrReviewSnapshot> FetchPullRequestAsync(
        string accessToken, string owner, string repo, int number,
        bool includeFilesAndIssue,
        CancellationToken ct);

    Task<GitHubPrHistoryDto> FetchHistoryAsync(
        string accessToken, string owner, string repo, int number,
        string? headSha,
        CancellationToken ct);

    Task<object> FetchHistorySliceAsync(
        string accessToken, string owner, string repo, int number,
        string? headSha, string type, int page, int perPage,
        CancellationToken ct);
}
```

**设计要点**：
- 每个方法第一参数是 `accessToken`——**凭证来源无关性**是 per-app 授权的关键。调用方自己从 `GitHubUserConnection`（per-user）/`IConfiguration`（per-app PAT）/GitHub App 换取 token 后传入
- 所有方法都是**只读**的（PR 审查场景）。未来若需要写操作（评论 PR / 请求评审 / 更新 issue 等），在同一个接口上增加方法，或按需拆分子接口
- 错误分类通过 `GitHubException` 抛出，调用方统一 `catch (GitHubException ex)` 后按 `ex.Code` / `ex.HttpStatus` 映射

### 4.2 IGitHubOAuthService

```csharp
public interface IGitHubOAuthService
{
    Task<DeviceFlowStartResult> StartDeviceFlowAsync(
        string userId,
        CancellationToken ct);

    Task<DeviceFlowPollResult> PollDeviceFlowAsync(
        string userId, string flowToken,
        CancellationToken ct);

    Task<GitHubUserInfo> FetchUserInfoAsync(
        string accessToken,
        CancellationToken ct);
}
```

**设计要点**：
- Device Flow (RFC 8628) 完整封装，CDS 动态域名下唯一可行的 OAuth 变体
- `flow_token` 是 HMAC 签名的 `(device_code, userId, expiry)` 三元组，**device_code 永远不出后端**
- `FetchUserInfoAsync` 单独开一个方法，供调用方拿到 token 后查 GitHub login/id/avatar（回写 `GitHubUserConnection`）

### 4.3 GitHubException

继承关系：

```
Exception
  └── GitHubException (Infrastructure/GitHub/)
        ├── NotConnected()          [412 GITHUB_NOT_CONNECTED]
        ├── TokenExpired()          [401 GITHUB_TOKEN_EXPIRED]
        ├── UrlInvalid(reason)      [400 PR_URL_INVALID]
        ├── RepoNotVisible(o,r)     [404 GITHUB_REPO_NOT_VISIBLE]
        ├── PrNumberInvalid(o,r,n)  [404 PR_NUMBER_INVALID]
        ├── Forbidden()             [403 GITHUB_FORBIDDEN]
        ├── RateLimited(reset)      [429 GITHUB_RATE_LIMITED]
        ├── Upstream(status)        [502 GITHUB_UPSTREAM_ERROR]
        ├── OAuthNotConfigured()    [503 GITHUB_OAUTH_NOT_CONFIGURED]
        ├── DeviceFlowTokenInvalid()  [403]
        ├── DeviceFlowExpired()     [408]
        ├── DeviceFlowAccessDenied() [403]
        └── DeviceFlowRequestFailed(reason) [502]
        └── PrReviewException (Services/PrReview/)  ← 继承自 GitHubException
              ├── ItemNotFound()    [404 PR_ITEM_NOT_FOUND]
              └── Duplicate()       [409 PR_ITEM_DUPLICATE]
```

**动机**：
- PR Review V2 原先 `PrReviewException` 里塞了 15 个工厂方法，其中 13 个是通用 GitHub 错误，2 个（ItemNotFound/Duplicate）是 PR 审查应用层错误
- 拆分后：通用错误归基础设施（所有消费方都能用），应用层错误归消费方自己
- Controller 的 `catch (GitHubException)` 基类捕获同时吃下两类异常，依赖 `.Code` 字段做统一映射，零代码量增加

---

## 5. Per-App 授权模型（R5 落地）

### 5.1 核心原则

> 基础设施 **不管** 凭证从哪来，只负责**用传进来的 token 调 GitHub**。

这让三种 app-level 授权模式天然并存：

| 模式 | 场景 | 凭证来源 |
|---|---|---|
| **Per-user OAuth** | PR 审查工作台 | `GitHubUserConnection` 集合（每个 PRD Agent 用户一条记录，存加密 OAuth token） |
| **Per-app PAT** | 周报 Agent 同步 commits | `appsettings.json` 里的 `GithubToken` 字段（全局） |
| **Per-installation App token** | 未来机器人场景 | GitHub App 换取的 installation token（JIT 刷新） |

调用方只需要传 `accessToken` 给 `_github.FetchPullRequestAsync(token, ...)`，基础设施不需要知道 token 是 PAT 还是 OAuth，也不需要知道它属于哪个用户。

### 5.2 为什么这样做（对照用户反复强调的 R5）

用户明确说：
> "各自 app 也可以单独提起授权，并不需要把授权 github 作为全局唯一……账户也不一样……**组件需要剥离**"
> "不让代码再做一遍，做基础设施上的组件而不是权限方面的基础设施"

我们的回应：
- 组件本身**不做授权判定** → Controller 层保留 `[Authorize]` + `AdminPermissionCatalog` 权限点，和以前一样
- 组件本身**不做凭证存储** → `GitHubUserConnection` 仍在 `Core/Models`，PR 审查 Controller 自己查表 + 解密；未来的周报如果想用不同方式（比如 `appsettings.json`）管理 token，完全自由
- 组件本身**不关心账户唯一性** → 不同应用可以用不同账号，同一应用内不同用户也可以用不同账号

---

## 6. 未来扩展路径

### 6.1 周报 Agent 迁移（Phase 2，本次不做）

当前周报的 `prd-api/src/PrdAgent.Api/Services/ReportAgent/GitHubConnector.cs` 有 165 行手写的 `HttpClient.GetAsync("/repos/.../commits")` 代码。迁移步骤：

1. 在 `IGitHubClient` 上增加 `ListCommitsAsync(token, owner, repo, options, ct)` 方法（GitHub REST `/repos/{o}/{r}/commits` 端点）
2. `GitHubPrClient` 实现该方法（内部复用已有的 `CreateAuthedClient` 辅助）
3. `GitHubConnector` 的 HTTP 部分改为 `_gitHub.ListCommitsAsync(...)`，保留 `UserMapping` / upsert 业务逻辑
4. 以 `GitHubConnector` 作为**第二个真实消费者**，验证基础设施可用性

**为什么本次不一起做**：
- 周报在生产环境每 5 分钟轮询一次，改动风险高，用户要求"最稳定"
- PR #377 刚合并到 main，先让 PR 审查的重构跑稳再碰周报
- 加 `ListCommits` 方法也是纯追加，不会影响 PR 审查

### 6.2 其他可扩展的操作

| 场景 | 方法建议 |
|---|---|
| 读文件内容（日报/检测） | `GetContentAsync(token, owner, repo, path, ref)` |
| 列 issues（未来缺陷联动） | `ListIssuesAsync(token, owner, repo, filter)` |
| 评论 PR（AI 自动审查） | `CreateReviewCommentAsync(token, owner, repo, number, body)` |
| CI 状态（PR 审查扩展） | 已覆盖：`FetchHistoryAsync` 里的 `check-runs` |

**原则**：每加一个方法要有**真实的消费者**，不做投机性空壳代码（CLAUDE.md 规则"不为假想需求设计"）。

### 6.3 共性基类抽象（第 3 个类似组件出现时再做）

未来若出现 `IJiraClient` / `ISlackClient` / `IGitLabClient` 等类似的"封装第三方 REST API 的基础设施组件"，可以把共性提取到 `PrdAgent.Infrastructure.ExternalHttp/` 下：

- `ExternalHttpClientBase`：重试 / 超时 / 脱敏 / 错误映射基类
- `IExternalCredentialStore<T>`：通用凭证存储抽象
- `IExternalOperationAuditWriter`：审计日志抽象

**但今天不做**——两个组件（LlmGateway + GitHub）还不够说明规律，三个才算趋势。**禁止过早抽象**。

---

## 7. 关联文档

- `doc/design.pr-review-v2.md` — PR 审查工作台 V2 设计（本次基础设施的第一个消费方）
- `doc/design.llm-gateway.md` — LlmGateway 设计（本组件对照的基础设施组件样板）
- `rule.app-identity.md` — appKey 硬编码规范（消费方层面）
- `rule.server-authority.md` — 长任务必须 `CancellationToken.None`（GitHub 同步场景需要）
- `changelogs/2026-04-11_github-infrastructure.md` — 本次迁移的碎片记录

---

## 8. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 命名空间改动导致 PR 审查 Controller 编译失败 | 中 | 阻断合并 | 一次性批量替换 `using`，CI 必须绿 |
| `PrReviewException` 继承关系改动导致 catch 逻辑漏捕获 | 低 | 部分错误类型回到 500 | 所有 `catch (GitHubException ex)` 基类捕获，基类覆盖子类，多态正确 |
| `GitHubConnector` 未迁移期间样式不统一 | 低 | 代码审美 | 明确留在 Phase 2；changelog 和本文都记录 |
| 未来消费方误用 `accessToken` 明文穿透到日志 | 中 | 安全 | 本文强调凭证来源无关 + 不写日志；具体 logger 配置由消费方负责 |
| 基础设施层扩展出"多账号切换"等伪需求 | 低 | 过度设计 | 明确"不做权限基础设施"的原则，需求进不来就不实现 |

---

## 9. 验收清单

- [x] `PrdAgent.Infrastructure.GitHub` 目录创建，含 6 个文件（2 接口 + 3 实现 + 1 异常）
- [x] `PrReviewErrors.cs` 瘦身，`PrReviewException` 继承 `GitHubException`
- [x] `PrReviewController.cs` 改用接口注入 + `catch (GitHubException)`
- [x] `Program.cs` DI 改为接口→实现注册
- [x] `PrUrlParserTests.cs` 迁移 `using`
- [x] `git mv` 保留历史
- [x] changelog 碎片 + 本文档落盘
- [ ] CI 全绿（交 CI 验证）
- [ ] PR 审查工作台冒烟测试：Device Flow 完整走通 + 拉 PR + 查看历史 + 写笔记（由用户确认）
- [ ] 周报 Agent 迁移（Phase 2，另开一个 PR）
