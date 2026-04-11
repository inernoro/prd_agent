# PR Review V2 —— 以 OAuth 为根的最小可审查工作台

> 状态：起草中 · 替代 `design.pr-review-prism.md`（若存在） · 关联 `rule.app-identity.md`、`rule.snapshot-fallback.md`、`rule.no-localstorage.md`

---

## 1. 管理摘要（30 秒看懂）

**目的**：让任何一个拥有 GitHub 账号的审查者，能够在一个界面里粘贴任意团队（只要他本人有权访问）的 PR 链接，拉取 PR 真实数据，做私人笔记，管理一份自己的"在看 PR 清单"。

**核心洞察**：当前实现把"审查 PR"做成了"给公司配一个全局 GitHub Token 再做审查系统"，导致权限、onboarding、workspace 三层复杂度都压到了前端。V2 把 **Token 从"应用全局配置"迁到"每个用户自己的 GitHub OAuth 连接"**，这一改动会顺带消灭 80% 的偶发复杂度。

**OAuth 模式选择**：采用 **GitHub Device Flow (RFC 8628)** 而非 Web Flow。
原因是本项目部署在 CDS 动态域名（`<branch>.miduo.org`），每条分支一个域名，
而 Web Flow 的 Callback URL 必须预先注册且不支持通配符——CDS 上根本不可用。
Device Flow 完全不需要 Callback URL，本地/CDS/生产共用一套代码，
是 `gh auth login` 同款机制。

**一句话 MVP**：`连接 GitHub → 粘贴 PR URL → 看数据 + 写笔记`。

**不做什么**：不做 PR 模板解析、不做顶层设计源校验、不做批量评分、不做决策卡发布、不做全局 Token 管理面板、不做多 workspace 切换。这些要么与目标正交（别人家的 PR 你管不到模板），要么是错误前提催生的仪式。

**删除规模**：~10,000 行代码删除（含 `PrReviewPrismController.cs` 1211 行、`PrReviewPrismPage.tsx` 1781 行、`.github/pr-architect/*` 整个目录、5 个 Python 脚本、5 个 workflow），新增约 1,500 行。净减 85%。

---

## 2. 产品定位

### 2.1 目标用户与场景

| 用户 | 场景 | 期望路径 |
|---|---|---|
| 架构师 | 同时在跟 10 个开源仓的 PR，想把它们集中在一个面板 | 粘贴每个 PR URL，卡片列表统一刷新 |
| 独立开发者 | 想记录自己正在 review 的 PR 的进展和想法 | 一页界面、笔记随手写、关掉浏览器不丢数据 |
| Tech Lead | 跨多个团队 review | 授权自己的 GitHub 账号（已经是各仓的 collaborator），不用任何额外 token 管理 |

### 2.2 不覆盖的场景（明确划界）

- ❌ 强制所有 PR 必须填某种元数据模板
- ❌ 做 CI 阻断/门禁（那是 GitHub branch protection + 外部 CI 的职责）
- ❌ 管理组织级仓库和 reviewer 分配（那是 GitHub 自身的功能）
- ❌ AI 自动生成 review 意见（若需要，作为 V3 选项，不进 MVP）

---

## 3. 用户场景（Happy Path 三步）

```
Step 1：首次连接（Device Flow，RFC 8628）
  用户点击 "连接 GitHub"
    ↓  前端 POST /api/pr-review/auth/device/start
    ↓  后端向 GitHub 请求 device_code，返回 { userCode, verificationUriComplete, flowToken, intervalSeconds }
    ↓  前端自动 open(verificationUriComplete) 新 tab 到 github.com/login/device?user_code=XXXX
    ↓  同时页面显示 userCode + 倒计时 + 轮询进度条
    ↓  用户在 GitHub 页面确认 user_code → 点 Authorize
    ↓  后端每 intervalSeconds 秒 POST /api/pr-review/auth/device/poll { flowToken }
    ↓      pending → 继续等
    ↓      slow_down → 调大间隔
    ↓      done → 后端换 token 存库，前端刷新 authStatus
    ↓  页面切到已连接卡片

Step 2：添加 PR
  用户粘贴 https://github.com/OrgA/repoX/pull/42
    ↓  后端提取 (owner, repo, number)，正则白名单校验
    ↓  用该用户 token 调 GitHub REST GET /repos/OrgA/repoX/pulls/42
    ↓  把结果写入 pr_review_items（仅存最新快照）
    ↓  返回前端列表更新

Step 3：日常使用
  用户看到列表，点击任一卡片 → 展开详情 → 写笔记（失焦即存）
  需要最新数据时点刷新，GitHub 再查一次，更新快照
```

