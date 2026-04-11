using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services.PrReview;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// PR Review V2（pr-review）：基于每个用户自己的 GitHub OAuth 连接的 PR 审查工作台。
///
/// 路径约定：
///   GET    /api/pr-review/auth/status              — 当前用户是否已连接 GitHub
///   POST   /api/pr-review/auth/start               — 返回 GitHub authorize URL（前端跳转）
///   GET    /api/pr-review/auth/callback            — GitHub OAuth 回调（无需鉴权，靠 state）
///   DELETE /api/pr-review/auth/connection          — 断开 GitHub 连接
///   POST   /api/pr-review/items                    — 添加 PR 并立即拉取一次
///   GET    /api/pr-review/items                    — 列表分页
///   GET    /api/pr-review/items/{id}               — 单条详情
///   POST   /api/pr-review/items/{id}/refresh       — 重新拉取
///   PATCH  /api/pr-review/items/{id}/note          — 更新笔记
///   DELETE /api/pr-review/items/{id}               — 硬删
///
/// 所有写路径通过 userId 严格隔离，一个用户永远看不到别人的数据。
/// </summary>
[ApiController]
[Route("api/pr-review")]
[AdminController("pr-review", AdminPermissionCatalog.PrReviewUse)]
public sealed class PrReviewController : ControllerBase
{
    private const string AppKey = "pr-review";

    private readonly MongoDbContext _db;
    private readonly GitHubOAuthService _oauth;
    private readonly GitHubPrClient _github;
    private readonly IConfiguration _config;
    private readonly ILogger<PrReviewController> _logger;

    public PrReviewController(
        MongoDbContext db,
        GitHubOAuthService oauth,
        GitHubPrClient github,
        IConfiguration config,
        ILogger<PrReviewController> logger)
    {
        _db = db;
        _oauth = oauth;
        _github = github;
        _config = config;
        _logger = logger;
    }

    // =========================================================
    // Section 1 — OAuth (status / start / callback / disconnect)
    // =========================================================

