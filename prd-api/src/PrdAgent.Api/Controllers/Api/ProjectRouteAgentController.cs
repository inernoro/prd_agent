using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.GitHub;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.ProjectRouteAgent;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 项目路由智能体（appKey: project-route-agent）
///
/// V2 (2026-05-26)：仓库登记表去除，分析阶段由 AI 直接从「公共站点说明 markdown + 用户方案 markdown」
/// 抽出涉及的应用 / 业务模块 / 仓库 git URL，再去 clone + 扫 routemap。
/// </summary>
[ApiController]
[Route("api/project-route-agent")]
[Authorize]
[AdminController("project-route-agent", AdminPermissionCatalog.ProjectRouteAgentUse)]
public class ProjectRouteAgentController : ControllerBase
{
    private const string AppKey = "project-route-agent";

    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly GitRepoCacheService _gitCache;
    private readonly IGitHubOAuthService _oauth;
    private readonly IConfiguration _config;
    private readonly ILogger<ProjectRouteAgentController> _logger;

    public ProjectRouteAgentController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        GitRepoCacheService gitCache,
        IGitHubOAuthService oauth,
        IConfiguration config,
        ILogger<ProjectRouteAgentController> logger)
    {
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _gitCache = gitCache;
        _oauth = oauth;
        _config = config;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    private string? GetDisplayName()
        => User.FindFirst("displayName")?.Value
           ?? User.FindFirst("name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value;

    private bool HasManagePermission()
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(AdminPermissionCatalog.ProjectRouteAgentManage)
               || permissions.Contains(AdminPermissionCatalog.Super);
    }

    /// <summary>
    /// 解析当前用户的 GitHub OAuth access token（复用 pr-review 的连接）。
    /// 返回 null 表示用户未授权 / token 失效 —— 此时 git clone 走匿名（公共仓库仍可拉，私有 / 组织仓库会 404）。
    /// </summary>
    private async Task<string?> ResolveGitHubTokenAsync(string userId, CancellationToken ct)
    {
        try
        {
            var conn = await _db.GitHubUserConnections
                .Find(x => x.UserId == userId)
                .FirstOrDefaultAsync(ct);
            if (conn == null || string.IsNullOrEmpty(conn.AccessTokenEncrypted))
                return null;
            var jwtSecret = _config["Jwt:Secret"];
            if (string.IsNullOrWhiteSpace(jwtSecret)) return null;
            var token = ApiKeyCrypto.Decrypt(conn.AccessTokenEncrypted, jwtSecret);
            return string.IsNullOrEmpty(token) ? null : token;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ProjectRouteAgent] resolve github token failed for user {UserId}", userId);
            return null;
        }
    }

    // ──────────────────────────────────────────────────────────────
    // GitHub Device Flow（项目路由智能体独立授权入口）
    //
    // 设计：用 RFC 8628 Device Flow，用户全程在本智能体页面内完成授权。
    //   不跳转到其他智能体的授权页。
    //   底层 token 仍存到共享的 `github_user_connections`（按 UserId 唯一），
    //   所以用户在本智能体授权后，其它共享同一份 OAuth 连接的智能体（如 pr-review）
    //   也能立即使用 —— 一次授权，全局可用。
    // ──────────────────────────────────────────────────────────────

    /// <summary>查询当前用户的 GitHub 授权状态。</summary>
    [HttpGet("github/status")]
    public async Task<IActionResult> GetGitHubStatus(CancellationToken ct)
    {
        var userId = GetUserId();
        var conn = await _db.GitHubUserConnections
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new
        {
            connected = conn != null && !string.IsNullOrEmpty(conn.AccessTokenEncrypted),
            oauthConfigured = IsOAuthConfigured(),
            githubLogin = conn?.GitHubLogin,
            avatarUrl = conn?.AvatarUrl,
            scopes = conn?.Scopes,
            connectedAt = conn?.ConnectedAt,
        }));
    }

    /// <summary>发起 Device Flow：返回用户码 + GitHub 输入页 URL + 轮询 token。</summary>
    [HttpPost("github/device/start")]
    public async Task<IActionResult> StartGitHubDeviceFlow(CancellationToken ct)
    {
        try
        {
            var userId = GetUserId();
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
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.Code, ex.Message));
        }
    }

    public class GitHubDevicePollRequest
    {
        public string? FlowToken { get; set; }
    }

    /// <summary>轮询 Device Flow：直到返回 done / expired / denied。done 时 token 已 upsert 到 DB。</summary>
    [HttpPost("github/device/poll")]
    public async Task<IActionResult> PollGitHubDeviceFlow([FromBody] GitHubDevicePollRequest req, CancellationToken ct)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.FlowToken))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "flowToken 不能为空"));
        }

        try
        {
            var userId = GetUserId();
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
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.Code, ex.Message));
        }
    }

    /// <summary>断开 GitHub 连接（删除 token 记录）。</summary>
    [HttpDelete("github/connection")]
    public async Task<IActionResult> DisconnectGitHub(CancellationToken ct)
    {
        var userId = GetUserId();
        var result = await _db.GitHubUserConnections.DeleteOneAsync(x => x.UserId == userId, ct);
        return Ok(ApiResponse<object>.Ok(new { deleted = result.DeletedCount > 0 }));
    }

    /// <summary>Device Flow 成功后，把 (login / avatar / token) upsert 到 github_user_connections。</summary>
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

        _logger.LogInformation("ProjectRouteAgent GitHub connected via device flow: user={UserId} login={Login}", userId, userInfo.Login);
    }

    private bool IsOAuthConfigured()
    {
        return !string.IsNullOrWhiteSpace(_config["GitHubOAuth:ClientId"])
            && !string.IsNullOrWhiteSpace(_config["GitHubOAuth:ClientSecret"]);
    }

    // ──────────────────────────────────────────────────────────────
    // 公共站点说明（管理员维护，全员可读用于展示来源）
    // ──────────────────────────────────────────────────────────────

    [HttpGet("site-spec")]
    public async Task<IActionResult> GetActiveSiteSpec(CancellationToken ct)
    {
        var spec = await _db.ProjectRouteSiteSpecs
            .Find(x => x.IsActive)
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { siteSpec = spec }));
    }

    public class UpsertSiteSpecRequest
    {
        public string? Title { get; set; }
        public string? MarkdownContent { get; set; }
    }

    /// <summary>
    /// 创建或更新公共站点说明（管理员）。同一时间只保留 1 条 IsActive=true。
    /// V2：仓库列表不再手填，由分析阶段 AI 从 MarkdownContent 里读取。管理员应在 md 里直接列出仓库 git URL。
    /// </summary>
    [HttpPost("site-spec")]
    public async Task<IActionResult> UpsertSiteSpec([FromBody] UpsertSiteSpecRequest req, CancellationToken ct)
    {
        if (!HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限维护公共站点说明"));

        if (req == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请求体为空"));
        if (string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "标题不能为空"));
        if (string.IsNullOrWhiteSpace(req.MarkdownContent))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "公共站点说明 Markdown 不能为空"));

        var userId = GetUserId();
        var now = DateTime.UtcNow;
        var existing = await _db.ProjectRouteSiteSpecs.Find(x => x.IsActive).FirstOrDefaultAsync(ct);

        if (existing != null)
        {
            existing.Title = req.Title.Trim();
            existing.MarkdownContent = req.MarkdownContent;
            existing.UpdatedAt = now;
            existing.UpdatedBy = userId;
            await _db.ProjectRouteSiteSpecs.ReplaceOneAsync(x => x.Id == existing.Id, existing, cancellationToken: CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new { siteSpec = existing, mode = "updated" }));
        }
        else
        {
            var spec = new ProjectRouteSiteSpec
            {
                Title = req.Title.Trim(),
                MarkdownContent = req.MarkdownContent,
                IsActive = true,
                CreatedBy = userId,
                UpdatedBy = userId,
                CreatedAt = now,
                UpdatedAt = now,
            };
            await _db.ProjectRouteSiteSpecs.InsertOneAsync(spec, cancellationToken: CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new { siteSpec = spec, mode = "created" }));
        }
    }

    // ──────────────────────────────────────────────────────────────
    // 方案 plans CRUD
    // ──────────────────────────────────────────────────────────────

    public class CreatePlanRequest
    {
        public string? Title { get; set; }
        public string? AttachmentId { get; set; }
    }

    [HttpPost("plans")]
    public async Task<IActionResult> CreatePlan([FromBody] CreatePlanRequest req, CancellationToken ct)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "方案标题不能为空"));
        if (string.IsNullOrWhiteSpace(req.AttachmentId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "attachmentId 不能为空"));

        var userId = GetUserId();
        var displayName = GetDisplayName() ?? userId;
        var normalizedTitle = req.Title.Trim();

        // 同一用户下方案标题不允许重复（按 trim 后比较）。
        // 主因：列表里全是同名「智能营销T3.1.11」会让用户分不清是哪个版本的分析。
        var duplicate = await _db.ProjectRoutePlans
            .Find(x => x.SubmitterId == userId && x.Title == normalizedTitle)
            .FirstOrDefaultAsync(ct);
        if (duplicate != null)
            return Conflict(ApiResponse<object>.Fail(ErrorCodes.PLAN_TITLE_DUPLICATE, $"方案标题「{normalizedTitle}」已存在，请换一个标题"));

        // 安全：必须限制只能用自己上传的 attachment 创建 plan。
        // 否则 attachmentId 一旦泄漏（UI / API 日志 / 邮件分享）任何登录用户都能
        // 把别人上传的 Markdown 内容复制成自己的 plan 读取（ExtractedText 会拷贝到 plan.ExtractedContent）。
        var attachment = await _db.Attachments
            .Find(x => x.AttachmentId == req.AttachmentId && x.UploaderId == userId)
            .FirstOrDefaultAsync(ct);
        if (attachment == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "附件不存在或不属于当前用户"));
        if (string.IsNullOrWhiteSpace(attachment.ExtractedText))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无法从文件中提取文本内容，请确认上传的是有效的 Markdown 文件"));

        var plan = new ProjectRoutePlan
        {
            SubmitterId = userId,
            SubmitterName = displayName,
            Title = normalizedTitle,
            AttachmentId = req.AttachmentId,
            FileName = attachment.FileName,
            ExtractedContent = attachment.ExtractedText,
            Status = ProjectRoutePlanStatuses.Queued,
        };
        await _db.ProjectRoutePlans.InsertOneAsync(plan, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { plan }));
    }

    [HttpGet("plans")]
    public async Task<IActionResult> ListMyPlans([FromQuery] int page = 1, [FromQuery] int pageSize = 50, CancellationToken ct = default)
    {
        var userId = GetUserId();
        var dbFilter = Builders<ProjectRoutePlan>.Filter.Eq(x => x.SubmitterId, userId);
        var total = await _db.ProjectRoutePlans.CountDocumentsAsync(dbFilter, cancellationToken: ct);
        var items = await _db.ProjectRoutePlans.Find(dbFilter)
            .SortByDescending(x => x.SubmittedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    [HttpGet("plans/{id}")]
    public async Task<IActionResult> GetPlan(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var plan = await _db.ProjectRoutePlans.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (plan == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "方案不存在"));
        if (plan.SubmitterId != userId && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权访问"));
        return Ok(ApiResponse<object>.Ok(new { plan }));
    }

    [HttpDelete("plans/{id}")]
    public async Task<IActionResult> DeletePlan(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var plan = await _db.ProjectRoutePlans.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (plan == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "方案不存在"));
        if (plan.SubmitterId != userId && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权删除"));

        await _db.ProjectRoutePlans.DeleteOneAsync(x => x.Id == id, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ──────────────────────────────────────────────────────────────
    // 分析（SSE 流式 — 内联模式）
    // ──────────────────────────────────────────────────────────────

    /// <summary>
    /// 触发分析。SSE 事件类型：
    ///   phase   { code, label, message }    — 阶段提示
    ///   model   { model, platform }          — AI 模型可见性
    ///   apps    { apps[], modules[], repos[] } — 第一步抽取结果（含 AI 推断的仓库列表）
    ///   repo    { appName, repoUrl, status, message?, files?, fileCount? } — 单仓库 clone/scan 进度
    ///   result  { resolutions[] }            — 路径匹配结果
    ///   done    { planId, model, platform }
    ///   error   { message }
    /// </summary>
    [HttpGet("plans/{id}/analyze/stream")]
    [Produces("text/event-stream")]
    public async Task AnalyzePlanStream(string id)
    {
        var userId = GetUserId();
        Response.Headers["Content-Type"] = "text/event-stream; charset=utf-8";
        Response.Headers["Cache-Control"] = "no-cache, no-transform";
        Response.Headers["X-Accel-Buffering"] = "no";

        // 互斥锁：心跳协程和业务流共享 Response.Body，写入必须串行化
        var writeLock = new SemaphoreSlim(1, 1);

        async Task WriteEvent(string evt, object data)
        {
            await writeLock.WaitAsync(CancellationToken.None);
            try
            {
                var json = JsonSerializer.Serialize(data, JsonOpts);
                var bytes = Encoding.UTF8.GetBytes($"event: {evt}\ndata: {json}\n\n");
                await Response.Body.WriteAsync(bytes, CancellationToken.None);
                await Response.Body.FlushAsync(CancellationToken.None);
            }
            catch (OperationCanceledException) { /* 客户端断开 */ }
            catch (ObjectDisposedException) { /* response 已关闭 */ }
            finally
            {
                try { writeLock.Release(); } catch { /* disposed */ }
            }
        }

        // SSE keepalive：服务端权威性原则要求长任务每 10s 发心跳，否则 nginx / CDN 的
        // 60s 默认 idle timeout 会断流。useSseStream hook 看到没 data 字段的注释行
        // (`: keepalive`) 会原样忽略，不影响业务事件分发。
        using var heartbeatCts = new CancellationTokenSource();
        var heartbeatTask = Task.Run(async () =>
        {
            var beat = Encoding.UTF8.GetBytes(": keepalive\n\n");
            while (!heartbeatCts.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(8), heartbeatCts.Token);
                }
                catch (OperationCanceledException) { break; }

                await writeLock.WaitAsync(CancellationToken.None);
                try
                {
                    await Response.Body.WriteAsync(beat, CancellationToken.None);
                    await Response.Body.FlushAsync(CancellationToken.None);
                }
                catch (OperationCanceledException) { break; }
                catch (ObjectDisposedException) { break; }
                catch (Exception) { /* response 已关闭 */ break; }
                finally
                {
                    try { writeLock.Release(); } catch { /* disposed */ }
                }
            }
        }, heartbeatCts.Token);

        try
        {

        var plan = await _db.ProjectRoutePlans.Find(x => x.Id == id).FirstOrDefaultAsync(CancellationToken.None);
        if (plan == null)
        {
            await WriteEvent("error", new { message = "方案不存在" });
            return;
        }
        if (plan.SubmitterId != userId && !HasManagePermission())
        {
            await WriteEvent("error", new { message = "无权分析此方案" });
            return;
        }
        if (string.IsNullOrWhiteSpace(plan.ExtractedContent))
        {
            await WriteEvent("error", new { message = "方案内容为空" });
            return;
        }

        var siteSpec = await _db.ProjectRouteSiteSpecs
            .Find(x => x.IsActive)
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (siteSpec == null || string.IsNullOrWhiteSpace(siteSpec.MarkdownContent))
        {
            await WriteEvent("error", new { message = "公共站点说明尚未配置，请联系管理员先上传一份说明 markdown" });
            return;
        }

        plan.Status = ProjectRoutePlanStatuses.Running;
        plan.StartedAt = DateTime.UtcNow;
        plan.SiteSpecId = siteSpec.Id;
        plan.ErrorMessage = null;
        await _db.ProjectRoutePlans.ReplaceOneAsync(x => x.Id == plan.Id, plan, cancellationToken: CancellationToken.None);

        await WriteEvent("phase", new { code = "loading", label = "加载方案和公共站点说明", message = "加载方案和公共站点说明" });

        try
        {
            // ===== 阶段 1：LLM 抽取 apps + modules + repos =====
            await WriteEvent("phase", new
            {
                code = "extracting",
                label = "AI 抽取方案涉及的应用 / 业务模块 / 仓库",
                message = "AI 抽取方案涉及的应用 / 业务模块 / 仓库",
            });

            var (apps, modules, repos, extractModel, extractPlatform) = await ExtractAppsAndReposAsync(plan, siteSpec, userId);
            plan.ExtractedApps = apps;
            plan.ExtractedModules = modules;
            plan.ExtractedRepos = repos;
            plan.Model = extractModel;
            plan.ModelPlatform = extractPlatform;
            await _db.ProjectRoutePlans.ReplaceOneAsync(x => x.Id == plan.Id, plan, cancellationToken: CancellationToken.None);

            if (!string.IsNullOrEmpty(extractModel))
                await WriteEvent("model", new { model = extractModel, platform = extractPlatform });
            await WriteEvent("apps", new { apps, modules, repos });

            if (repos.Count == 0)
            {
                await WriteEvent("error", new
                {
                    message = "AI 未能从公共站点说明 + 方案中识别出任何仓库 git URL。" +
                              "请管理员在公共说明 markdown 里明确写出仓库地址（如 'PRD 智能体: https://github.com/.../prd_agent.git'）。",
                });
                plan.Status = ProjectRoutePlanStatuses.Error;
                plan.ErrorMessage = "AI 未能从公共说明中抽出任何仓库地址";
                plan.CompletedAt = DateTime.UtcNow;
                await _db.ProjectRoutePlans.ReplaceOneAsync(x => x.Id == plan.Id, plan, cancellationToken: CancellationToken.None);
                return;
            }

            // ===== 阶段 2：克隆 AI 抽出的仓库 + 读 routemap 快照 =====
            // 解析当前用户的 GitHub OAuth token（共享 pr-review 的连接）；未授权 → null（仍尝试匿名 clone）
            var ghToken = await ResolveGitHubTokenAsync(userId, CancellationToken.None);
            var cloningLabel = $"克隆 {repos.Count} 个 AI 选中的仓库" + (ghToken != null ? "（已用 GitHub 授权）" : "（匿名，可能拉不了私有仓库）");
            await WriteEvent("phase", new { code = "cloning", label = cloningLabel, message = cloningLabel, hasGithubToken = ghToken != null });

            var repoSnapshots = new List<(ProjectRouteExtractedRepo Repo, RoutemapSnapshot? Snap, string? ErrorMessage)>();
            foreach (var entry in repos)
            {
                await WriteEvent("repo", new
                {
                    appName = entry.AppName,
                    repoUrl = entry.RepoUrl,
                    branch = entry.Branch,
                    status = "cloning",
                    message = "git clone --depth=1",
                });
                try
                {
                    var dir = await _gitCache.EnsureClonedAsync(entry.RepoUrl, entry.Branch, ghToken, CancellationToken.None);
                    var snap = _gitCache.ReadRoutemap(dir, entry.RoutemapPath);
                    repoSnapshots.Add((entry, snap, null));
                    await WriteEvent("repo", new
                    {
                        appName = entry.AppName,
                        repoUrl = entry.RepoUrl,
                        branch = entry.Branch,
                        status = snap.Missing == null ? "ok" : "missing",
                        message = snap.Missing,
                        files = snap.Entries.Take(50).Select(e => e.Path).ToList(),
                        fileCount = snap.Entries.Count,
                        foundLocations = snap.FoundLocations,
                    });
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[ProjectRouteAgent] clone failed: {Repo}@{Branch}", entry.RepoUrl, entry.Branch);
                    repoSnapshots.Add((entry, null, ex.Message));
                    await WriteEvent("repo", new
                    {
                        appName = entry.AppName,
                        repoUrl = entry.RepoUrl,
                        branch = entry.Branch,
                        status = "error",
                        message = ex.Message,
                    });
                }
            }

            // ===== 阶段 3：LLM 匹配 routemap 项目路径 =====
            await WriteEvent("phase", new
            {
                code = "matching",
                label = "AI 把应用/模块映射到 routemap 项目路径",
                message = "AI 把应用/模块映射到 routemap 项目路径",
            });

            var (resolutions, matchModel, matchPlatform) = await ResolveRoutemapAsync(plan, siteSpec, repoSnapshots, userId);

            if (!string.IsNullOrEmpty(matchModel) && string.IsNullOrEmpty(plan.Model))
            {
                plan.Model = matchModel;
                plan.ModelPlatform = matchPlatform;
            }
            if (!string.IsNullOrEmpty(matchModel))
                await WriteEvent("model", new { model = matchModel, platform = matchPlatform });

            plan.Resolutions = resolutions;
            plan.Status = ProjectRoutePlanStatuses.Done;
            plan.CompletedAt = DateTime.UtcNow;

            await WriteEvent("phase", new { code = "saving", label = "保存解析结果", message = "保存解析结果" });
            await _db.ProjectRoutePlans.ReplaceOneAsync(x => x.Id == plan.Id, plan, cancellationToken: CancellationToken.None);

            await WriteEvent("result", new { resolutions });
            await WriteEvent("done", new { planId = plan.Id, model = plan.Model, platform = plan.ModelPlatform });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[ProjectRouteAgent] analyze failed: {PlanId}", plan.Id);
            plan.Status = ProjectRoutePlanStatuses.Error;
            plan.ErrorMessage = ex.Message;
            plan.CompletedAt = DateTime.UtcNow;
            await _db.ProjectRoutePlans.ReplaceOneAsync(x => x.Id == plan.Id, plan, cancellationToken: CancellationToken.None);
            await WriteEvent("error", new { message = ex.Message });
        }

        }
        finally
        {
            // 无论早 return / 内层 catch / 正常完成都必须停心跳并等它退出，
            // 避免心跳协程在 response 关闭后还在尝试写。
            heartbeatCts.Cancel();
            try { await heartbeatTask; }
            catch (OperationCanceledException) { /* 预期 */ }
            catch (Exception ex) { _logger.LogDebug(ex, "[ProjectRouteAgent] heartbeat task ended with error"); }
        }
    }

    // ──────────────────────────────────────────────────────────────
    // LLM 内部逻辑
    // ──────────────────────────────────────────────────────────────

    private async Task<(List<string> apps, List<string> modules, List<ProjectRouteExtractedRepo> repos, string? model, string? platform)>
        ExtractAppsAndReposAsync(ProjectRoutePlan plan, ProjectRouteSiteSpec siteSpec, string userId)
    {
        const int maxPlanHeadChars = 4_000;
        const int maxSiteChars = 12_000;

        // 需求 ①：apps/modules **只读方案 md 文档头中的应用 / 业务模块章节原话**（不让 AI 拆解）。
        // - 扫描范围限定文档头部前 6000 字符（约 100~150 行），避免抓到正文中后段的同名章节
        // - 命中即用，原话直接进数组（不拆解、不改写、不缩写）
        // - 找不到对应章节才回退 LLM 兜底抽取
        const int planHeaderScanChars = 6_000;
        var (deterministicApps, deterministicModules) =
            MarkdownSectionExtractor.Extract(plan.ExtractedContent, planHeaderScanChars);
        var useDeterministicAppsModules = deterministicApps.Count > 0 || deterministicModules.Count > 0;

        var planHead = plan.ExtractedContent ?? string.Empty;
        if (planHead.Length > maxPlanHeadChars)
            planHead = planHead[..maxPlanHeadChars] + "\n…(只读文档头，正文部分已省略)";

        var siteContent = siteSpec.MarkdownContent ?? string.Empty;
        if (siteContent.Length > maxSiteChars)
            siteContent = siteContent[..maxSiteChars] + "\n…(公共说明已截断)";

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: planHead.Length + siteContent.Length,
            DocumentHash: null,
            SystemPromptRedacted: "project-route-agent.extract.apps",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.ProjectRouteAgent.Extract.Apps));

        // System prompt 根据是否已经有确定性 apps/modules 切两种模式
        string systemPrompt;
        if (useDeterministicAppsModules)
        {
            // 确定性命中 → AI 只负责输出 repos[]，apps/modules 直接照搬不再让 AI 改写
            systemPrompt =
                "你是「项目路由智能体」的方案分析助手。\n" +
                "本次任务：用户已在「方案 markdown」里明确列出了涉及的应用 / 业务模块章节（apps[]、modules[]），由系统解析后直接给你，**你不要改写、拆解、合并、扩展或翻译这些原话**。\n\n" +
                "你只需要做一件事：到「公共站点说明 markdown」里，按 apps[] / modules[] 查找它们对应的仓库 git URL。\n" +
                " - **只能从公共说明里出现过的 git URL 中挑选**，禁止编造、禁止猜测、禁止补全 owner\n" +
                " - **只能是 https://… 形式的 URL**，遇到 git@ / ssh:// 协议一律跳过\n" +
                " - 只挑跟 apps[] / modules[] 真正相关的，无关仓库不要带\n" +
                " - 默认 branch=main、routemapPath=routemap，除非公共说明里另写明\n" +
                " - 对每条仓库，**复制公共说明里命中它的原文段落到 `sourceContext` 字段（完整、不截断、不改写）**\n\n" +
                "严格只输出 **一个** JSON 对象，UTF-8，禁止 markdown 代码围栏，禁止解释：\n" +
                "{\n" +
                "  \"repos\": [\n" +
                "    {\n" +
                "      \"appName\": \"应用 / 仓库展示名\",\n" +
                "      \"repoUrl\": \"https://github.com/.../xxx.git\",\n" +
                "      \"branch\": \"main\",\n" +
                "      \"routemapPath\": \"routemap\",\n" +
                "      \"reasoning\": \"≤40 字中文，说明这个仓库对应的是 apps/modules 里哪些条目\",\n" +
                "      \"sourceContext\": \"公共说明里命中此仓库的原文段落，完整复制，不要截断\"\n" +
                "    }\n" +
                "  ]\n" +
                "}";
        }
        else
        {
            systemPrompt =
                "你是「项目路由智能体」的方案分析助手。按以下两步顺序产出结果：\n\n" +
                "【第一步】从「方案文档头」中读出涉及的应用 + 业务模块\n" +
                " - 输出 apps[]（应用 / 系统 / 智能体 / 产品线，3~10 项，去重）\n" +
                " - 输出 modules[]（业务模块 / 功能点 / 页面，3~15 项，去重）\n\n" +
                "【第二步】按上一步抽出的应用 / 模块，到「公共站点说明 markdown」里查找对应的仓库 git URL\n" +
                " - **只能从公共说明里出现过的 git URL 中挑选**，禁止编造、禁止猜测、禁止补全 owner\n" +
                " - **只能是 https://… 形式的 URL**，遇到 git@ / ssh:// 协议一律跳过\n" +
                " - 只挑跟 apps[] / modules[] 真正相关的，无关仓库不要带\n" +
                " - 默认 branch=main、routemapPath=routemap，除非公共说明里另写明\n" +
                " - 对每条仓库，**复制公共说明里命中它的原文段落到 `sourceContext` 字段（完整、不截断、不改写）**\n\n" +
                "严格只输出 **一个** JSON 对象，UTF-8，禁止 markdown 代码围栏，禁止解释：\n" +
                "{\n" +
                "  \"apps\": [\"...\"],\n" +
                "  \"modules\": [\"...\"],\n" +
                "  \"repos\": [\n" +
                "    {\n" +
                "      \"appName\": \"...\",\n" +
                "      \"repoUrl\": \"https://github.com/.../xxx.git\",\n" +
                "      \"branch\": \"main\",\n" +
                "      \"routemapPath\": \"routemap\",\n" +
                "      \"reasoning\": \"≤40 字中文\",\n" +
                "      \"sourceContext\": \"公共说明命中此仓库的原文段落，完整\"\n" +
                "    }\n" +
                "  ]\n" +
                "}";
        }

        var userMessage = new StringBuilder();
        userMessage.AppendLine("===== 公共站点说明（完整）=====");
        userMessage.AppendLine(siteContent);
        userMessage.AppendLine();
        userMessage.AppendLine("===== 用户方案（仅文档头）=====");
        userMessage.AppendLine($"标题：{plan.Title}");
        userMessage.AppendLine();
        userMessage.AppendLine("文档头内容：");
        userMessage.AppendLine(planHead);

        if (useDeterministicAppsModules)
        {
            userMessage.AppendLine();
            userMessage.AppendLine("===== 已确定的应用 / 业务模块（系统从方案 md 章节解析，原话，禁止修改）=====");
            userMessage.AppendLine("apps:");
            foreach (var a in deterministicApps) userMessage.AppendLine("  - " + a);
            userMessage.AppendLine("modules:");
            foreach (var m in deterministicModules) userMessage.AppendLine("  - " + m);
        }

        var body = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = userMessage.ToString() },
            },
            ["temperature"] = 0.2,
            ["max_tokens"] = 1600,
        };

        var resp = await _gateway.SendAsync(new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ProjectRouteAgent.Extract.Apps,
            ModelType = "chat",
            RequestBody = body,
            TimeoutSeconds = 180,
        }, CancellationToken.None);

        var model = string.IsNullOrEmpty(resp.Resolution?.ActualModel) ? null : resp.Resolution!.ActualModel;
        var platform = resp.Resolution?.ActualPlatformName;

        if (!resp.Success || string.IsNullOrWhiteSpace(resp.Content))
            throw new InvalidOperationException($"应用/模块/仓库抽取失败：{resp.ErrorMessage ?? "模型未返回内容"}");

        var apps = new List<string>();
        var modules = new List<string>();
        var repos = new List<ProjectRouteExtractedRepo>();

        try
        {
            var parsed = JsonNode.Parse(StripCodeFence(resp.Content!));
            if (parsed is JsonObject obj)
            {
                if (obj["apps"] is JsonArray arrA)
                    apps = arrA.Where(n => n != null).Select(n => n!.ToString().Trim())
                        .Where(s => s.Length > 0).Distinct().ToList();
                if (obj["modules"] is JsonArray arrM)
                    modules = arrM.Where(n => n != null).Select(n => n!.ToString().Trim())
                        .Where(s => s.Length > 0).Distinct().ToList();
                if (obj["repos"] is JsonArray arrR)
                {
                    foreach (var node in arrR)
                    {
                        if (node is not JsonObject ro) continue;
                        var url = ro["repoUrl"]?.GetValue<string>()?.Trim();
                        if (string.IsNullOrEmpty(url)) continue;
                        if (!url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                            && !url.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                        {
                            _logger.LogInformation("[ProjectRouteAgent] 跳过非 https 仓库 URL：{Url}", url);
                            continue;
                        }

                        repos.Add(new ProjectRouteExtractedRepo
                        {
                            AppName = ro["appName"]?.GetValue<string>()?.Trim() ?? url,
                            RepoUrl = url,
                            Branch = string.IsNullOrWhiteSpace(ro["branch"]?.GetValue<string>())
                                ? "main"
                                : ro["branch"]!.GetValue<string>().Trim(),
                            RoutemapPath = string.IsNullOrWhiteSpace(ro["routemapPath"]?.GetValue<string>())
                                ? "routemap"
                                : ro["routemapPath"]!.GetValue<string>().Trim(),
                            Reasoning = ro["reasoning"]?.GetValue<string>()?.Trim(),
                            SourceContext = ro["sourceContext"]?.GetValue<string>()?.Trim(),
                        });
                    }
                    repos = repos
                        .GroupBy(r => r.RepoUrl, StringComparer.OrdinalIgnoreCase)
                        .Select(g => g.First())
                        .ToList();
                }
            }
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"LLM 抽取结果不是合法 JSON：{ex.Message}");
        }

        // 确定性命中时，强制覆盖 apps/modules 用本地解析的原话（防止 LLM 偷偷改写）
        if (useDeterministicAppsModules)
        {
            apps = deterministicApps;
            modules = deterministicModules;
        }

        if (apps.Count == 0 && modules.Count == 0)
            throw new InvalidOperationException("AI 未能从方案中识别出任何应用或业务模块");

        return (apps, modules, repos, model, platform);
    }

    private async Task<(List<ProjectRouteResolution> resolutions, string? model, string? platform)>
        ResolveRoutemapAsync(
            ProjectRoutePlan plan,
            ProjectRouteSiteSpec siteSpec,
            IReadOnlyList<(ProjectRouteExtractedRepo Repo, RoutemapSnapshot? Snap, string? ErrorMessage)> snapshots,
            string userId)
    {
        // 把所有 snapshots（含 clone 失败 / no routemap 的）都做成基线 resolution，确保不漏。
        // LLM 只需要在「克隆成功 + 有 routemap 文件」的子集上填项目路径 + 关联到的 apps/modules。
        var baseline = snapshots.Select(t => new ProjectRouteResolution
        {
            RepoUrl = t.Repo.RepoUrl,
            RepoAppName = t.Repo.AppName,
            Reasoning = t.Repo.Reasoning,
            ProjectPaths = new List<string>(),
            MatchedAppsOrModules = new List<string>(),
            Status = t.ErrorMessage != null
                ? ProjectRouteResolutionStatuses.CloneFailed
                : (t.Snap == null || !string.IsNullOrEmpty(t.Snap.Missing)
                    ? ProjectRouteResolutionStatuses.NoRoutemap
                    : ProjectRouteResolutionStatuses.Hit),
        }).ToList();

        // 给失败 / 无 routemap 的条目把 reasoning 改成错误信息（覆盖 AI 的选仓库 reasoning）
        for (var i = 0; i < snapshots.Count; i++)
        {
            var (_, snap, err) = snapshots[i];
            if (err != null) baseline[i].Reasoning = $"git 操作失败：{Truncate(err, 200)}";
            else if (snap?.Missing != null) baseline[i].Reasoning = snap.Missing;
        }

        // 只把「Hit」状态的仓库交给 LLM 做路径匹配
        var matchable = snapshots
            .Select((t, idx) => (Index: idx, t.Repo, t.Snap, t.ErrorMessage))
            .Where(t => t.ErrorMessage == null && t.Snap != null && string.IsNullOrEmpty(t.Snap.Missing))
            .ToList();

        if (matchable.Count == 0)
        {
            // 无可匹配仓库 → 直接返回 baseline，跳过 LLM 调用
            return (baseline, null, null);
        }

        var repoBlocks = new StringBuilder();
        foreach (var (_, entry, snap, _) in matchable)
        {
            repoBlocks.AppendLine("---");
            repoBlocks.AppendLine($"RepoKey: {entry.RepoUrl}");
            repoBlocks.AppendLine($"AppName: {entry.AppName}");
            repoBlocks.AppendLine($"Branch: {entry.Branch}");
            repoBlocks.AppendLine($"RoutemapPath: {entry.RoutemapPath}");
            if (!string.IsNullOrEmpty(entry.Reasoning))
                repoBlocks.AppendLine($"AISelectedBecause: {entry.Reasoning}");
            if (snap!.FoundLocations.Count > 0)
            {
                repoBlocks.AppendLine($"FoundRoutemapDirs ({snap.FoundLocations.Count}): {string.Join(", ", snap.FoundLocations)}");
            }
            repoBlocks.AppendLine($"RoutemapFiles ({snap.Entries.Count}, 路径相对仓库根):");
            foreach (var e in snap.Entries.Take(120))
            {
                repoBlocks.AppendLine($"  - {e.Path} ({e.SizeBytes} bytes)");
                if (!string.IsNullOrWhiteSpace(e.ContentPreview))
                {
                    var preview = e.ContentPreview.Length > 600 ? e.ContentPreview[..600] + "…" : e.ContentPreview;
                    foreach (var line in preview.Split('\n').Take(20))
                        repoBlocks.AppendLine("      | " + line.TrimEnd());
                }
            }
        }

        var systemPrompt =
            "你是「项目路由智能体」的路径匹配助手。\n" +
            "任务：对每个仓库，输出它在 routemap/ 下命中的项目路径 + 命中了方案里哪些 apps/modules。\n\n" +
            "输入：\n" +
            " - 方案涉及的 apps[] 和 modules[]\n" +
            " - 已成功克隆的仓库列表（含 routemap 文件清单 + 内容预览）\n\n" +
            "请输出严格 JSON（**一个对象**，UTF-8，禁止 markdown 代码围栏，禁止解释）：\n" +
            "{\n" +
            "  \"repos\": [\n" +
            "    {\n" +
            "      \"repoUrl\": \"仓库 url（必须来自上面的 RepoKey）\",\n" +
            "      \"projectPaths\": [\"routemap 下的相对路径，0~10 个\"],\n" +
            "      \"matchedAppsOrModules\": [\"该仓库覆盖到的 apps/modules 原话，去重\"],\n" +
            "      \"reasoning\": \"≤80 字中文，简述这个仓库命中了什么\",\n" +
            "      \"status\": \"Hit | NotFound | Ambiguous\"\n" +
            "    }\n" +
            "  ]\n" +
            "}\n\n" +
            "规则：\n" +
            "- **输出按仓库分组**：每个仓库 1 条 resolution（即使该仓库命中 0 个项目路径也要给一条，status=NotFound）\n" +
            "- projectPaths 只能引用上面 RoutemapFiles 真实存在的相对路径\n" +
            "- matchedAppsOrModules 一定要从输入的 apps[]/modules[] 里挑，不要编造\n" +
            "- 多候选无法确定唯一时 status=Ambiguous，projectPaths 列全部候选\n" +
            "- 不要返回输入列表外的 repoUrl";

        var userBlock = new StringBuilder();
        userBlock.AppendLine($"方案标题：{plan.Title}");
        userBlock.AppendLine();
        userBlock.AppendLine("方案抽取出的应用：");
        foreach (var a in plan.ExtractedApps) userBlock.AppendLine("- " + a);
        userBlock.AppendLine();
        userBlock.AppendLine("方案抽取出的业务模块：");
        foreach (var m in plan.ExtractedModules) userBlock.AppendLine("- " + m);

        userBlock.AppendLine();
        userBlock.AppendLine("===== 已成功克隆的仓库 + routemap 文件清单 =====");
        userBlock.Append(repoBlocks);

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: userBlock.Length,
            DocumentHash: null,
            SystemPromptRedacted: "project-route-agent.resolve.routemap",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.ProjectRouteAgent.Resolve.RoutemapMatch));

        var body = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = userBlock.ToString() },
            },
            ["temperature"] = 0.15,
            ["max_tokens"] = 4000,
        };

        var resp = await _gateway.SendAsync(new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ProjectRouteAgent.Resolve.RoutemapMatch,
            ModelType = "chat",
            RequestBody = body,
            TimeoutSeconds = 180,
        }, CancellationToken.None);

        var model = string.IsNullOrEmpty(resp.Resolution?.ActualModel) ? null : resp.Resolution!.ActualModel;
        var platform = resp.Resolution?.ActualPlatformName;

        if (!resp.Success || string.IsNullOrWhiteSpace(resp.Content))
        {
            _logger.LogWarning("[ProjectRouteAgent] routemap LLM 匹配失败：{Err}", resp.ErrorMessage);
            EnrichResolutionsWithThirdPartyRepos(baseline, snapshots);
            return (baseline, model, platform);
        }

        MergeLlmIntoBaseline(resp.Content!, baseline);
        EnrichResolutionsWithThirdPartyRepos(baseline, snapshots);
        return (baseline, model, platform);
    }

    /// <summary>
    /// 对每条 Hit / Ambiguous 状态的 Resolution：
    ///   1. 取它命中的 routemap 文件（projectPaths + 整个仓库 routemap snapshot）
    ///   2. 扫 .md 文件内容里的 git URL，去重后写入 resolution.LinkedThirdPartyRepos
    ///   3. 保留命中文件的完整内容到 resolution.RoutemapFiles（前端「查看明细」用）
    /// </summary>
    private static void EnrichResolutionsWithThirdPartyRepos(
        List<ProjectRouteResolution> resolutions,
        IReadOnlyList<(ProjectRouteExtractedRepo Repo, RoutemapSnapshot? Snap, string? ErrorMessage)> snapshots)
    {
        var snapByUrl = snapshots.ToDictionary(s => s.Repo.RepoUrl, s => s, StringComparer.OrdinalIgnoreCase);

        foreach (var r in resolutions)
        {
            if (r.Status != ProjectRouteResolutionStatuses.Hit
                && r.Status != ProjectRouteResolutionStatuses.Ambiguous) continue;
            if (string.IsNullOrEmpty(r.RepoUrl)) continue;
            if (!snapByUrl.TryGetValue(r.RepoUrl, out var t)) continue;
            if (t.Snap == null) continue;

            // 优先扫命中的 projectPaths 对应的文件；如果没具体命中文件就扫整个 snapshot 的 .md
            var hitPaths = new HashSet<string>(r.ProjectPaths, StringComparer.OrdinalIgnoreCase);
            var mdFilesToScan = t.Snap.Entries
                .Where(e => e.Path.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
                .Where(e => hitPaths.Count == 0 || hitPaths.Contains(e.Path))
                .ToList();

            r.LinkedThirdPartyRepos = ThirdPartyRepoExtractor.Extract(
                mdFilesToScan.Select(e => (e.Path, e.ContentPreview)));

            r.RoutemapFiles = mdFilesToScan
                .Select(e => new ProjectRouteRoutemapFile
                {
                    Path = e.Path,
                    SizeBytes = e.SizeBytes,
                    Content = e.ContentPreview,
                })
                .ToList();
        }
    }

    /// <summary>
    /// LLM 输出按 repo 分组的 JSON，merge 回 baseline（按 RepoUrl 匹配）。
    /// baseline 里已有 CloneFailed / NoRoutemap 状态的条目不被 LLM 覆盖。
    /// </summary>
    private static void MergeLlmIntoBaseline(string content, List<ProjectRouteResolution> baseline)
    {
        JsonNode? parsed;
        try { parsed = JsonNode.Parse(StripCodeFence(content)); }
        catch { return; }
        if (parsed is not JsonObject obj) return;
        if (obj["repos"] is not JsonArray arr) return;

        var byUrl = baseline.ToDictionary(r => r.RepoUrl, r => r, StringComparer.OrdinalIgnoreCase);

        foreach (var node in arr)
        {
            if (node is not JsonObject o) continue;
            var url = o["repoUrl"]?.GetValue<string>()?.Trim();
            if (string.IsNullOrEmpty(url)) continue;
            if (!byUrl.TryGetValue(url, out var target)) continue;
            // 仓库克隆失败 / 无 routemap → 不让 LLM 改写其状态
            if (target.Status == ProjectRouteResolutionStatuses.CloneFailed
                || target.Status == ProjectRouteResolutionStatuses.NoRoutemap)
                continue;

            if (o["projectPaths"] is JsonArray pp)
            {
                target.ProjectPaths = pp.Where(p => p != null)
                    .Select(p => p!.ToString().Trim())
                    .Where(p => p.Length > 0)
                    .Distinct()
                    .ToList();
            }
            if (o["matchedAppsOrModules"] is JsonArray mm)
            {
                target.MatchedAppsOrModules = mm.Where(p => p != null)
                    .Select(p => p!.ToString().Trim())
                    .Where(p => p.Length > 0)
                    .Distinct()
                    .ToList();
            }
            target.Reasoning = o["reasoning"]?.GetValue<string>()?.Trim() ?? target.Reasoning;
            target.Status = NormalizeStatus(o["status"]?.GetValue<string>());
            // 路径 0 但 LLM 标 Hit → 自动降级为 NotFound，避免误导
            if (target.Status == ProjectRouteResolutionStatuses.Hit && target.ProjectPaths.Count == 0)
                target.Status = ProjectRouteResolutionStatuses.NotFound;
        }
    }

    private static string NormalizeStatus(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return ProjectRouteResolutionStatuses.Hit;
        return raw.Trim().ToLowerInvariant() switch
        {
            "notfound" or "not-found" or "not_found" or "miss" or "missing" => ProjectRouteResolutionStatuses.NotFound,
            "ambiguous" or "multi" or "multiple" => ProjectRouteResolutionStatuses.Ambiguous,
            "clonefailed" or "clone-failed" or "clone_failed" => ProjectRouteResolutionStatuses.CloneFailed,
            "noroutemap" or "no-routemap" or "no_routemap" => ProjectRouteResolutionStatuses.NoRoutemap,
            _ => ProjectRouteResolutionStatuses.Hit,
        };
    }

    private static string Truncate(string value, int limit)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        return value.Length <= limit ? value : value[..limit] + "...[truncated]";
    }

    private static string StripCodeFence(string s)
    {
        var t = s.Trim();
        if (t.StartsWith("```"))
        {
            var firstNl = t.IndexOf('\n');
            if (firstNl > 0) t = t[(firstNl + 1)..];
            if (t.EndsWith("```")) t = t[..^3];
        }
        return t.Trim();
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };
}