**错误恢复路径**：
- Token 失效（GitHub 返回 401）→ 前端提示"连接已过期"→ 一键重连 Device Flow
- Device Flow 授权超时（15 分钟未点授权）→ 前端显示"授权已超时"并允许重新发起
- 用户在 GitHub 页面拒绝 → `access_denied` → 前端显示"你拒绝了授权"
- 权限不够（GitHub 404 屏蔽私有仓）→ 两步探测后返回"仓库不可见"而非"PR 不存在"
- 网络故障 → 保留旧快照 + `lastRefreshError` 写入 UI 提示条

---

## 4. 核心能力

| 能力 | 实现要点 |
|---|---|
| **连接 GitHub 账号** | OAuth Device Flow (RFC 8628)，无需 Callback URL，加密存 token，支持断开连接 |
| **提交 PR** | 解析 URL → 白名单正则 → 立即同步拉一次 → 入库 |
| **列表** | 按 `userId` 过滤，按 `UpdatedAt desc`，分页 |
| **详情** | 展开卡片显示 GitHub 返回的字段（title/state/author/labels/additions/deletions/changedFiles/reviewDecision/createdAt/mergedAt/htmlUrl） |
| **刷新单条** | 重新调 GitHub，更新 snapshot + lastRefreshedAt |
| **笔记** | Markdown 文本字段，失焦 PATCH，用户私有 |
| **删除** | 硬删（用户自己的记录） |

**V1 不做**：批量刷新、筛选、搜索、分享、协作笔记、PR 比较、diff 预览。

---

## 5. 技术架构

### 5.1 后端分层

```
Controllers/Api/
  PrReviewController.cs                  ~550 行（取代 1211 行的 PrReviewPrismController）

Services/PrReview/
  GitHubOAuthService.cs                  Device Flow: Start + Poll + 用户信息拉取
                                          + HMAC 签名 flow_token（无状态，多实例安全）
  GitHubPrClient.cs                      按 user token 查 PR，含 404 两步探测
  PrUrlParser.cs                         owner/repo/number 提取，含 SSRF 白名单
  PrReviewErrors.cs                      错误类型定义，映射到 HTTP + ErrorCode

Models/
  GitHubUserConnection.cs                每用户一条 OAuth 连接
  PrReviewItem.cs                        每条 PR 记录
  PrReviewSnapshot.cs                    嵌入 PrReviewItem 的 GitHub 字段集

Infrastructure/Database/
  MongoDbContext.cs                      新增 GitHubUserConnections, PrReviewItems 集合
```

### 5.2 应用身份

- `appKey = "pr-review"`（Controller 硬编码）
- 权限点：`pr-review.use`（取代 `pr-review-prism.use`）
- V2 与 V1 **并存过渡期极短**：V2 落地后立即拆除 V1 代码（一次性迁移）

### 5.3 数据模型

```csharp
// github_user_connections
public class GitHubUserConnection
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;     // PRD Agent 用户
    public string GitHubLogin { get; set; } = string.Empty;
    public string GitHubUserId { get; set; } = string.Empty;
    public string? AvatarUrl { get; set; }
    public string AccessTokenEncrypted { get; set; } = string.Empty;
    public string Scopes { get; set; } = string.Empty;      // 如 "repo,read:user"
    public DateTime ConnectedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastUsedAt { get; set; }
}

// pr_review_items
public class PrReviewItem
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;
    public string Owner { get; set; } = string.Empty;
    public string Repo { get; set; } = string.Empty;
    public int Number { get; set; }
    public string HtmlUrl { get; set; } = string.Empty;
    public string? Note { get; set; }
    public PrReviewSnapshot? Snapshot { get; set; }
    public DateTime? LastRefreshedAt { get; set; }
    public string? LastRefreshError { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class PrReviewSnapshot
{
    public string Title { get; set; } = string.Empty;
    public string State { get; set; } = "open";   // open/closed/merged
    public string AuthorLogin { get; set; } = string.Empty;
    public string? AuthorAvatarUrl { get; set; }
    public List<string> Labels { get; set; } = new();
    public int Additions { get; set; }
    public int Deletions { get; set; }
    public int ChangedFiles { get; set; }
    public string? ReviewDecision { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? MergedAt { get; set; }
    public DateTime? ClosedAt { get; set; }
    public string HeadSha { get; set; } = string.Empty;
}
```

