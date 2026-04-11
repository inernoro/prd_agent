using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services.PrReview;
using PrdAgent.Infrastructure.GitHub;
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
    private readonly IGitHubOAuthService _oauth;
    private readonly IGitHubClient _github;
    private readonly PrAlignmentService _alignment;
    private readonly PrSummaryService _summary;
    private readonly IConfiguration _config;
    private readonly ILogger<PrReviewController> _logger;

    public PrReviewController(
        MongoDbContext db,
        IGitHubOAuthService oauth,
        IGitHubClient github,
        PrAlignmentService alignment,
        PrSummaryService summary,
        IConfiguration config,
        ILogger<PrReviewController> logger)
    {
        _db = db;
        _oauth = oauth;
        _github = github;
        _alignment = alignment;
        _summary = summary;
        _config = config;
        _logger = logger;
    }

    // =========================================================
    // Section 1 — OAuth Device Flow (status / start / poll / disconnect)
    //
    // 设计：使用 GitHub Device Flow (RFC 8628) 而非 Web Flow。
    //   原因：本项目部署在 CDS 动态域名（<branch>.miduo.org），每条分支一个域名，
    //   而 GitHub OAuth Web Flow 要求 Callback URL 预先注册，不支持通配符。
    //   Device Flow 完全不需要 Callback，本地/CDS/生产共用一套代码。
    //   同一套 UX：用户点按钮 → 打开 GitHub 授权页 → 后端轮询拿 token。
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
    /// 发起 Device Flow：后端向 GitHub 请求 device_code，
    /// 返回 user_code 与 verification URL 供前端展示，flow_token 用于后续轮询。
    /// </summary>
    [HttpPost("auth/device/start")]
    [Authorize]
    public async Task<IActionResult> StartDeviceFlow(CancellationToken ct)
    {
        try
        {
            var userId = this.GetRequiredUserId();
            // 对外部 GitHub 请求走 CancellationToken.None：客户端断开不得中止授权启动
            var start = await _oauth.StartDeviceFlowAsync(userId, CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new
            {
                userCode = start.UserCode,
                verificationUri = start.VerificationUri,
                verificationUriComplete = start.VerificationUriComplete,
                intervalSeconds = start.IntervalSeconds,
                expiresInSeconds = start.ExpiresInSeconds,
                flowToken = start.FlowToken,
            }));
        }
        catch (GitHubException ex)
        {
            return MapException(ex);
        }
    }

    /// <summary>
    /// 轮询 Device Flow：验证 flow_token 后向 GitHub 查询授权结果。
    /// 前端按 intervalSeconds 节奏每次调一次本端点，直到返回 done / expired / denied。
    /// </summary>
    [HttpPost("auth/device/poll")]
    [Authorize]
    public async Task<IActionResult> PollDeviceFlow(
        [FromBody] PollDeviceFlowRequest req,
        CancellationToken ct)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.FlowToken))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "flowToken 不能为空"));
        }

        try
        {
            var userId = this.GetRequiredUserId();
            var result = await _oauth.PollDeviceFlowAsync(userId, req.FlowToken, CancellationToken.None);

            switch (result.Status)
            {
                case DeviceFlowPollStatus.Pending:
                    return Ok(ApiResponse<object>.Ok(new { status = "pending" }));

                case DeviceFlowPollStatus.SlowDown:
                    return Ok(ApiResponse<object>.Ok(new { status = "slow_down" }));

                case DeviceFlowPollStatus.Expired:
                    return Ok(ApiResponse<object>.Ok(new { status = "expired" }));

                case DeviceFlowPollStatus.Denied:
                    return Ok(ApiResponse<object>.Ok(new { status = "denied" }));

                case DeviceFlowPollStatus.Done:
                    await PersistConnectionAsync(userId, result.AccessToken!, result.Scope ?? string.Empty);
                    return Ok(ApiResponse<object>.Ok(new { status = "done" }));

                default:
                    return Ok(ApiResponse<object>.Ok(new { status = "pending" }));
            }
        }
        catch (GitHubException ex)
        {
            return MapException(ex);
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

    /// <summary>
    /// Device Flow 成功后，把 (login / avatar / token) upsert 到 github_user_connections。
    /// 单独抽出来方便两条路径（Start 后由 Poll 调用 / 未来如果加 refresh token 也调用）复用。
    /// </summary>
    private async Task PersistConnectionAsync(string userId, string accessToken, string scope)
    {
        var userInfo = await _oauth.FetchUserInfoAsync(accessToken, CancellationToken.None);

        var jwtSecret = _config["Jwt:Secret"] ?? throw new InvalidOperationException("Jwt:Secret missing");
        var encrypted = ApiKeyCrypto.Encrypt(accessToken, jwtSecret);

        var now = DateTime.UtcNow;
        var filter = Builders<GitHubUserConnection>.Filter.Eq(x => x.UserId, userId);
        var update = Builders<GitHubUserConnection>.Update
            .Set(x => x.UserId, userId)
            .Set(x => x.GitHubLogin, userInfo.Login)
            .Set(x => x.GitHubUserId, userInfo.Id.ToString())
            .Set(x => x.AvatarUrl, userInfo.AvatarUrl)
            .Set(x => x.AccessTokenEncrypted, encrypted)
            .Set(x => x.Scopes, scope)
            .Set(x => x.ConnectedAt, now)
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"));

        await _db.GitHubUserConnections.UpdateOneAsync(
            filter,
            update,
            new UpdateOptions { IsUpsert = true },
            CancellationToken.None);

        _logger.LogInformation("PrReview GitHub connected via device flow: user={UserId} login={Login}", userId, userInfo.Login);
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
        catch (GitHubException ex)
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
        catch (GitHubException ex)
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
    /// 返回 PR 的完整原始内容：PR 描述 body（未截断）+ 变更文件列表（含 diff patch）。
    /// 单独一个端点，避免把 100KB 级别的 files 塞进列表/详情接口拖慢常规路径。
    /// </summary>
    [HttpGet("items/{id}/raw")]
    [Authorize]
    public async Task<IActionResult> GetItemRaw(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var item = await _db.PrReviewItems
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync(ct);
        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail(PrReviewErrorCodes.PR_ITEM_NOT_FOUND, "PR 记录不存在或不属于你"));
        }
        if (item.Snapshot == null)
        {
            return BadRequest(ApiResponse<object>.Fail("SNAPSHOT_MISSING", "尚未拉取过 PR 内容，请先点击\"重新拉取\"。"));
        }

        var s = item.Snapshot;
        return Ok(ApiResponse<object>.Ok(new
        {
            title = s.Title,
            body = s.Body,
            state = s.State,
            authorLogin = s.AuthorLogin,
            authorAvatarUrl = s.AuthorAvatarUrl,
            additions = s.Additions,
            deletions = s.Deletions,
            changedFiles = s.ChangedFiles,
            headSha = s.HeadSha,
            htmlUrl = item.HtmlUrl,
            linkedIssueNumber = s.LinkedIssueNumber,
            linkedIssueTitle = s.LinkedIssueTitle,
            linkedIssueBody = s.LinkedIssueBody,
            files = s.Files.Select(f => new
            {
                filename = f.Filename,
                status = f.Status,
                additions = f.Additions,
                deletions = f.Deletions,
                patch = f.Patch,
            }),
        }));
    }

    /// <summary>
    /// 返回 PR 的 GitHub 审查历史。
    ///
    /// 两种调用模式：
    ///
    /// 1. 按 tab 懒加载（推荐，新 UI 用这种）：
    ///    GET /history?type=timeline&page=1&perPage=30
    ///    只拉取指定类型，返回 { type, page, perPage, hasMore, items }
    ///    单次 GitHub API 调用，实测 300-600ms
    ///
    /// 2. 一次性全量（向后兼容）：
    ///    GET /history
    ///    并行拉 6 个 endpoint，实测 2~3s，不推荐日常使用
    ///
    /// 不做服务端缓存：每次点击实时拉最新（SSOT 原则——审查时想看的是现在的样子）
    /// </summary>
    [HttpGet("items/{id}/history")]
    [Authorize]
    public async Task<IActionResult> GetItemHistory(
        string id,
        [FromQuery] string? type,
        [FromQuery] int page = 1,
        [FromQuery] int perPage = 30,
        CancellationToken ct = default)
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
        catch (GitHubException ex)
        {
            return MapException(ex);
        }

        try
        {
            if (!string.IsNullOrWhiteSpace(type))
            {
                // 懒加载单个 tab（快路径）
                var slice = await _github.FetchHistorySliceAsync(
                    accessToken,
                    item.Owner,
                    item.Repo,
                    item.Number,
                    item.Snapshot?.HeadSha,
                    type,
                    page,
                    perPage,
                    ct);
                return Ok(ApiResponse<object>.Ok(slice));
            }

            // 向后兼容：一次性全量
            var history = await _github.FetchHistoryAsync(
                accessToken,
                item.Owner,
                item.Repo,
                item.Number,
                item.Snapshot?.HeadSha,
                ct);
            return Ok(ApiResponse<object>.Ok(history));
        }
        catch (GitHubException ex)
        {
            return MapException(ex);
        }
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
        catch (GitHubException ex)
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
        catch (GitHubException ex)
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
    // Section 3 — AI（档 3：对齐度检查）
    //
    // 对比 PR 描述 vs 实际代码变更 + 关联 issue，输出 Markdown
    // 报告。走 ILlmGateway 流式（llm-gateway + llm-visibility 规则），
    // SSE 推送 phase / typing / result / error 四类事件。
    // =========================================================

    /// <summary>
    /// 读取 PR 记录最近一次的 AI 变更摘要。无则返回 null。
    /// </summary>
    [HttpGet("items/{id}/ai/summary")]
    [Authorize]
    public async Task<IActionResult> GetSummary(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var item = await _db.PrReviewItems
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync(ct);
        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail(PrReviewErrorCodes.PR_ITEM_NOT_FOUND, "PR 记录不存在或不属于你"));
        }
        return Ok(ApiResponse<object>.Ok(new { summary = item.SummaryReport }));
    }

    /// <summary>
    /// 读取 PR 记录最近一次的 AI 对齐度报告。无则返回 null。
    /// </summary>
    [HttpGet("items/{id}/ai/alignment")]
    [Authorize]
    public async Task<IActionResult> GetAlignment(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var item = await _db.PrReviewItems
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync(ct);
        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail(PrReviewErrorCodes.PR_ITEM_NOT_FOUND, "PR 记录不存在或不属于你"));
        }
        return Ok(ApiResponse<object>.Ok(new { alignment = item.AlignmentReport }));
    }

    /// <summary>
    /// 流式生成 PR 变更摘要（档 1）。事件协议与 alignment 相同。
    /// </summary>
    [HttpGet("items/{id}/ai/summary/stream")]
    [Authorize]
    [Produces("text/event-stream")]
    public async Task StreamSummary(string id, CancellationToken ct)
    {
        PrepareSseHeaders();
        var userId = this.GetRequiredUserId();

        var item = await EnsureSnapshotReadyAsync(id, userId, "总结");
        if (item == null) return;

        await WriteSseEventAsync("phase", new { phase = "analyzing", message = "AI 正在总结 PR 变更..." });

        var fullMd = new StringBuilder();
        var startMs = DateTime.UtcNow;
        var modelInfo = new PrReviewModelInfoHolder();

        try
        {
            await StreamLlmWithHeartbeatAsync(
                _summary.StreamSummaryAsync(item, modelInfo, CancellationToken.None),
                modelInfo,
                fullMd,
                waitingLabel: "AI 正在思考（大模型首字延迟较高，请稍候）");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PrReview summary stream failed");
            try { await WriteSseEventAsync("error", new { message = "AI 摘要生成失败：" + ex.Message }); }
            catch { /* 客户端已断 */ }

            await _db.PrReviewItems.UpdateOneAsync(
                x => x.Id == id && x.UserId == userId,
                Builders<PrReviewItem>.Update.Set(x => x.SummaryReport, new SummaryReport
                {
                    Markdown = fullMd.ToString(),
                    Model = modelInfo.Model,
                    Error = ex.Message,
                    CreatedAt = DateTime.UtcNow,
                    DurationMs = (long)(DateTime.UtcNow - startMs).TotalMilliseconds,
                }),
                cancellationToken: CancellationToken.None);
            return;
        }

        var markdown = fullMd.ToString();
        var duration = (long)(DateTime.UtcNow - startMs).TotalMilliseconds;

        // 防御空输出：LLM 返回空内容不应被当成"成功但空白"
        if (string.IsNullOrWhiteSpace(markdown))
        {
            var emptyMsg = "AI 返回了空的摘要内容，可能是模型调度失败或 prompt 被拒绝。请稍后重试。";
            _logger.LogWarning("PrReview summary empty result for item {Id}", id);
            await _db.PrReviewItems.UpdateOneAsync(
                x => x.Id == id && x.UserId == userId,
                Builders<PrReviewItem>.Update.Set(x => x.SummaryReport, new SummaryReport
                {
                    Markdown = string.Empty,
                    Model = modelInfo.Model,
                    Error = emptyMsg,
                    DurationMs = duration,
                    CreatedAt = DateTime.UtcNow,
                }),
                cancellationToken: CancellationToken.None);
            try { await WriteSseEventAsync("error", new { message = emptyMsg }); } catch { }
            return;
        }

        var headline = PrSummaryService.ParseHeadline(markdown);

        var report = new SummaryReport
        {
            Markdown = markdown,
            Headline = headline,
            Model = modelInfo.Model,
            DurationMs = duration,
            CreatedAt = DateTime.UtcNow,
            Error = null,
        };

        await _db.PrReviewItems.UpdateOneAsync(
            x => x.Id == id && x.UserId == userId,
            Builders<PrReviewItem>.Update
                .Set(x => x.SummaryReport, report)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        try
        {
            await WriteSseEventAsync("result", new { headline, markdown });
            await WriteSseEventAsync("phase", new { phase = "done", message = "摘要完成" });
        }
        catch { /* 客户端已断 */ }
    }

    /// <summary>
    /// 流式生成 PR 对齐度报告（档 3，SSE）。
    ///
    /// 事件协议：
    ///   event: phase   data: { phase: "preparing"|"fetching"|"analyzing"|"done", message: "..." }
    ///   event: typing  data: { text: "增量 markdown..." }
    ///   event: result  data: { score, summary, markdown }
    ///   event: error   data: { message, detail? }
    /// </summary>
    [HttpGet("items/{id}/ai/alignment/stream")]
    [Authorize]
    [Produces("text/event-stream")]
    public async Task StreamAlignment(string id, CancellationToken ct)
    {
        PrepareSseHeaders();
        var userId = this.GetRequiredUserId();

        var item = await EnsureSnapshotReadyAsync(id, userId, "对齐分析");
        if (item == null) return;

        await WriteSseEventAsync("phase", new { phase = "analyzing", message = "AI 正在对比描述与代码..." });

        var fullMd = new StringBuilder();
        var startMs = DateTime.UtcNow;
        var modelInfo = new PrReviewModelInfoHolder();

        try
        {
            await StreamLlmWithHeartbeatAsync(
                _alignment.StreamAlignmentAsync(item, modelInfo, CancellationToken.None),
                modelInfo,
                fullMd,
                waitingLabel: "AI 正在分析对齐度（大模型首字延迟较高，请稍候）");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PrReview alignment stream failed");
            try { await WriteSseEventAsync("error", new { message = "AI 对齐分析失败：" + ex.Message }); }
            catch { /* 客户端已断 */ }

            await _db.PrReviewItems.UpdateOneAsync(
                x => x.Id == id && x.UserId == userId,
                Builders<PrReviewItem>.Update.Set(x => x.AlignmentReport, new AlignmentReport
                {
                    Score = 0,
                    Markdown = fullMd.ToString(),
                    Model = modelInfo.Model,
                    Error = ex.Message,
                    CreatedAt = DateTime.UtcNow,
                    DurationMs = (long)(DateTime.UtcNow - startMs).TotalMilliseconds,
                }),
                cancellationToken: CancellationToken.None);
            return;
        }

        var markdown = fullMd.ToString();
        var duration = (long)(DateTime.UtcNow - startMs).TotalMilliseconds;

        // 防御空输出：LLM 返回空内容不应被当成"成功但空白"
        if (string.IsNullOrWhiteSpace(markdown))
        {
            var emptyMsg = "AI 返回了空的分析内容，可能是模型调度失败或 prompt 被拒绝。请稍后重试。";
            _logger.LogWarning("PrReview alignment empty result for item {Id}", id);
            await _db.PrReviewItems.UpdateOneAsync(
                x => x.Id == id && x.UserId == userId,
                Builders<PrReviewItem>.Update.Set(x => x.AlignmentReport, new AlignmentReport
                {
                    Score = 0,
                    Markdown = string.Empty,
                    Model = modelInfo.Model,
                    Error = emptyMsg,
                    DurationMs = duration,
                    CreatedAt = DateTime.UtcNow,
                }),
                cancellationToken: CancellationToken.None);
            try { await WriteSseEventAsync("error", new { message = emptyMsg }); } catch { }
            return;
        }

        var (score, summary) = PrAlignmentService.ParseAlignmentOutput(markdown);

        var report = new AlignmentReport
        {
            Score = score,
            Summary = summary,
            Markdown = markdown,
            Model = modelInfo.Model,
            DurationMs = duration,
            CreatedAt = DateTime.UtcNow,
            Error = null,
        };

        await _db.PrReviewItems.UpdateOneAsync(
            x => x.Id == id && x.UserId == userId,
            Builders<PrReviewItem>.Update
                .Set(x => x.AlignmentReport, report)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        try
        {
            await WriteSseEventAsync("result", new { score, summary, markdown });
            await WriteSseEventAsync("phase", new { phase = "done", message = "分析完成" });
        }
        catch { /* 客户端已断 */ }
    }

    /// <summary>
    /// 共享的 SSE 响应头设置。
    /// </summary>
    private void PrepareSseHeaders()
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no"; // nginx 禁缓冲
    }

    /// <summary>
    /// 取当前用户的 PR 记录，必要时刷新快照到 GitHub 最新（body + files + issue）。
    /// 返回 null 表示过程中已向 SSE 写过 error 事件，调用方直接 return 即可。
    /// </summary>
    private async Task<PrReviewItem?> EnsureSnapshotReadyAsync(string id, string userId, string actionLabel)
    {
        var item = await _db.PrReviewItems
            .Find(x => x.Id == id && x.UserId == userId)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (item == null)
        {
            await WriteSseEventAsync("error", new { message = "PR 记录不存在或不属于你", code = PrReviewErrorCodes.PR_ITEM_NOT_FOUND });
            return null;
        }

        await WriteSseEventAsync("phase", new { phase = "preparing", message = "正在准备上下文..." });

        // 如果当前快照没有 files 或 body（旧数据），尝试刷新一次拿全量
        if (item.Snapshot == null || item.Snapshot.Files.Count == 0 || string.IsNullOrEmpty(item.Snapshot.Body))
        {
            await WriteSseEventAsync("phase", new { phase = "fetching", message = "从 GitHub 拉取 PR 描述和文件变更..." });
            try
            {
                var accessToken = await ResolveUserTokenAsync(userId, CancellationToken.None);
                var fresh = await _github.FetchPullRequestAsync(
                    accessToken, item.Owner, item.Repo, item.Number, includeFilesAndIssue: true, CancellationToken.None);

                await _db.PrReviewItems.UpdateOneAsync(
                    x => x.Id == id && x.UserId == userId,
                    Builders<PrReviewItem>.Update
                        .Set(x => x.Snapshot, fresh)
                        .Set(x => x.LastRefreshedAt, DateTime.UtcNow)
                        .Set(x => x.LastRefreshError, (string?)null)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
                item.Snapshot = fresh;
            }
            catch (GitHubException ex)
            {
                await WriteSseEventAsync("error", new { message = ex.Message, code = ex.Code });
                return null;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "PrReview {Action}: failed to refresh snapshot", actionLabel);
                await WriteSseEventAsync("error", new { message = "拉取 PR 数据失败：" + ex.Message });
                return null;
            }
        }

        if (item.Snapshot == null || item.Snapshot.Files.Count == 0)
        {
            await WriteSseEventAsync("error", new
            {
                message = "无法拉取 PR 文件变更，可能是 GitHub API 限流或权限不足。请稍后再试。",
            });
            return null;
        }

        return item;
    }

    /// <summary>
    /// 写一个 SSE 事件：event: xxx + data: {json} + 空行 + flush。
    /// </summary>
    private async Task WriteSseEventAsync(string eventType, object data)
    {
        var json = System.Text.Json.JsonSerializer.Serialize(data, new System.Text.Json.JsonSerializerOptions
        {
            PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
        });
        await Response.WriteAsync($"event: {eventType}\ndata: {json}\n\n");
        await Response.Body.FlushAsync();
    }

    /// <summary>
    /// 流式消费 LLM 输出同时在首字到达前每 2 秒推送心跳 phase 事件。
    ///
    /// 为什么需要心跳：
    /// OpenRouter/硅基流动等上游在调用 qwen / deepseek-thinking 等推理模型时，
    /// 首字延迟（TTFT）可达 10~90 秒。这段时间 Gateway 既没有 Start chunk 也没有
    /// text chunk，Controller 如果什么都不写，前端会卡在"正在总结..."静态文案，
    /// 违反 rule.llm-visibility「禁止空白等待」原则。
    ///
    /// 为什么区分 Thinking 和 Text：
    /// 推理模型（qwen-thinking / deepseek-r1）先吐 reasoning_content 再吐正文。
    /// 只处理 Text chunk 会把几十秒思考当空白等待——这是前一版心跳规则漏解决的
    /// 真正根源：日志 firstByteAt 只有 1.8s，但 SSE 首字事件 52s，差值就是思考时长。
    /// 现在 Thinking 走独立的 SSE thinking 事件，前端展示在折叠面板里。
    ///
    /// 实现要点：
    /// - 后台任务每 2 秒发 phase=waiting 事件带 elapsed 秒数（没收到任何 chunk 时）
    /// - 收到第一个 delta（thinking 或 text 都算）时停心跳、发 phase=thinking/streaming
    /// - 所有 SSE 写入走 SemaphoreSlim 串行化，避免心跳和主循环的写入交织
    /// - Thinking chunk 不进 accumulator，只有 Text 才累积到最终 markdown
    ///
    /// 该方法在 finally 中保证清理 CancellationTokenSource + SemaphoreSlim，
    /// 并 await 心跳任务结束，避免孤儿后台任务继续尝试写入已关闭的 Response。
    /// </summary>
    private async Task StreamLlmWithHeartbeatAsync(
        IAsyncEnumerable<LlmStreamDelta> source,
        PrReviewModelInfoHolder modelInfo,
        StringBuilder accumulator,
        string waitingLabel)
    {
        using var heartbeatCts = new CancellationTokenSource();
        using var writeLock = new SemaphoreSlim(1, 1);
        var firstChunk = true;
        var sawText = false;
        var start = DateTime.UtcNow;

        async Task SafeWriteAsync(string eventType, object data)
        {
            await writeLock.WaitAsync();
            try { await WriteSseEventAsync(eventType, data); }
            finally { writeLock.Release(); }
        }

        // 心跳任务：首字到达前每 2 秒推送 phase 事件带 elapsed
        // 文案分级：
        //   <15s: "AI 正在思考 8s"（正常等待）
        //  15~40s: "上游首字延迟较高，已等待 20s（部分模型首字 30~60s）"
        //   ≥40s: "⚠️ 上游响应异常缓慢，已等待 45s，如仍无响应建议中止重试"
        // 之所以分级：是因为 qwen/qwen3.6-plus 这类 fake-streaming 模型的首字延迟
        // 可达 50s 以上，用户看同一条文案从 0 一直跳到 50 会以为卡死。
        Task RunHeartbeatAsync() => Task.Run(async () =>
        {
            try
            {
                while (!heartbeatCts.IsCancellationRequested)
                {
                    try { await Task.Delay(TimeSpan.FromSeconds(2), heartbeatCts.Token); }
                    catch (OperationCanceledException) { return; }
                    if (heartbeatCts.IsCancellationRequested) return;
                    var elapsed = (int)(DateTime.UtcNow - start).TotalSeconds;

                    string msg;
                    if (elapsed < 15)
                    {
                        msg = $"{waitingLabel}　{elapsed}s";
                    }
                    else if (elapsed < 40)
                    {
                        var modelHint = modelInfo.Model != null ? $"（{modelInfo.Model}）" : "";
                        msg = $"上游首字延迟较高{modelHint}，已等待 {elapsed}s，部分推理模型首字需 30~60s";
                    }
                    else
                    {
                        msg = $"⚠️ 上游响应异常缓慢，已等待 {elapsed}s，如仍无输出建议点击中止重试";
                    }

                    try
                    {
                        await SafeWriteAsync("phase", new
                        {
                            phase = "waiting",
                            message = msg,
                            elapsedMs = elapsed * 1000,
                        });
                    }
                    catch (ObjectDisposedException) { return; }
                    catch (OperationCanceledException) { return; }
                    catch { /* 心跳错误不能打断主流程 */ }
                }
            }
            catch { /* swallow */ }
        });

        var heartbeatTask = RunHeartbeatAsync();

        try
        {
            await foreach (var delta in source)
            {
                // 首次 chunk（thinking 或 text 都算）：停心跳
                if (firstChunk)
                {
                    firstChunk = false;
                    heartbeatCts.Cancel();
                    try { await heartbeatTask; } catch { /* ignore */ }
                    try
                    {
                        await SafeWriteAsync("phase", new
                        {
                            phase = delta.IsThinking ? "thinking" : "streaming",
                            message = delta.IsThinking ? "AI 正在思考…" : "AI 正在输出…",
                        });
                    }
                    catch (ObjectDisposedException) { return; }
                    catch (OperationCanceledException) { return; }
                }

                // 模型信息一旦被 Start chunk 填充，立即推给前端（只推一次）
                if (modelInfo.Captured)
                {
                    try
                    {
                        await SafeWriteAsync("model", new
                        {
                            model = modelInfo.Model,
                            platform = modelInfo.Platform,
                            modelGroupName = modelInfo.ModelGroupName,
                        });
                    }
                    catch (ObjectDisposedException) { return; }
                    catch (OperationCanceledException) { return; }
                    modelInfo.Captured = false;
                }

                if (delta.IsThinking)
                {
                    // 思考过程：走独立 thinking 事件，不进 accumulator
                    try
                    {
                        await SafeWriteAsync("thinking", new { text = delta.Content });
                    }
                    catch (ObjectDisposedException) { return; }
                    catch (OperationCanceledException) { return; }
                }
                else
                {
                    // 正式输出：从思考切换到正文时额外推一次 streaming 阶段事件
                    if (!sawText)
                    {
                        sawText = true;
                        try
                        {
                            await SafeWriteAsync("phase", new
                            {
                                phase = "streaming",
                                message = "AI 正在输出…",
                            });
                        }
                        catch (ObjectDisposedException) { return; }
                        catch (OperationCanceledException) { return; }
                    }

                    accumulator.Append(delta.Content);
                    try
                    {
                        await SafeWriteAsync("typing", new { text = delta.Content });
                    }
                    catch (ObjectDisposedException) { return; }
                    catch (OperationCanceledException) { return; }
                }
            }
        }
        finally
        {
            // 兜底：无论 source 正常结束、被 break、还是抛异常，心跳都必须停
            if (!heartbeatCts.IsCancellationRequested)
            {
                heartbeatCts.Cancel();
            }
            try { await heartbeatTask; } catch { /* ignore */ }
        }
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
            throw GitHubException.NotConnected();
        }

        var jwtSecret = _config["Jwt:Secret"] ?? throw new InvalidOperationException("Jwt:Secret missing");
        var token = ApiKeyCrypto.Decrypt(conn.AccessTokenEncrypted, jwtSecret);
        if (string.IsNullOrEmpty(token))
        {
            // 解密失败通常意味着 Jwt:Secret 变过，用户需要重新授权
            throw GitHubException.TokenExpired();
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

    private IActionResult MapException(GitHubException ex)
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
            body = item.Snapshot.Body,
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
            // 不回吐完整 files 列表（避免前端拿到 100KB 数据），只回吐统计
            fileCount = item.Snapshot.Files.Count,
            linkedIssueNumber = item.Snapshot.LinkedIssueNumber,
            linkedIssueTitle = item.Snapshot.LinkedIssueTitle,
        },
        alignmentReport = item.AlignmentReport == null ? null : new
        {
            score = item.AlignmentReport.Score,
            summary = item.AlignmentReport.Summary,
            markdown = item.AlignmentReport.Markdown,
            model = item.AlignmentReport.Model,
            durationMs = item.AlignmentReport.DurationMs,
            createdAt = item.AlignmentReport.CreatedAt,
            error = item.AlignmentReport.Error,
        },
        summaryReport = item.SummaryReport == null ? null : new
        {
            headline = item.SummaryReport.Headline,
            markdown = item.SummaryReport.Markdown,
            model = item.SummaryReport.Model,
            durationMs = item.SummaryReport.DurationMs,
            createdAt = item.SummaryReport.CreatedAt,
            error = item.SummaryReport.Error,
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

public sealed class PollDeviceFlowRequest
{
    public string FlowToken { get; set; } = string.Empty;
}
