using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.GitHub;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 共用的 GitHub 账号连接中心（per-user Device Flow）。
///
/// 任何登录用户都能连自己的 GitHub —— 不需要管理员权限位，因为连的是**他自己的**账号、
/// token 只加密存在他自己名下，能看到什么仓库完全由 GitHub 那边决定。
///
/// 端点分两类：
///   auth/*      —— 连接生命周期（状态 / 发起 / 轮询 / 断开）
///   仓库读取     —— repositories / branches / tree / doc-directories
///
/// 判定逻辑全在 <see cref="GitHubUserConnectionService"/>，本 Controller 只做 HTTP 翻译。
/// 老的 /api/pr-review/auth/*、/api/tech-doc-format-agent/github/* 仍在（前端未迁），
/// 它们和这里读写的是同一张 github_user_connections 表，连一次处处可用。
/// </summary>
[ApiController]
[Route("api/github")]
[Authorize]
public sealed class GitHubConnectController : ControllerBase
{
    private readonly GitHubUserConnectionService _connections;
    private readonly IGitHubOAuthService _oauth;
    private readonly ILogger<GitHubConnectController> _logger;

    public GitHubConnectController(
        GitHubUserConnectionService connections,
        IGitHubOAuthService oauth,
        ILogger<GitHubConnectController> logger)
    {
        _connections = connections;
        _oauth = oauth;
        _logger = logger;
    }