> **索引策略**：`github_user_connections` 走 `(UserId)` 唯一索引；`pr_review_items` 走 `(UserId, UpdatedAt desc)` 和 `(UserId, Owner, Repo, Number)` 唯一索引防重复。按 `rule.no-auto-index.md`，索引创建由 DBA 手动执行，代码只保留定义作参考。

---

## 6. 接口设计

| Method | Path | 语义 |
|---|---|---|
| `GET`  | `/api/pr-review/auth/status`          | 返回 `{connected, login, avatarUrl, scopes, oauthConfigured}` |
| `POST` | `/api/pr-review/auth/device/start`    | 发起 Device Flow，返回 `{userCode, verificationUri, verificationUriComplete, intervalSeconds, expiresInSeconds, flowToken}` |
| `POST` | `/api/pr-review/auth/device/poll`     | body: `{flowToken}` → 轮询 GitHub，返回 `{status: 'pending' \| 'slow_down' \| 'expired' \| 'denied' \| 'done'}` |
| `DELETE` | `/api/pr-review/auth/connection`    | 断开连接（删除 row） |
| `POST` | `/api/pr-review/items`                | body: `{pullRequestUrl, note?}`，提交并同步拉一次 |
| `GET`  | `/api/pr-review/items?page=1&pageSize=20` | 分页列表 |
| `GET`  | `/api/pr-review/items/{id}`           | 单条详情 |
| `POST` | `/api/pr-review/items/{id}/refresh`   | 重新拉取 |
| `PATCH`| `/api/pr-review/items/{id}/note`      | body: `{note}` |
| `DELETE`| `/api/pr-review/items/{id}`          | 硬删 |

### 6.1 OAuth 配置项

```
环境变量:
  GitHubOAuth__ClientId     = <GitHub OAuth App 的 Client ID>
  GitHubOAuth__ClientSecret = <可选；Device Flow 对公有 OAuth App 可不填>
  GitHubOAuth__Scopes       = "repo,read:user"（默认值）
```

> **GitHub OAuth App 注册**：
> 1. 到 GitHub Settings → Developer settings → OAuth Apps 创建新应用
> 2. **勾选 "Enable Device Flow"** ✅（关键——否则 device_code 端点会 403）
> 3. **Callback URL 随便填一个**（例如 `https://example.com`）——Device Flow 不使用它，但 GitHub 表单必填
> 4. 复制 Client ID 注入到 `GitHubOAuth__ClientId`
> 5. 完成——本地/CDS/生产共用同一个 OAuth App，无需为动态域名做任何额外配置

### 6.2 Flow Token 防伪造

Device Flow 的 Start 阶段返回的 `flowToken` 是 HMAC 签名的 (device_code, userId, expiry) 三元组，
格式：`base64url(deviceCode|userId|expiryUnix|hmacHex)`，HMAC 用 `Jwt:Secret`（启动 fail-fast）。
Poll 时后端会：
1. 验证 HMAC 签名（`FixedTimeEquals` 防时序攻击）
2. 校验 `userId` 与当前登录用户一致
3. 校验 `expiryUnix` 未超时
4. 解出 `device_code` 向 GitHub 轮询

这种"签名令牌"模式完全无状态、无 session、多实例天然安全，`device_code` 从不出后端。

### 6.3 错误分类（消灭 404 歧义）