    /// <summary>
    /// 查看当前用户的 GitHub 连接状态。
    /// </summary>
    [HttpGet("auth/status")]
    [Authorize]
    public async Task<IActionResult> GetAuthStatus(CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var conn = await _db.GitHubUserConnections
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync(ct);

        if (conn == null)
        {
            return Ok(ApiResponse<object>.Ok(new
            {
                connected = false,
                oauthConfigured = IsOAuthConfigured(),
                appKey = AppKey,
            }));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            connected = true,
            oauthConfigured = IsOAuthConfigured(),
            appKey = AppKey,
            login = conn.GitHubLogin,
            avatarUrl = conn.AvatarUrl,
            scopes = conn.Scopes,
            connectedAt = conn.ConnectedAt,
            lastUsedAt = conn.LastUsedAt,
        }));
    }

    /// <summary>
    /// 为当前用户生成 GitHub authorize URL。
    /// 前端拿到后执行 window.location.href = authorizeUrl 做整页跳转。
    /// </summary>
    [HttpPost("auth/start")]
    [Authorize]
    public IActionResult StartOAuth()
    {
        try
        {
            var userId = this.GetRequiredUserId();
            var callback = BuildCallbackUrl();
            var authorizeUrl = _oauth.BuildAuthorizeUrl(userId, callback);
            return Ok(ApiResponse<object>.Ok(new { authorizeUrl }));
        }
        catch (PrReviewException ex)
        {
            return MapException(ex);
        }
    }

    /// <summary>
    /// GitHub OAuth 回调：用 code 换 token，保存用户连接，302 回前端。
    /// 无需 [Authorize]：用 HMAC state 验证身份，避免依赖 session/cookie。
    /// </summary>
    [HttpGet("auth/callback")]
    [AllowAnonymous]
    public async Task<IActionResult> OAuthCallback(
        [FromQuery] string? code,
        [FromQuery] string? state,
        [FromQuery(Name = "error")] string? githubError,
        CancellationToken ct)
    {
        var frontendPath = _config["GitHubOAuth:FrontendReturnPath"] ?? "/admin/pr-review";
        var baseUrl = ResolveBaseUrl();

        if (!string.IsNullOrWhiteSpace(githubError))
        {
            return Redirect($"{baseUrl}{frontendPath}?connected=0&error={Uri.EscapeDataString(githubError!)}");
        }
        if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(state))
        {
            return Redirect($"{baseUrl}{frontendPath}?connected=0&error=missing_code_or_state");
        }

        string userId;
        try
        {
            userId = _oauth.ValidateStateAndGetUserId(state);
        }
        catch (PrReviewException ex)
        {
            _logger.LogWarning("PrReview OAuth state invalid: {Msg}", ex.Message);
            return Redirect($"{baseUrl}{frontendPath}?connected=0&error=state_invalid");
        }

        try
        {
            var callback = BuildCallbackUrl();
            // CancellationToken.None：客户端是 GitHub 跳转，断开不得中止换 token
            var tokenResp = await _oauth.ExchangeCodeAsync(code!, callback, CancellationToken.None);
            var userInfo = await _oauth.FetchUserInfoAsync(tokenResp.AccessToken, CancellationToken.None);

            var jwtSecret = _config["Jwt:Secret"] ?? throw new InvalidOperationException("Jwt:Secret missing");
            var encrypted = ApiKeyCrypto.Encrypt(tokenResp.AccessToken, jwtSecret);

            var now = DateTime.UtcNow;
            var filter = Builders<GitHubUserConnection>.Filter.Eq(x => x.UserId, userId);
            var update = Builders<GitHubUserConnection>.Update
                .Set(x => x.UserId, userId)
                .Set(x => x.GitHubLogin, userInfo.Login)
                .Set(x => x.GitHubUserId, userInfo.Id.ToString())
                .Set(x => x.AvatarUrl, userInfo.AvatarUrl)
                .Set(x => x.AccessTokenEncrypted, encrypted)
                .Set(x => x.Scopes, tokenResp.Scope ?? string.Empty)
                .Set(x => x.ConnectedAt, now)
                .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"));

            await _db.GitHubUserConnections.UpdateOneAsync(
                filter,
                update,
                new UpdateOptions { IsUpsert = true },
                CancellationToken.None);

            _logger.LogInformation("PrReview GitHub connected: user={UserId} login={Login}", userId, userInfo.Login);
            return Redirect($"{baseUrl}{frontendPath}?connected=1&login={Uri.EscapeDataString(userInfo.Login)}");
        }
        catch (PrReviewException ex)
        {
            _logger.LogWarning(ex, "PrReview OAuth exchange failed");
            return Redirect($"{baseUrl}{frontendPath}?connected=0&error={Uri.EscapeDataString(ex.Code)}");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PrReview OAuth callback unexpected failure");
            return Redirect($"{baseUrl}{frontendPath}?connected=0&error=internal_error");
        }
    }

    /// <summary>
    /// 断开当前用户的 GitHub 连接（删除存储的 token）。不影响已有 PR 记录。
    /// </summary>
    [HttpDelete("auth/connection")]
    [Authorize]
    public async Task<IActionResult> DisconnectGitHub(CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var result = await _db.GitHubUserConnections
            .DeleteOneAsync(x => x.UserId == userId, ct);
        return Ok(ApiResponse<object>.Ok(new { deleted = result.DeletedCount > 0 }));
    }

    // =========================================================
    // Section 2 — Items (CRUD + refresh + note)
    // =========================================================

    /// <summary>
    /// 提交一条 PR：解析 URL → 校验白名单 → 用用户 token 拉一次 → 入库。
    /// </summary>
    [HttpPost("items")]
    [Authorize]
    public async Task<IActionResult> CreateItem(
        [FromBody] CreatePrReviewItemRequest req,
        CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();

        if (req == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请求体不能为空"));
        }

        if (!PrUrlParser.TryParse(req.PullRequestUrl, out var parsed, out var parseError))
        {
            return BadRequest(ApiResponse<object>.Fail(PrReviewErrorCodes.PR_URL_INVALID, parseError ?? "PR URL 无效"));
        }

        // 唯一性检查
        var dupe = await _db.PrReviewItems
            .Find(x => x.UserId == userId
                && x.Owner == parsed!.Owner
                && x.Repo == parsed.Repo
                && x.Number == parsed.Number)
            .FirstOrDefaultAsync(ct);
        if (dupe != null)
        {
            return Conflict(ApiResponse<object>.Fail(PrReviewErrorCodes.PR_ITEM_DUPLICATE,
                "你已经添加过这条 PR，可以直接刷新"));
        }

        string accessToken;
        try
        {
            accessToken = await ResolveUserTokenAsync(userId, ct);
        }
        catch (PrReviewException ex)
        {
            return MapException(ex);
        }

        PrReviewSnapshot snapshot;
        string? lastError = null;
        try
        {
            snapshot = await _github.FetchPullRequestAsync(
                accessToken, parsed!.Owner, parsed.Repo, parsed.Number, CancellationToken.None);
        }
        catch (PrReviewException ex)
        {
            // 拉取失败：不拦截入库，入库一条 error 记录，让用户可以修笔记/重试
            _logger.LogInformation("PrReview fetch failed on create: {Code}", ex.Code);
            var failedItem = await InsertItemAsync(userId, parsed!, req.Note, snapshot: null, lastError: ex.Message, ct);
            // 写入后仍以错误形式返回，让前端展示提示但记录已在
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.Code, ex.Message));
        }

        var item = await InsertItemAsync(userId, parsed!, req.Note, snapshot, lastError, ct);
        await TouchLastUsedAsync(userId, ct);
        return Ok(ApiResponse<object>.Ok(Serialize(item)));
    }

    /// <summary>
    /// 分页列出当前用户的 PR 记录，按 UpdatedAt 倒序。
    /// </summary>
    [HttpGet("items")]
    [Authorize]
    public async Task<IActionResult> ListItems(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = this.GetRequiredUserId();

        if (page < 1) page = 1;
        if (pageSize < 1 || pageSize > 100) pageSize = 20;

        var filter = Builders<PrReviewItem>.Filter.Eq(x => x.UserId, userId);
        var total = await _db.PrReviewItems.CountDocumentsAsync(filter, cancellationToken: ct);

        var items = await _db.PrReviewItems
            .Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            page,
            pageSize,
            total,
            items = items.Select(Serialize),
        }));
    }

    /// <summary>
    /// 获取单条 PR 记录详情。
    /// </summary>
    [HttpGet("items/{id}")]
    [Authorize]
    public async Task<IActionResult> GetItem(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var item = await _db.PrReviewItems
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync(ct);
        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail(PrReviewErrorCodes.PR_ITEM_NOT_FOUND, "PR 记录不存在或不属于你"));
        }
        return Ok(ApiResponse<object>.Ok(Serialize(item)));
    }

    /// <summary>
    /// 重新拉取：用用户 token 查 GitHub，更新快照与 lastRefreshedAt。
    /// </summary>
    [HttpPost("items/{id}/refresh")]
    [Authorize]
    public async Task<IActionResult> RefreshItem(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var item = await _db.PrReviewItems
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync(ct);
        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail(PrReviewErrorCodes.PR_ITEM_NOT_FOUND, "PR 记录不存在或不属于你"));
        }

        string accessToken;
        try
        {
            accessToken = await ResolveUserTokenAsync(userId, ct);
        }
        catch (PrReviewException ex)
        {
            return MapException(ex);
        }

        try
        {
            var snapshot = await _github.FetchPullRequestAsync(
                accessToken, item.Owner, item.Repo, item.Number, CancellationToken.None);
            var now = DateTime.UtcNow;

            await _db.PrReviewItems.UpdateOneAsync(
                x => x.Id == id && x.UserId == userId,
                Builders<PrReviewItem>.Update
                    .Set(x => x.Snapshot, snapshot)
                    .Set(x => x.LastRefreshedAt, now)
                    .Set(x => x.LastRefreshError, null)
                    .Set(x => x.UpdatedAt, now),
                cancellationToken: CancellationToken.None);

            item.Snapshot = snapshot;
            item.LastRefreshedAt = now;
            item.LastRefreshError = null;
            item.UpdatedAt = now;
            await TouchLastUsedAsync(userId, ct);
            return Ok(ApiResponse<object>.Ok(Serialize(item)));
        }
        catch (PrReviewException ex)
        {
            await _db.PrReviewItems.UpdateOneAsync(
                x => x.Id == id && x.UserId == userId,
                Builders<PrReviewItem>.Update
                    .Set(x => x.LastRefreshError, ex.Message)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
            return MapException(ex);
        }
    }

    /// <summary>
    /// 更新笔记（Markdown 文本）。
    /// </summary>
    [HttpPatch("items/{id}/note")]
    [Authorize]
    public async Task<IActionResult> UpdateNote(
        string id,
        [FromBody] UpdatePrReviewNoteRequest req,
        CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();

        if (req == null)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请求体不能为空"));
        }

        var note = req.Note;
        if (note != null && note.Length > 20000)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "笔记长度不能超过 20000 字"));
        }

        var result = await _db.PrReviewItems.UpdateOneAsync(
            x => x.Id == id && x.UserId == userId,
            Builders<PrReviewItem>.Update
                .Set(x => x.Note, note)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        if (result.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(PrReviewErrorCodes.PR_ITEM_NOT_FOUND, "PR 记录不存在或不属于你"));
        }

        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>
    /// 硬删一条 PR 记录。
    /// </summary>
    [HttpDelete("items/{id}")]
    [Authorize]
    public async Task<IActionResult> DeleteItem(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var result = await _db.PrReviewItems
            .DeleteOneAsync(x => x.Id == id && x.UserId == userId, ct);
        if (result.DeletedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(PrReviewErrorCodes.PR_ITEM_NOT_FOUND, "PR 记录不存在或不属于你"));
        }
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // =========================================================
    // Helpers
    // =========================================================

    private async Task<PrReviewItem> InsertItemAsync(
        string userId,
        PrUrlParseResult parsed,
        string? note,
        PrReviewSnapshot? snapshot,
        string? lastError,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var item = new PrReviewItem
        {
            UserId = userId,
            Owner = parsed.Owner,
            Repo = parsed.Repo,
            Number = parsed.Number,
            HtmlUrl = parsed.HtmlUrl,
            Note = note,
            Snapshot = snapshot,
            LastRefreshedAt = snapshot != null ? now : null,
            LastRefreshError = lastError,
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.PrReviewItems.InsertOneAsync(item, cancellationToken: ct);
        return item;
    }

    private async Task<string> ResolveUserTokenAsync(string userId, CancellationToken ct)
    {
        var conn = await _db.GitHubUserConnections
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync(ct);
        if (conn == null || string.IsNullOrEmpty(conn.AccessTokenEncrypted))
        {
            throw PrReviewException.NotConnected();
        }

        var jwtSecret = _config["Jwt:Secret"] ?? throw new InvalidOperationException("Jwt:Secret missing");
        var token = ApiKeyCrypto.Decrypt(conn.AccessTokenEncrypted, jwtSecret);
        if (string.IsNullOrEmpty(token))
        {
            // 解密失败通常意味着 Jwt:Secret 变过，用户需要重新授权
            throw PrReviewException.TokenExpired();
        }
        return token;
    }

    private async Task TouchLastUsedAsync(string userId, CancellationToken ct)
    {
        await _db.GitHubUserConnections.UpdateOneAsync(
            x => x.UserId == userId,
            Builders<GitHubUserConnection>.Update.Set(x => x.LastUsedAt, DateTime.UtcNow),
            cancellationToken: ct);
    }

    private bool IsOAuthConfigured()
    {
        return !string.IsNullOrWhiteSpace(_config["GitHubOAuth:ClientId"])
            && !string.IsNullOrWhiteSpace(_config["GitHubOAuth:ClientSecret"]);
    }

    /// <summary>
    /// 解析外部可访问的 base URL，支持反向代理（X-Forwarded-Host / X-Forwarded-Proto）。
    /// </summary>
    private string ResolveBaseUrl()
    {
        var forwardedHost = Request.Headers["X-Forwarded-Host"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(forwardedHost))
        {
            var scheme = Request.Headers["X-Forwarded-Proto"].FirstOrDefault() ?? "https";
            return $"{scheme}://{forwardedHost.Split(',')[0].Trim()}";
        }
        return $"{Request.Scheme}://{Request.Host}";
    }

    private string BuildCallbackUrl()
    {
        var configured = _config["GitHubOAuth:CallbackUrl"];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured!;
        }
        return $"{ResolveBaseUrl()}/api/pr-review/auth/callback";
    }

    private IActionResult MapException(PrReviewException ex)
    {
        _logger.LogInformation("PrReview domain error: {Code} {Message}", ex.Code, ex.Message);
        return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.Code, ex.Message));
    }

    private static object Serialize(PrReviewItem item) => new
    {
        id = item.Id,
        owner = item.Owner,
        repo = item.Repo,
        number = item.Number,
        htmlUrl = item.HtmlUrl,
        note = item.Note,
        snapshot = item.Snapshot == null ? null : new
        {
            title = item.Snapshot.Title,
            state = item.Snapshot.State,
            authorLogin = item.Snapshot.AuthorLogin,
            authorAvatarUrl = item.Snapshot.AuthorAvatarUrl,
            labels = item.Snapshot.Labels,
            additions = item.Snapshot.Additions,
            deletions = item.Snapshot.Deletions,
            changedFiles = item.Snapshot.ChangedFiles,
            reviewDecision = item.Snapshot.ReviewDecision,
            createdAt = item.Snapshot.CreatedAt,
            mergedAt = item.Snapshot.MergedAt,
            closedAt = item.Snapshot.ClosedAt,
            headSha = item.Snapshot.HeadSha,
        },
        lastRefreshedAt = item.LastRefreshedAt,
        lastRefreshError = item.LastRefreshError,
        createdAt = item.CreatedAt,
        updatedAt = item.UpdatedAt,
    };
}

// ===== Request DTOs =====

public sealed class CreatePrReviewItemRequest
{
    public string PullRequestUrl { get; set; } = string.Empty;
    public string? Note { get; set; }
}

public sealed class UpdatePrReviewNoteRequest
{
    public string? Note { get; set; }
}
