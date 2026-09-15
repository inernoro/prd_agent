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

    /// <summary>
    /// 当前用户的 GitHub 连接状态（未连接也是 200，前端据此决定显示"去连接"还是"已连接"）。
    ///
    /// <c>connected</c> 只说明库里存过一条记录。用户在 GitHub 那边撤销授权后这条记录还在，
    /// 于是界面显示"已连接"、一点仓库却报错——所以连着的时候还要**真打一次 GitHub** 问一句
    /// 现在还认不认，结果放在 <c>usable</c> 里（usable / revoked / unknown 三态，
    /// unknown 表示网络抖动等没问出结论，前端不得当成已失效）。
    /// </summary>
    [HttpGet("auth/status")]
    public async Task<IActionResult> GetStatus(CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var conn = await _connections.GetConnectionAsync(userId, ct);

        var usable = conn == null
            ? null
            : DescribeUsability(await _connections.ProbeConnectionAsync(userId, ct));

        return Ok(ApiResponse<object>.Ok(new
        {
            connected = conn != null,
            usable,
            oauthConfigured = _connections.IsOAuthConfigured(),
            login = conn?.GitHubLogin,
            avatarUrl = conn?.AvatarUrl,
            scopes = conn?.Scopes,
            connectedAt = conn?.ConnectedAt,
            lastUsedAt = conn?.LastUsedAt,
        }));
    }

    /// <summary>
    /// 可用性枚举 → 线上契约字符串。三态逐个列出（新增枚举值时这里会漏，所以兜底取最保守的
    /// "unknown"——它不会把一条正常连接挡在门外，也不会谎称可用）。
    /// </summary>
    internal static string DescribeUsability(GitHubUserConnectionService.GitHubConnectionUsability probed) => probed switch
    {
        GitHubUserConnectionService.GitHubConnectionUsability.Usable => "usable",
        GitHubUserConnectionService.GitHubConnectionUsability.Revoked => "revoked",
        GitHubUserConnectionService.GitHubConnectionUsability.Unknown => "unknown",
        _ => "unknown",
    };

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
    public async Task<IActionResult> Disconnect()
    {
        var userId = this.GetRequiredUserId();
        // 删除故意不接请求的 CancellationToken：用户点完「断开」就关页面是常见操作，
        // 把它传下去会让删除在半路被取消，token 密文留在库里——用户以为断了，其实没断
        // （server-authority：客户端断开不取消服务端已经开始的写入）。
        var result = await _connections.DisconnectAsync(userId, CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new
        {
            outcome = DescribeDisconnectOutcome(result.Outcome),
            // 只有 GitHub 确认撤销、或本来就没有可撤的东西，才算「收回了」。
            // Unverified（GitHub 回 404，可能是本站换过应用凭据）不算——那正是会骗人的那一档。
            revoked = result.Revocation is GitHubTokenRevocation.Revoked or GitHubTokenRevocation.NothingToRevoke,
            revokeHint = DescribeRevocation(result.Revocation),
        }));
    }

    /// <summary>
    /// 本地这一侧的结果 → 线上契约字符串。三态逐个列出：
    /// 「没删成」有两种来路，前端要据此说完全相反的两句话，不能压成一个布尔让它自己猜。
    /// </summary>
    internal static string DescribeDisconnectOutcome(
        GitHubUserConnectionService.GitHubDisconnectOutcome outcome) => outcome switch
    {
        GitHubUserConnectionService.GitHubDisconnectOutcome.Removed => "removed",
        GitHubUserConnectionService.GitHubDisconnectOutcome.NothingToRemove => "nothing-to-remove",
        GitHubUserConnectionService.GitHubDisconnectOutcome.ReplacedMeanwhile => "replaced-meanwhile",
        // 兜底取最保守的一档：宁可让界面去重读一次真实状态，也不谎报「已删除」。
        _ => "replaced-meanwhile",
    };

    /// <summary>去 GitHub 自查并移除的那半句——多处共用一份，免得改一处忘一处。</summary>
    private const string ManualRevokeSuffix =
        "请到 GitHub 设置 → Applications → Authorized OAuth Apps 里确认本应用已不在列表中；若还在，手动移除即可。";

    /// <summary>
    /// 把撤销结果翻成给用户看的一句话：先说结果，再说要不要紧 / 下一步（external-cause-first）。
    ///
    /// 只写用户**能据此行动**的部分。为什么没撤成（没配应用密钥、网络出错、GitHub 不认这把令牌）
    /// 属于本站的内部诊断，用户拿它什么也做不了——留在服务端日志里即可，
    /// 断开那一步已按结果枚举记过一条（2026-09-15 Codex review 第八轮）。
    ///
    /// 撤销成功时返回 null —— 没有需要用户处理的事，就不要多说一句话。
    /// 兜底分支走的是「没撤掉」那一侧：将来新增枚举值而忘了在这里表态时，最坏结果是多提醒一次，
    /// 而不是让用户以为授权已经收回（宁可多说，不可谎报）。
    /// </summary>
    internal static string? DescribeRevocation(GitHubTokenRevocation revocation) => revocation switch
    {
        GitHubTokenRevocation.Revoked => null,
        GitHubTokenRevocation.NothingToRevoke => null,
        GitHubTokenRevocation.Unverified =>
            "本站保存的连接已删除。GitHub 没有确认这次撤销（可能你此前已经自行移除过），"
            + ManualRevokeSuffix,
        _ =>
            "本站保存的连接已删除，但 GitHub 那边的授权没能一起收回。"
            + ManualRevokeSuffix,
    };

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
            var result = await _connections.ListRepositoriesAsync(token, query, page, pageSize, ct);
            await _connections.TouchLastUsedAsync(userId, ct);

            return Ok(ApiResponse<object>.Ok(new
            {
                items = result.Items,
                page = Math.Max(1, page),
                pageSize,
                // HasMore 来自服务层（按过滤前条数算）——用这里过滤后的 items.Count 判会提前说「没有更多」
                hasMore = result.HasMore,
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