```
用户 Token 失效          → 401 GITHUB_TOKEN_EXPIRED
用户已断开 GitHub         → 412 GITHUB_NOT_CONNECTED
Device Flow 令牌无效/过期 → 403 DEVICE_FLOW_TOKEN_INVALID
Device Flow 超时(>15min)  → 408 DEVICE_FLOW_EXPIRED
用户拒绝授权              → 403 DEVICE_FLOW_ACCESS_DENIED
GitHub OAuth 未配置       → 503 GITHUB_OAUTH_NOT_CONFIGURED
URL 格式错                → 400 PR_URL_INVALID
owner/repo 不符合白名单   → 400 PR_URL_INVALID
两步探测：repo 404        → 404 GITHUB_REPO_NOT_VISIBLE（"仓库不存在或你无权访问"）
两步探测：repo 200 PR 404 → 404 PR_NUMBER_INVALID（"仓库可见但 PR 编号不存在"）
GitHub 403               → 403 GITHUB_FORBIDDEN
GitHub 429               → 429 GITHUB_RATE_LIMITED（返回 Reset header）
GitHub 5xx               → 502 GITHUB_UPSTREAM_ERROR
代码异常                 → 500 INTERNAL_ERROR
```

### 6.4 SSRF 防护

```csharp
private static readonly Regex OwnerRegex =
    new(@"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$");
private static readonly Regex RepoRegex =
    new(@"^[A-Za-z0-9._-]{1,100}$");
```

- HttpClient BaseAddress 固定为 `https://api.github.com/`
- 永不接受完整 URL 作为调用参数，只用 owner/repo/number 拼 path
- OAuth 回调 state 必须一次性匹配

---

## 7. 前端架构

### 7.1 组件拆分（取代 1781 行巨石）

```
src/pages/pr-review/
  PrReviewPage.tsx              ~120 行  主路由
  GitHubConnectCard.tsx         ~70 行   OAuth 连接状态
  AddPrForm.tsx                 ~70 行   URL 输入 + 提交
  PrItemList.tsx                ~90 行   列表 + 分页
  PrItemCard.tsx                ~140 行  详情卡 + 笔记编辑 + 刷新/删除
  usePrReviewStore.ts           ~80 行   Zustand, SSOT, 不用 localStorage

src/services/real/
  prReview.ts                   ~90 行   typed API client
```

### 7.2 状态管理

- **SSOT**：`store.items` 是唯一列表，`store.connection` 是唯一连接态
- **无 localStorage**：所有状态来自服务端 GET，浏览器关闭就结束
- **乐观 UI**：刷新/笔记保存走乐观更新，失败回滚

### 7.3 Device Flow 交互

```
[连接 GitHub] 按钮
    ↓
POST /api/pr-review/auth/device/start
    ← { userCode: "WDJB-MJHT", verificationUriComplete, flowToken, intervalSeconds: 5 }
    ↓
window.open(verificationUriComplete)  // 新 tab 打开 GitHub 授权页
    ↓
同时前端页面显示进度卡片：
    ┌─────────────────────────────────────┐
    │ 等待你在 GitHub 上授权...  (spinner) │
    │                                      │
    │ 授权码  [ W D J B - M J H T ]  [复制]│
    │                                      │
    │   [ 打开 GitHub 授权页 ]              │
    │                                      │
    │ 剩余 14:23                每 5 秒检测│
    │ ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
    └─────────────────────────────────────┘
    ↓
每 intervalSeconds 秒 POST /auth/device/poll { flowToken }
  ← pending  → 继续等
  ← slow_down → 间隔 +5 秒
  ← done     → 前端刷新 authStatus，切到已连接
  ← expired / denied → 显示错误，允许重新发起
```

**零复制粘贴、零 token 手动输入**——用户看到授权码，点按钮打开 GitHub，在 GitHub 页面确认授权码后点 Authorize，浏览器回到本页面时连接已自动建立。

---

## 8. 关联文档

- `rule.app-identity.md` — appKey 硬编码规范
- `rule.snapshot-fallback.md` — V2 存"最新快照 + 错误信息"，不做反规范化快照，规则 N/A
- `rule.no-localstorage.md` — 前端强制 sessionStorage；V2 干脆不做持久化
- `rule.server-authority.md` — OAuth token 刷新、GitHub 调用走 `CancellationToken.None`
- `rule.no-auto-index.md` — 新索引由 DBA 手动执行

---