    /// <summary>当前用户的 GitHub 连接状态（未连接也是 200，前端据此决定显示"去连接"还是"已连接"）。</summary>
    [HttpGet("auth/status")]
    public async Task<IActionResult> GetStatus(CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var conn = await _connections.GetConnectionAsync(userId, ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            connected = conn != null,
            oauthConfigured = _connections.IsOAuthConfigured(),
            login = conn?.GitHubLogin,
            avatarUrl = conn?.AvatarUrl,
            scopes = conn?.Scopes,
            connectedAt = conn?.ConnectedAt,
            lastUsedAt = conn?.LastUsedAt,
        }));
    }

    /// <summary>发起 Device Flow：返回给用户看的 user_code 和验证地址。</summary>
    [HttpPost("auth/device/start")]
    public async Task<IActionResult> StartDeviceFlow()
    {
        try
        {
            var userId = this.GetRequiredUserId();
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

    /// <summary>轮询 Device Flow 结果；done 时连接已落库。</summary>
    [HttpPost("auth/device/poll")]
    public async Task<IActionResult> PollDeviceFlow([FromBody] GitHubDeviceFlowPollRequest? req)
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
                    var info = await _connections.PersistConnectionAsync(
                        userId, result.AccessToken!, result.Scope ?? string.Empty, CancellationToken.None);
                    return Ok(ApiResponse<object>.Ok(new { status = "done", login = info.Login, avatarUrl = info.AvatarUrl }));
                default:
                    return Ok(ApiResponse<object>.Ok(new { status = "pending" }));
            }
        }
        catch (GitHubException ex)
        {
            return MapException(ex);
        }
    }

    /// <summary>断开连接（删除本用户的 token；已建立的同步订阅会在下次同步时报"需要重新授权"）。</summary>
    [HttpDelete("auth/connection")]
    public async Task<IActionResult> Disconnect(CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var removed = await _connections.DisconnectAsync(userId, ct);
        return Ok(ApiResponse<object>.Ok(new { removed }));
    }

    /// <summary>当前用户可访问的仓库（含私有仓，取决于授权 scope）。</summary>
    [HttpGet("repositories")]
    public async Task<IActionResult> ListRepositories(
        [FromQuery] string? query,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 30,
        CancellationToken ct = default)
    {
        try
        {
            var userId = this.GetRequiredUserId();
            var token = await _connections.ResolveTokenAsync(userId, ct);
            var items = await _connections.ListRepositoriesAsync(token, query, page, pageSize, ct);
            await _connections.TouchLastUsedAsync(userId, ct);

            return Ok(ApiResponse<object>.Ok(new
            {
                items,
                page = Math.Max(1, page),
                pageSize,
                hasMore = items.Count >= pageSize,
            }));
        }
        catch (GitHubException ex)
        {
            return MapException(ex);
        }
    }

    /// <summary>仓库分支列表。</summary>
    [HttpGet("branches")]
    public async Task<IActionResult> ListBranches(
        [FromQuery] string owner,
        [FromQuery] string repo,
        CancellationToken ct = default)
    {
        if (!PrUrlParser.IsSafeOwnerRepo(owner, repo))
        {
            return BadRequest(ApiResponse<object>.Fail(GitHubErrorCodes.PR_URL_INVALID, "owner/repo 含非法字符"));
        }

        try
        {
            var userId = this.GetRequiredUserId();
            var token = await _connections.ResolveTokenAsync(userId, ct);
            var branches = await _connections.ListBranchesAsync(token, owner, repo, ct);
            await _connections.TouchLastUsedAsync(userId, ct);
            return Ok(ApiResponse<object>.Ok(new { owner, repo, items = branches }));
        }
        catch (GitHubException ex)
        {
            return MapException(ex);
        }
    }

    /// <summary>单层目录内容（自由浏览用；勾选默认值走 doc-directories）。</summary>
    [HttpGet("tree")]
    public async Task<IActionResult> GetTree(
        [FromQuery] string owner,
        [FromQuery] string repo,
        [FromQuery] string? path,
        [FromQuery] string? branch,
        CancellationToken ct = default)
    {
        if (!PrUrlParser.IsSafeOwnerRepo(owner, repo))
        {
            return BadRequest(ApiResponse<object>.Fail(GitHubErrorCodes.PR_URL_INVALID, "owner/repo 含非法字符"));
        }

        try
        {
            var userId = this.GetRequiredUserId();
            var token = await _connections.ResolveTokenAsync(userId, ct);
            var items = await _connections.ListDirectoryAsync(token, owner, repo, path, branch, ct);
            await _connections.TouchLastUsedAsync(userId, ct);
            return Ok(ApiResponse<object>.Ok(new
            {
                owner,
                repo,
                path = (path ?? string.Empty).Trim().Trim('/'),
                branch,
                items,
            }));
        }
        catch (GitHubException ex)
        {
            return MapException(ex);
        }
    }

    /// <summary>
    /// 扫描整个仓库的目录，返回可勾选清单 + 默认预勾选路径（所有 doc / docs 目录，递归）。
    /// 一次 Git Trees API 拿全量，避免逐层点开时的多次往返。
    /// </summary>
    [HttpGet("doc-directories")]
    public async Task<IActionResult> ScanDocDirectories(
        [FromQuery] string owner,
        [FromQuery] string repo,
        [FromQuery] string? branch,
        CancellationToken ct = default)
    {
        if (!PrUrlParser.IsSafeOwnerRepo(owner, repo))
        {
            return BadRequest(ApiResponse<object>.Fail(GitHubErrorCodes.PR_URL_INVALID, "owner/repo 含非法字符"));
        }

        try
        {
            var userId = this.GetRequiredUserId();
            var token = await _connections.ResolveTokenAsync(userId, ct);
            var scan = await _connections.ScanDirectoriesAsync(token, owner, repo, branch, ct);
            await _connections.TouchLastUsedAsync(userId, ct);

            return Ok(ApiResponse<object>.Ok(new
            {
                scan.Owner,
                scan.Repo,
                scan.Branch,
                scan.Truncated,
                scan.TotalDirectories,
                directories = scan.Directories,
                recommendedPaths = scan.RecommendedPaths,
            }));
        }
        catch (GitHubException ex)
        {
            return MapException(ex);
        }
    }

    private IActionResult MapException(GitHubException ex)
    {
        _logger.LogInformation("[GitHubConnect] error {Code}: {Message}", ex.Code, ex.Message);
        return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.Code, ex.Message));
    }
}

public sealed class GitHubDeviceFlowPollRequest
{
    public string? FlowToken { get; set; }
}