## 9. 迁移与下线

### 9.1 老功能下线清单

| 待删 | 代替方案 |
|---|---|
| `PrReviewPrismController.cs` (1211 行) | `PrReviewController.cs`（新）|
| `GitHubPrReviewPrismService.cs` (501 行) | `GitHubPrClient.cs` + `PrUrlParser.cs`（新）|
| `PrReviewPrismSnapshotBuilder.cs` | 删除，MVP 不做反规范化快照 |
| `PrReviewPrismSubmission.cs` | `PrReviewItem.cs` + `GitHubUserConnection.cs`（新）|
| `AppSettings.PrReviewPrismGitHubTokenEncrypted` | 删除字段，Per-user OAuth 替代 |
| `AdminPermissionCatalog.PrReviewPrismUse` | `PrReviewUse` (pr-review.use) |
| `prd-admin/src/pages/pr-review-prism/*` (1781 行) | `prd-admin/src/pages/pr-review/*`（新）|
| `.github/pr-architect/*` 整个目录 | 独立仓（若需要） |
| 5 个 workflow + 5 个 Python 脚本 | 同上 |
| `scripts/bootstrap-pr-prism.sh` + `scripts/init-pr-prism-basis.sh` | 无需初始化 |
| `doc/guide.pr-prism-*.md` | 本文档 |

### 9.2 MongoDB 集合迁移

- `pr_review_prism_submissions` → **归档并删除**（V2 不读；若有生产数据，先由 DBA `renameCollection` 到 `_archived_pr_review_prism_submissions`）
- 新增 `github_user_connections`、`pr_review_items`

### 9.3 分阶段实施

| PR | 范围 | 可独立合并 |
|---|---|---|
| **PR-1（本次）** | 新增 Models + `PrUrlParser` + 单测 + 设计文档 + changelog | ✅ |
| **PR-2** | `GitHubOAuthService` + `GitHubPrClient` + Controller auth 端点 | ✅ |
| **PR-3** | Controller item 端点 + 集成测试 | ✅ |
| **PR-4** | 前端 6 个组件 + store + 服务层 | ✅ |
| **PR-5** | 删除旧 PrReviewPrism* 代码 + 归档集合 + 删除 PR Architect 目录 | ✅ |

每个 PR 落地后可独立跑冒烟测试，V1 和 V2 只在 PR-5 之前短暂共存。

---

## 10. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| OAuth Callback URL 与部署域名不匹配 | 中 | 无法连接 | 设计阶段即确定域名，OAuth App 注册时同步更新 |
| GitHub API 5000/hr 配额不够 | 低 | 批量场景抖动 | 单用户自有配额，V1 不做批量刷新 |
| 老数据迁移遗漏 | 低 | 丢笔记 | PR-5 前明确 DBA 验证归档 |
| GitHub token 泄漏（DB 被拿） | 低 | 严重 | `ApiKeyCrypto.Encrypt` + `Jwt:Secret` 强制非默认（启动 fail-fast） |
| OAuth state 被重放 | 低 | 账号混串 | 一次性 + TTL 60 秒 + 绑定 session |

---

## 11. 验收标准（MVP）

- [ ] 新用户首次打开页面：显示"连接 GitHub"按钮
- [ ] 点击 → 跳转 GitHub → 授权 → 回到页面，显示已连接状态与 GitHub login
- [ ] 粘贴公开仓 PR URL：卡片正确显示 title / author / state / additions / deletions
- [ ] 粘贴私有仓 PR（有权访问）：同上
- [ ] 粘贴私有仓 PR（无权访问）：返回 "仓库不可见" 而非 "PR 不存在"
- [ ] 粘贴错误编号：返回 "仓库可见但 PR 编号不存在"
- [ ] 粘贴非 GitHub URL：前端即时校验错误
- [ ] 笔记失焦后刷新页面：笔记仍在
- [ ] 断开连接后再进入：回到初始状态
- [ ] 前端无 localStorage 使用（grep 验证）
- [ ] 前端主页面 ≤ 200 行（行数校验）
- [ ] 后端 Controller ≤ 400 行
- [ ] 单元测试：URL 解析 10 条边界、错误分类 6 条、OAuth state 校验 3 条
