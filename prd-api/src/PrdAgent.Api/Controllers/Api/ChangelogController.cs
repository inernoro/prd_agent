using System.Linq;
using System.Text.Json;
using System.Threading.Channels;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.Changelog;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 更新中心 - 代码级周报
/// 数据源：仓库内的 changelogs/*.md 碎片 + CHANGELOG.md，不依赖数据库。
/// CHANGELOG.md 为已发布；changelogs/*.md 碎片为待发布。
/// 优先读取本地文件（dev 5 分钟缓存），找不到时自动从 GitHub 拉取（生产默认 5 分钟缓存）。
/// 仅需登录即可访问，无需特殊权限。
/// </summary>
[ApiController]
[Route("api/changelog")]
[Authorize]
[AdminController("changelog", AdminPermissionCatalog.Access)]
public class ChangelogController : ControllerBase
{
    private const string ChangelogAiSummaryAppCallerCode = AppCallerRegistry.Admin.Changelog.AiSummary;

    private static readonly JsonSerializerOptions AiSummaryPayloadJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly IChangelogReader _reader;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly IChangelogPushHub _pushHub;
    private readonly MongoDbContext _db;
    private readonly IMemoryCache _cache;
    private readonly IConfiguration _config;

    public ChangelogController(
        IChangelogReader reader,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        IChangelogPushHub pushHub,
        MongoDbContext db,
        IMemoryCache cache,
        IConfiguration config)
    {
        _reader = reader;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _pushHub = pushHub;
        _db = db;
        _cache = cache;
        _config = config;
    }

    /// <summary>
    /// 待发布更新（从全部 changelogs/ 碎片读取，按日期倒序）
    /// </summary>
    /// <param name="daysLimit">分页：只返回前 N 个日期组（按日期倒序），null=全部。前端首屏建议 4</param>
    /// <param name="daysOffset">分页：跳过前 N 个日期组（与 daysLimit 配合）</param>
    /// <param name="force">true 时绕过服务端缓存，重新从源拉取（GitHub 路径意味着真实 API 调用）</param>
    [HttpGet("current-week")]
    public async Task<IActionResult> GetCurrentWeek(
        [FromQuery] int? daysLimit = null,
        [FromQuery] int daysOffset = 0,
        [FromQuery] bool force = false)
    {
        var view = await _reader.GetCurrentWeekAsync(force).ConfigureAwait(false);
        if (!force) SetClientCacheHeaders();
        return Ok(ApiResponse<CurrentWeekDto>.Ok(MapCurrentWeek(view, daysLimit, daysOffset)));
    }

    /// <summary>
    /// 历史发布（从 CHANGELOG.md 读取，按版本倒序）
    /// </summary>
    /// <param name="limit">最多返回的版本数量（1..100，默认 8）</param>
    /// <param name="summary">true 时只返回每个版本的元数据（version/releaseDate/entryCount/highlights），days 为空；前端按需调 by-version 端点拉详情</param>
    /// <param name="force">true 时绕过服务端缓存，重新从源拉取</param>
    [HttpGet("releases")]
    public async Task<IActionResult> GetReleases(
        [FromQuery] int limit = 8,
        [FromQuery] bool summary = false,
        [FromQuery] bool force = false)
    {
        if (limit <= 0 || limit > 100) limit = 8;
        // reader 永远拉满 100（单一 cache key），controller 切片输出。
        // 这样 chip 显示的 totalReleases / totalEntries 永远基于全量，不会被 limit 截断（Bugbot #5）。
        var view = await _reader.GetReleasesAsync(100, force).ConfigureAwait(false);
        if (!force) SetClientCacheHeaders();
        return Ok(ApiResponse<ReleasesDto>.Ok(MapReleases(view, summary, limit)));
    }

    /// <summary>
    /// 单个版本详情（按需懒加载）。配合 releases?summary=true 使用：前端先拿元数据，
    /// 卡片进入视口时调本端点拉具体 entries，瀑布式展开。
    /// </summary>
    [HttpGet("releases/by-version/{version}")]
    public async Task<IActionResult> GetReleaseByVersion(string version, [FromQuery] bool force = false)
    {
        var view = await _reader.GetReleasesAsync(100, force).ConfigureAwait(false);
        var release = view.Releases.FirstOrDefault(r => r.Version == version);
        if (release == null)
            return NotFound(ApiResponse<ChangelogReleaseDto>.Fail("RELEASE_NOT_FOUND", $"版本 {version} 不存在"));
        if (!force) SetClientCacheHeaders();
        return Ok(ApiResponse<ChangelogReleaseDto>.Ok(MapRelease(release, summary: false)));
    }

    /// <summary>
    /// GitHub 日志（优先本地 git log，失败时回退 GitHub commits API）
    /// </summary>
    /// <param name="limit">本次返回条数（1..1000，默认 80 — 与前端首屏 visible=80 对齐）</param>
    /// <param name="before">cursor：返回该 sha 之后的条目（按时间倒序的「之后」=更老）。空=从最新开始</param>
    [HttpGet("github-logs")]
    public async Task<IActionResult> GetGitHubLogs(
        [FromQuery] int limit = 80,
        [FromQuery] string? before = null,
        [FromQuery] bool force = false)
    {
        if (limit <= 0 || limit > 1000) limit = 80;
        // reader 永远拿全量（1000 上限），controller 切片
        var view = await _reader.GetGitHubLogsAsync(1000, force).ConfigureAwait(false);
        var matchIndex = await GetUserMatchIndexAsync().ConfigureAwait(false);
        var linkedDefectsBySha = await GetLinkedDefectsForGitHubLogsAsync(view, limit, before).ConfigureAwait(false);
        if (!force) SetClientCacheHeaders();
        return Ok(ApiResponse<GitHubLogsDto>.Ok(MapGitHubLogs(view, limit, before, matchIndex, linkedDefectsBySha)));
    }

    private async Task<IReadOnlyDictionary<string, List<GitHubLinkedDefectDto>>> GetLinkedDefectsForGitHubLogsAsync(
        GitHubLogsView view,
        int limit,
        string? before)
    {
        var startIdx = 0;
        if (!string.IsNullOrEmpty(before))
        {
            var idx = view.Logs.FindIndex(l => string.Equals(l.Sha, before, StringComparison.OrdinalIgnoreCase));
            if (idx >= 0) startIdx = idx + 1;
        }

        var slice = view.Logs.Skip(startIdx).Take(Math.Max(0, limit)).ToList();
        if (slice.Count == 0)
            return new Dictionary<string, List<GitHubLinkedDefectDto>>(StringComparer.OrdinalIgnoreCase);

        var shaAliasesByCommit = slice
            .Select(l =>
            {
                var sha = l.Sha.ToLowerInvariant();
                return new { CommitSha = sha, Aliases = BuildCommitShaAliases(l.Sha, l.ShortSha) };
            })
            .ToList();
        var shas = shaAliasesByCommit
            .SelectMany(x => x.Aliases)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        var commitShaByAlias = shaAliasesByCommit
            .SelectMany(x => x.Aliases.Select(alias => new { Alias = alias, x.CommitSha }))
            .GroupBy(x => x.Alias, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First().CommitSha, StringComparer.OrdinalIgnoreCase);
        var traces = await _db.DefectResolutionTraces
            .Find(x => shas.Contains(x.CommitSha))
            .ToListAsync()
            .ConfigureAwait(false);
        var defectIds = traces
            .Select(x => x.DefectId)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var defectsById = defectIds.Count == 0
            ? new Dictionary<string, DefectReport>(StringComparer.Ordinal)
            : (await _db.DefectReports
                .Find(x => defectIds.Contains(x.Id))
                .ToListAsync()
                .ConfigureAwait(false))
                .ToDictionary(x => x.Id, StringComparer.Ordinal);
        var currentUserId = this.GetRequiredUserId();

        var deployedCommitSha = ResolveCurrentDeployCommitSha();
        var deployedIndex = string.IsNullOrWhiteSpace(deployedCommitSha)
            ? -1
            : view.Logs.FindIndex(l => string.Equals(l.Sha, deployedCommitSha, StringComparison.OrdinalIgnoreCase));
        var shaIndex = view.Logs
            .Select((log, index) => new { log.Sha, index })
            .GroupBy(x => x.Sha, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First().index, StringComparer.OrdinalIgnoreCase);

        var now = DateTime.UtcNow;
        var newlyPublishedTraceIds = new List<string>();
        var result = new Dictionary<string, List<GitHubLinkedDefectDto>>(StringComparer.OrdinalIgnoreCase);
        foreach (var trace in traces)
        {
            var normalizedTraceSha = trace.CommitSha.Trim().ToLowerInvariant();
            if (!commitShaByAlias.TryGetValue(normalizedTraceSha, out var commitSha))
                commitSha = normalizedTraceSha;

            var publishStatus = ResolvePublishStatus(trace, commitSha, deployedCommitSha, deployedIndex, shaIndex);
            if (publishStatus == DefectResolutionPublishStatus.Published &&
                trace.PublishStatus != DefectResolutionPublishStatus.Published)
            {
                newlyPublishedTraceIds.Add(trace.Id);
            }

            if (!result.TryGetValue(commitSha, out var linked))
            {
                linked = new List<GitHubLinkedDefectDto>();
                result[commitSha] = linked;
            }

            defectsById.TryGetValue(trace.DefectId, out var defect);
            linked.Add(new GitHubLinkedDefectDto
            {
                TraceId = trace.Id,
                DefectId = trace.DefectId,
                DefectNo = trace.DefectNo,
                DefectTitle = trace.DefectTitle,
                ReporterName = defect?.ReporterName,
                IsSubmittedByMe = defect != null
                    && string.Equals(defect.ReporterId, currentUserId, StringComparison.Ordinal),
                FixStatus = publishStatus == DefectResolutionPublishStatus.Published
                    ? DefectResolutionFixStatus.Published
                    : trace.FixStatus,
                PublishStatus = publishStatus,
                PreviewUrl = trace.PreviewUrl,
                VisualReportUrl = trace.VisualReportUrl,
                KnowledgeBaseUrl = trace.KnowledgeBaseUrl,
                PullRequestNumber = trace.PullRequestNumber,
                PullRequestUrl = trace.PullRequestUrl,
                CommitSha = trace.CommitSha,
            });
        }

        if (newlyPublishedTraceIds.Count > 0 && !string.IsNullOrWhiteSpace(deployedCommitSha))
        {
            var update = Builders<DefectResolutionTrace>.Update
                .Set(x => x.PublishStatus, DefectResolutionPublishStatus.Published)
                .Set(x => x.FixStatus, DefectResolutionFixStatus.Published)
                .Set(x => x.PublishedByCommitSha, deployedCommitSha)
                .Set(x => x.PublishedAt, now)
                .Set(x => x.NotifyStatus, DefectResolutionNotifyStatus.Pending)
                .Set(x => x.UpdatedAt, now);
            await _db.DefectResolutionTraces.UpdateManyAsync(
                Builders<DefectResolutionTrace>.Filter.In(x => x.Id, newlyPublishedTraceIds),
                update);
        }

        return result;
    }

    private string? ResolveCurrentDeployCommitSha()
    {
        var candidates = new[]
        {
            _config["Changelog:ProductionCommitSha"],
            _config["Deployment:CommitSha"],
            Environment.GetEnvironmentVariable("GIT_COMMIT"),
            Environment.GetEnvironmentVariable("COMMIT_SHA"),
            Environment.GetEnvironmentVariable("GITHUB_SHA"),
            Environment.GetEnvironmentVariable("SOURCE_VERSION"),
            Environment.GetEnvironmentVariable("CDS_COMMIT_SHA"),
            Environment.GetEnvironmentVariable("VERCEL_GIT_COMMIT_SHA"),
        };

        return candidates
            .Select(x => x?.Trim().ToLowerInvariant())
            .FirstOrDefault(x => !string.IsNullOrWhiteSpace(x));
    }

    internal static string ResolvePublishStatus(
        DefectResolutionTrace trace,
        string? deployedCommitSha,
        int deployedIndex,
        IReadOnlyDictionary<string, int> shaIndex)
        => ResolvePublishStatus(trace, trace.CommitSha, deployedCommitSha, deployedIndex, shaIndex);

    internal static string ResolvePublishStatus(
        DefectResolutionTrace trace,
        string commitSha,
        string? deployedCommitSha,
        int deployedIndex,
        IReadOnlyDictionary<string, int> shaIndex)
    {
        if (trace.PublishStatus == DefectResolutionPublishStatus.Published)
            return DefectResolutionPublishStatus.Published;
        if (string.IsNullOrWhiteSpace(deployedCommitSha) || deployedIndex < 0)
            return DefectResolutionPublishStatus.Unknown;
        if (string.Equals(commitSha, deployedCommitSha, StringComparison.OrdinalIgnoreCase))
            return DefectResolutionPublishStatus.Published;
        if (!shaIndex.TryGetValue(commitSha, out var traceIndex))
            return DefectResolutionPublishStatus.Unknown;
        return traceIndex >= deployedIndex
            ? DefectResolutionPublishStatus.Published
            : DefectResolutionPublishStatus.Pending;
    }

    internal static IReadOnlyCollection<string> BuildCommitShaAliases(string? commitSha, string? shortSha)
    {
        var aliases = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var normalized = commitSha?.Trim().ToLowerInvariant();
        if (!string.IsNullOrWhiteSpace(normalized))
        {
            aliases.Add(normalized);
            if (normalized.Length >= 7)
                aliases.Add(normalized[..7]);
        }

        var normalizedShort = shortSha?.Trim().ToLowerInvariant();
        if (!string.IsNullOrWhiteSpace(normalizedShort))
            aliases.Add(normalizedShort);

        return aliases;
    }

    /// <summary>
    /// GitHub 待审核提交（open PR）。用于展示自动化修复已经提交但尚未合入发布流水的 PR。
    /// </summary>
    [HttpGet("github-pending-review")]
    public async Task<IActionResult> GetGitHubPendingReview(
        [FromQuery] int limit = 50,
        [FromQuery] bool force = false)
    {
        if (limit <= 0 || limit > 100) limit = 50;
        var view = await _reader.GetGitHubPendingReviewAsync(limit, force).ConfigureAwait(false);
        if (!force) SetClientCacheHeaders();
        return Ok(ApiResponse<GitHubPendingReviewDto>.Ok(MapGitHubPendingReview(view)));
    }

    // ── GitHub 作者名 ↔ 系统用户 彩蛋匹配 ────────────────────────────

    private sealed record GitHubUserMatchCandidate(
        string Username,
        string DisplayName,
        string NormUsername,
        string NormDisplayName);

    private const string UserMatchIndexCacheKey = "changelog:github-author-match-index";

    /// <summary>
    /// 活跃人类用户的归一化名字索引（10 分钟内存缓存）。
    /// 供 GitHub 提交作者名匹配「这是系统里的谁」彩蛋使用，失败时返回空表不影响主流程。
    /// </summary>
    private async Task<IReadOnlyList<GitHubUserMatchCandidate>> GetUserMatchIndexAsync()
    {
        if (_cache.TryGetValue(UserMatchIndexCacheKey, out IReadOnlyList<GitHubUserMatchCandidate>? cached) && cached != null)
        {
            return cached;
        }

        try
        {
            var users = await _db.Users
                .Find(u => u.Status == UserStatus.Active && u.UserType == UserType.Human)
                .Project(u => new { u.Username, u.DisplayName })
                .ToListAsync()
                .ConfigureAwait(false);

            IReadOnlyList<GitHubUserMatchCandidate> index = users
                .Select(u => new GitHubUserMatchCandidate(
                    u.Username ?? string.Empty,
                    u.DisplayName ?? string.Empty,
                    GitHubAuthorMatcher.Normalize(u.Username),
                    GitHubAuthorMatcher.Normalize(u.DisplayName)))
                .Where(c => c.NormUsername.Length >= 2 || c.NormDisplayName.Length >= 2)
                .ToList();

            _cache.Set(UserMatchIndexCacheKey, index, TimeSpan.FromMinutes(10));
            return index;
        }
        catch
        {
            return Array.Empty<GitHubUserMatchCandidate>();
        }
    }

    /// <summary>
    /// 更新中心实时推送（SSE）。
    /// 连接时先发一条 meta（含后台刷新周期，供前端「更新规则」展示），随后保持长连接：
    /// 后台 Worker 刷新发现内容变化时推 update 事件，前端据此重新读取存量并平滑替换。
    /// 无变化时每 15s 发 ping 心跳保活。客户端断开即清理订阅（仅终止本订阅，不影响后台任务）。
    /// </summary>
    [HttpGet("stream")]
    [Produces("text/event-stream")]
    public async Task Stream()
    {
        var ct = HttpContext.RequestAborted;
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";

        var (subscriptionId, reader) = _pushHub.Subscribe();
        var heartbeat = TimeSpan.FromSeconds(15);
        try
        {
            await WriteSseEventAsync("meta", new
            {
                refreshIntervalHours = _reader.GetRefreshIntervalHours(),
                serverTime = DateTimeOffset.UtcNow.ToString("o"),
            }, ct).ConfigureAwait(false);

            while (!ct.IsCancellationRequested)
            {
                ChangelogPushEvent? evt = null;
                try
                {
                    using var waitCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    waitCts.CancelAfter(heartbeat);
                    evt = await reader.ReadAsync(waitCts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    if (ct.IsCancellationRequested) break;
                    // 心跳超时：发 ping 保活，继续等下一条事件
                    await WriteSseEventAsync("ping", new { t = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }, ct).ConfigureAwait(false);
                    continue;
                }
                catch (ChannelClosedException)
                {
                    break;
                }

                if (evt is null) continue;
                await WriteSseEventAsync("update", new
                {
                    viewType = evt.ViewType,
                    fetchedAt = evt.FetchedAt.ToString("o"),
                    source = evt.Source,
                }, ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) { /* 客户端断开 */ }
        catch (ObjectDisposedException) { /* 客户端断开 */ }
        finally
        {
            _pushHub.Unsubscribe(subscriptionId);
        }
    }

    private async Task WriteSseEventAsync(string evt, object data, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(data, AiSummaryPayloadJsonOptions);
        await Response.WriteAsync($"event: {evt}\ndata: {json}\n\n", ct).ConfigureAwait(false);
        await Response.Body.FlushAsync(ct).ConfigureAwait(false);
    }

    /// <summary>
    /// 浏览器缓存策略：freshness-first。`no-cache` = 浏览器可存但每次使用前必须向后端校验，
    /// 因此永远不会拿到「浏览器层面的陈旧副本」——杜绝「迟迟不更新」。
    /// 速度由两层兜底，不靠浏览器缓存：
    ///   1) 前端 sessionStorage 立即首屏渲染（不等网络），再后台拉取实时覆盖
    ///   2) 后端 serve-stale-while-revalidate 内存缓存，校验请求 ms 级返回（不打 GitHub）
    /// 这样既保持「秒开」又保证「所见即最新」。force=true（手动刷新）连后端缓存一并绕过。
    /// </summary>
    private void SetClientCacheHeaders()
    {
        Response.Headers["Cache-Control"] = "private, no-cache";
    }

    /// <summary>
    /// AI 总结：走 ILlmGateway + AppCallerCode（prd-admin.changelog.ai-summary::chat），禁止前端本地假摘要。
    /// </summary>
    [HttpPost("ai-summary")]
    public async Task<IActionResult> AiSummary([FromBody] ChangelogAiSummaryRequest? request, CancellationToken ct)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.Subtab))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "subtab 必填，取值 releases / fragments / github_logs"));
        }

        var subtab = request.Subtab.Trim().ToLowerInvariant();
        var typeFilter = string.IsNullOrWhiteSpace(request.TypeFilter) ? null : request.TypeFilter.Trim();

        const int releasesLimit = 20;
        const int githubLogsLimit = 30;

        object payload = null!;
        string sceneLabel;

        switch (subtab)
        {
            case "releases":
            {
                var rv = await _reader.GetReleasesAsync(releasesLimit, false).ConfigureAwait(false);
                var filtered = FilterReleasesForSummary(rv, typeFilter);
                if (!HasAnyReleaseDayEntry(filtered))
                {
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "当前筛选条件下没有可总结的历史发布"));
                }

                payload = new { subtab = "releases", data = filtered };
                sceneLabel = "历史发布（CHANGELOG）";
                break;
            }
            case "fragments":
            {
                var cw = await _reader.GetCurrentWeekAsync(false).ConfigureAwait(false);
                var filtered = FilterFragmentsForSummary(cw, typeFilter);
                if (!HasAnyFragmentEntry(filtered))
                {
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "当前筛选条件下没有可总结的待发布功能"));
                }

                payload = new { subtab = "fragments", data = filtered };
                sceneLabel = "待发布功能";
                break;
            }
            case "github_logs":
            {
                var gv = await _reader.GetGitHubLogsAsync(githubLogsLimit, false).ConfigureAwait(false);
                if (gv.Logs.Count == 0)
                {
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "当前没有可总结的 GitHub 日志"));
                }

                payload = new { subtab = "github_logs", data = gv };
                sceneLabel = "GitHub 日志";
                break;
            }
            case "github_pending_review":
            {
                var pv = await _reader.GetGitHubPendingReviewAsync(30, false).ConfigureAwait(false);
                if (pv.Items.Count == 0)
                {
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "当前没有可总结的 GitHub 待审核提交"));
                }

                payload = new { subtab = "github_pending_review", data = pv };
                sceneLabel = "GitHub 待审核提交";
                break;
            }
            default:
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "subtab 无效"));
        }

        var userJson = JsonSerializer.Serialize(payload, AiSummaryPayloadJsonOptions);
        if (userJson.Length > 14_000)
        {
            userJson = string.Concat(userJson.AsSpan(0, 14_000), "\n…(内容过长已截断)");
        }

        var userId = this.GetRequiredUserId();
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: userJson.Length,
            DocumentHash: null,
            SystemPromptRedacted: "changelog-ai-summary",
            RequestType: "chat",
            AppCallerCode: ChangelogAiSummaryAppCallerCode));

        var systemPrompt =
            $"你是 PrdAgent 更新中心助手。下面是仓库变更数据（JSON），场景：{sceneLabel}。\n" +
            "你必须只输出**一个** JSON 对象，UTF-8，不要 markdown 代码围栏，不要解释。\n" +
            "字段要求：\n" +
            "- \"title\" string：简短中文标题（≤24字）\n" +
            "- \"headline\" string：一句话总览\n" +
            "- \"bullets\" string[]：3~5 条要点\n" +
            "- \"stats\" string[]：恰好 3 条简短统计标签（如 \"12 条提交\"）\n" +
            "- \"insight\" string：一句给读者的观察或建议";

        var gatewayBody = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = userJson },
            },
            ["temperature"] = 0.35,
            ["max_tokens"] = 1200,
        };

        var gwResponse = await _gateway.SendAsync(new GatewayRequest
        {
            AppCallerCode = ChangelogAiSummaryAppCallerCode,
            ModelType = "chat",
            RequestBody = gatewayBody,
        }, ct).ConfigureAwait(false);

        if (!gwResponse.Success || string.IsNullOrWhiteSpace(gwResponse.Content))
        {
            return StatusCode(502, ApiResponse<object>.Fail("LLM_ERROR", gwResponse.ErrorMessage ?? "模型未返回有效内容"));
        }

        ChangelogAiSummaryDto? dto;
        try
        {
            dto = ParseChangelogAiSummaryJson(gwResponse.Content);
        }
        catch
        {
            return StatusCode(502, ApiResponse<object>.Fail("LLM_PARSE_ERROR", "模型输出无法解析为 JSON"));
        }

        if (dto is null)
        {
            return StatusCode(502, ApiResponse<object>.Fail("LLM_PARSE_ERROR", "模型输出结构不完整"));
        }

        dto.ThinkingTrace = $"已通过 ILlmGateway 调用（AppCallerCode={ChangelogAiSummaryAppCallerCode}）。";
        dto.GeneratedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return Ok(ApiResponse<ChangelogAiSummaryDto>.Ok(dto));
    }

    // ── DTO 映射 ──────────────────────────────────────────────────────

    private static CurrentWeekDto MapCurrentWeek(
        CurrentWeekView view,
        int? daysLimit = null,
        int daysOffset = 0)
    {
        var totalDays = view.Fragments.Count;
        var totalEntries = view.Fragments.Sum(f => f.Entries.Count);
        var offset = Math.Max(0, daysOffset);
        var sliced = daysLimit.HasValue
            ? view.Fragments.Skip(offset).Take(Math.Max(0, daysLimit.Value)).ToList()
            : view.Fragments;
        var hasMore = daysLimit.HasValue && (offset + sliced.Count) < totalDays;

        return new CurrentWeekDto
        {
            WeekStart = view.WeekStart.ToString("yyyy-MM-dd"),
            WeekEnd = view.WeekEnd.ToString("yyyy-MM-dd"),
            DataSourceAvailable = view.DataSourceAvailable,
            Source = view.Source,
            FetchedAt = view.FetchedAt.ToString("o"),
            TotalDays = totalDays,
            TotalEntries = totalEntries,
            DaysOffset = offset,
            HasMore = hasMore,
            Fragments = sliced.ConvertAll(f => new ChangelogFragmentDto
            {
                FileName = f.FileName,
                Date = f.Date.ToString("yyyy-MM-dd"),
                Entries = f.Entries.ConvertAll(MapEntry),
            }),
        };
    }

    private static ReleasesDto MapReleases(
        ReleasesView view,
        bool summary = false,
        int displayLimit = int.MaxValue) => new()
    {
        DataSourceAvailable = view.DataSourceAvailable,
        Source = view.Source,
        FetchedAt = view.FetchedAt.ToString("o"),
        // totals 永远从全量 view 算（与 displayLimit 解耦），让 chip 显示真实数字
        TotalReleases = view.Releases.Count,
        TotalEntries = view.Releases.Sum(r => r.Days.Sum(d => d.Entries.Count)),
        // 输出列表按 displayLimit 切片
        Releases = view.Releases.Take(displayLimit).Select(r => MapRelease(r, summary)).ToList(),
    };

    private static ChangelogReleaseDto MapRelease(
        ChangelogRelease r,
        bool summary) => new()
    {
        Version = r.Version,
        ReleaseDate = r.ReleaseDate?.ToString("yyyy-MM-dd"),
        EntryCount = r.Days.Sum(d => d.Entries.Count),
        SourceScope = r.Version == "未发布" ? "changelog-unreleased-block" : "changelog-release-block",
        Highlights = r.Highlights,
        EntriesOmitted = summary,
        // summary 模式：days 为空数组（节省 90%+ 体积）；详情靠 by-version 端点
        Days = summary
            ? new List<ChangelogDayDto>()
            : r.Days.ConvertAll(d => new ChangelogDayDto
            {
                Date = d.Date.ToString("yyyy-MM-dd"),
                CommitTimeUtc = d.CommitTimeUtc?.ToString("o"),
                Entries = d.Entries.ConvertAll(MapEntry),
            }),
    };

    private static GitHubLogsDto MapGitHubLogs(
        GitHubLogsView view,
        int limit,
        string? before,
        IReadOnlyList<GitHubUserMatchCandidate> matchIndex,
        IReadOnlyDictionary<string, List<GitHubLinkedDefectDto>> linkedDefectsBySha)
    {
        var totalCount = view.Logs.Count;
        var startIdx = 0;
        if (!string.IsNullOrEmpty(before))
        {
            var idx = view.Logs.FindIndex(l => l.Sha == before);
            if (idx >= 0) startIdx = idx + 1; // 跳过 cursor 自身
        }
        var slice = view.Logs.Skip(startIdx).Take(Math.Max(0, limit)).ToList();
        var hasMore = (startIdx + slice.Count) < totalCount;
        var nextCursor = slice.Count > 0 ? slice[^1].Sha : null;

        // 同一作者在一页里反复出现，按作者名做请求内 memo，避免重复扫描索引
        var matchMemo = new Dictionary<string, GitHubUserMatchCandidate?>(StringComparer.Ordinal);
        GitHubUserMatchCandidate? ResolveMatch(string authorName)
        {
            if (matchMemo.TryGetValue(authorName, out var memo)) return memo;
            GitHubUserMatchCandidate? hit = null;
            // 变体含「剥掉通用组织后缀」的版本（如 yurenping-miduo → yurenping）
            var variants = GitHubAuthorMatcher.NormalizedVariants(authorName);
            if (variants.Count > 0)
            {
                hit = matchIndex.FirstOrDefault(c => variants.Any(v =>
                    GitHubAuthorMatcher.IsMatch(v, c.NormUsername) ||
                    GitHubAuthorMatcher.IsMatch(v, c.NormDisplayName)));
            }
            matchMemo[authorName] = hit;
            return hit;
        }

        return new GitHubLogsDto
        {
            DataSourceAvailable = view.DataSourceAvailable,
            Source = view.Source,
            FetchedAt = view.FetchedAt.ToString("o"),
            TotalCount = totalCount,
            RepoTotalCommitCount = view.RepoTotalCommitCount,
            HasMore = hasMore,
            NextCursor = hasMore ? nextCursor : null,
            Logs = slice.ConvertAll(l =>
            {
                var match = ResolveMatch(l.AuthorName);
                return new GitHubLogEntryDto
                {
                    Sha = l.Sha,
                    ShortSha = l.ShortSha,
                    Message = l.Message,
                    AuthorName = l.AuthorName,
                    AuthorAvatarUrl = l.AuthorAvatarUrl,
                    CommitTimeUtc = l.CommitTimeUtc.ToString("o"),
                    HtmlUrl = l.HtmlUrl,
                    MatchedUsername = match?.Username,
                    MatchedDisplayName = match == null
                        ? null
                        : (string.IsNullOrWhiteSpace(match.DisplayName) ? match.Username : match.DisplayName),
                    LinkedDefects = linkedDefectsBySha.TryGetValue(l.Sha, out var linkedDefects)
                        ? linkedDefects
                        : new List<GitHubLinkedDefectDto>(),
                    CoAuthors = l.CoAuthorNames.ConvertAll(name =>
                    {
                        var coMatch = ResolveMatch(name);
                        return new GitHubCoAuthorDto
                        {
                            Name = name,
                            MatchedUsername = coMatch?.Username,
                            MatchedDisplayName = coMatch == null
                                ? null
                                : (string.IsNullOrWhiteSpace(coMatch.DisplayName) ? coMatch.Username : coMatch.DisplayName),
                        };
                    }),
                };
            }),
        };
    }

    private static ChangelogEntryDto MapEntry(ChangelogEntry e) => new()
    {
        Type = e.Type,
        Module = e.Module,
        Description = e.Description,
    };

    private static GitHubPendingReviewDto MapGitHubPendingReview(GitHubPendingReviewView view) => new()
    {
        DataSourceAvailable = view.DataSourceAvailable,
        Source = view.Source,
        FetchedAt = view.FetchedAt.ToString("o"),
        TotalCount = view.TotalCount,
        Items = view.Items.ConvertAll(item => new GitHubPendingReviewEntryDto
        {
            Number = item.Number,
            Title = item.Title,
            AuthorName = item.AuthorName,
            AuthorAvatarUrl = item.AuthorAvatarUrl,
            HeadBranch = item.HeadBranch,
            BaseBranch = item.BaseBranch,
            HeadSha = item.HeadSha,
            ShortSha = item.ShortSha,
            IsDraft = item.IsDraft,
            CreatedAtUtc = item.CreatedAtUtc.ToString("o"),
            UpdatedAtUtc = item.UpdatedAtUtc.ToString("o"),
            HtmlUrl = item.HtmlUrl,
        }),
    };

    private static ReleasesView FilterReleasesForSummary(ReleasesView v, string? typeFilter)
    {
        if (string.IsNullOrWhiteSpace(typeFilter))
            return v;

        var tf = typeFilter.Trim().ToLowerInvariant();
        var releases = new List<ChangelogRelease>();
        foreach (var r in v.Releases)
        {
            var days = new List<ChangelogDay>();
            foreach (var d in r.Days)
            {
                var entries = d.Entries.Where(e => e.Type.ToLowerInvariant() == tf).ToList();
                if (entries.Count == 0)
                    continue;
                days.Add(new ChangelogDay
                {
                    Date = d.Date,
                    CommitTimeUtc = d.CommitTimeUtc,
                    Entries = entries,
                });
            }

            if (days.Count == 0)
                continue;

            releases.Add(new ChangelogRelease
            {
                Version = r.Version,
                ReleaseDate = r.ReleaseDate,
                Highlights = r.Highlights,
                Days = days,
            });
        }

        return new ReleasesView
        {
            DataSourceAvailable = v.DataSourceAvailable,
            Source = v.Source,
            FetchedAt = v.FetchedAt,
            Releases = releases,
        };
    }

    private static CurrentWeekView FilterFragmentsForSummary(CurrentWeekView v, string? typeFilter)
    {
        if (string.IsNullOrWhiteSpace(typeFilter))
            return v;

        var tf = typeFilter.Trim().ToLowerInvariant();
        var fragments = new List<ChangelogFragment>();
        foreach (var f in v.Fragments)
        {
            var entries = f.Entries.Where(e => e.Type.ToLowerInvariant() == tf).ToList();
            if (entries.Count == 0)
                continue;
            fragments.Add(new ChangelogFragment
            {
                FileName = f.FileName,
                Date = f.Date,
                Entries = entries,
            });
        }

        return new CurrentWeekView
        {
            WeekStart = v.WeekStart,
            WeekEnd = v.WeekEnd,
            DataSourceAvailable = v.DataSourceAvailable,
            Source = v.Source,
            FetchedAt = v.FetchedAt,
            Fragments = fragments,
        };
    }

    private static bool HasAnyReleaseDayEntry(ReleasesView v) =>
        v.Releases.Exists(r => r.Days.Exists(d => d.Entries.Count > 0));

    private static bool HasAnyFragmentEntry(CurrentWeekView v) =>
        v.Fragments.Exists(f => f.Entries.Count > 0);

    private static readonly JsonSerializerOptions AiSummaryParseJsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
    };

    private static string StripJsonFence(string raw)
    {
        var s = raw.Trim();
        if (s.StartsWith("```", StringComparison.Ordinal))
        {
            var firstNl = s.IndexOf('\n', StringComparison.Ordinal);
            if (firstNl >= 0)
                s = s[(firstNl + 1)..];
            var end = s.LastIndexOf("```", StringComparison.Ordinal);
            if (end > 0)
                s = s[..end];
        }

        return s.Trim();
    }

    private sealed class LlmSummaryJsonShape
    {
        public string? Title { get; set; }
        public string? Headline { get; set; }
        public List<string>? Bullets { get; set; }
        public List<string>? Stats { get; set; }
        public string? Insight { get; set; }
    }

    private static ChangelogAiSummaryDto? ParseChangelogAiSummaryJson(string raw)
    {
        var s = StripJsonFence(raw);
        var shape = JsonSerializer.Deserialize<LlmSummaryJsonShape>(s, AiSummaryParseJsonOptions);
        if (shape is null || string.IsNullOrWhiteSpace(shape.Title) || string.IsNullOrWhiteSpace(shape.Headline))
            return null;

        var bullets = (shape.Bullets ?? new List<string>()).Where(t => !string.IsNullOrWhiteSpace(t)).Take(8).ToList();
        var stats = (shape.Stats ?? new List<string>()).Where(t => !string.IsNullOrWhiteSpace(t)).Take(6).ToList();
        if (bullets.Count == 0)
            return null;

        return new ChangelogAiSummaryDto
        {
            Title = shape.Title.Trim(),
            Headline = shape.Headline.Trim(),
            Bullets = bullets.Select(x => x.Trim()).ToList(),
            Stats = stats.Select(x => x.Trim()).ToList(),
            Insight = (shape.Insight ?? string.Empty).Trim(),
        };
    }

    // ── DTO 定义（前端契约） ──────────────────────────────────────────

    public sealed class ChangelogAiSummaryRequest
    {
        /// <summary>releases / fragments / github_logs / github_pending_review</summary>
        public string Subtab { get; set; } = "";
        public string? TypeFilter { get; set; }
    }

    public sealed class ChangelogAiSummaryDto
    {
        public string Title { get; set; } = "";
        public string Headline { get; set; } = "";
        public List<string> Bullets { get; set; } = new();
        public List<string> Stats { get; set; } = new();
        public string Insight { get; set; } = "";
        public string ThinkingTrace { get; set; } = "";
        public long GeneratedAt { get; set; }
    }

    public sealed class ChangelogEntryDto
    {
        public string Type { get; set; } = string.Empty;
        public string Module { get; set; } = string.Empty;
        public string Description { get; set; } = string.Empty;
    }

    public sealed class ChangelogFragmentDto
    {
        public string FileName { get; set; } = string.Empty;
        public string Date { get; set; } = string.Empty;
        public List<ChangelogEntryDto> Entries { get; set; } = new();
    }

    public sealed class CurrentWeekDto
    {
        public string WeekStart { get; set; } = string.Empty;
        public string WeekEnd { get; set; } = string.Empty;
        public bool DataSourceAvailable { get; set; }
        /// <summary>"local" / "github" / "none"</summary>
        public string Source { get; set; } = "none";
        /// <summary>ISO 8601 时间戳</summary>
        public string FetchedAt { get; set; } = string.Empty;
        /// <summary>全量「日期组」数（=碎片文件数），不受 daysLimit 影响，用于 chip 计数</summary>
        public int TotalDays { get; set; }
        /// <summary>全量 entries 总数，不受 daysLimit 影响，用于 chip 计数</summary>
        public int TotalEntries { get; set; }
        /// <summary>本次响应跳过的日期组数（= daysOffset）</summary>
        public int DaysOffset { get; set; }
        /// <summary>是否还有更多日期组，前端据此触发 loadMore</summary>
        public bool HasMore { get; set; }
        public List<ChangelogFragmentDto> Fragments { get; set; } = new();
    }

    public sealed class ChangelogDayDto
    {
        public string Date { get; set; } = string.Empty;
        /// <summary>该日期最晚一次 GitHub commit 的 ISO 8601 UTC 时间（仅 github 源可用）</summary>
        public string? CommitTimeUtc { get; set; }
        public List<ChangelogEntryDto> Entries { get; set; } = new();
    }

    public sealed class ChangelogReleaseDto
    {
        public string Version { get; set; } = string.Empty;
        public string? ReleaseDate { get; set; }
        /// <summary>该 CHANGELOG 版本块的全部表格条目数，不受前端类型筛选影响</summary>
        public int EntryCount { get; set; }
        /// <summary>"changelog-unreleased-block" / "changelog-release-block"</summary>
        public string SourceScope { get; set; } = string.Empty;
        public List<string> Highlights { get; set; } = new();
        /// <summary>true 时 Days 是空数组（summary 模式），前端需调 by-version 端点拉详情</summary>
        public bool EntriesOmitted { get; set; }
        public List<ChangelogDayDto> Days { get; set; } = new();
    }

    public sealed class ReleasesDto
    {
        public bool DataSourceAvailable { get; set; }
        public string Source { get; set; } = "none";
        public string FetchedAt { get; set; } = string.Empty;
        /// <summary>版本总数（=Releases.Count，用于 chip 计数）</summary>
        public int TotalReleases { get; set; }
        /// <summary>所有版本的 entries 总数（用于 chip 计数，summary 模式下仍准确）</summary>
        public int TotalEntries { get; set; }
        public List<ChangelogReleaseDto> Releases { get; set; } = new();
    }

    public sealed class GitHubLogEntryDto
    {
        public string Sha { get; set; } = string.Empty;
        public string ShortSha { get; set; } = string.Empty;
        public string Message { get; set; } = string.Empty;
        public string AuthorName { get; set; } = string.Empty;
        public string? AuthorAvatarUrl { get; set; }
        public string CommitTimeUtc { get; set; } = string.Empty;
        public string HtmlUrl { get; set; } = string.Empty;
        /// <summary>彩蛋：作者名匹配到的系统用户登录名（去数字 + 颠倒容忍 + 通用后缀剥离），null=未匹配</summary>
        public string? MatchedUsername { get; set; }
        /// <summary>彩蛋：匹配到的系统用户显示名（为空时回退登录名），null=未匹配</summary>
        public string? MatchedDisplayName { get; set; }
        /// <summary>Co-authored-by 联合作者（已剔除与主作者同人），每位同样做系统用户匹配</summary>
        public List<GitHubCoAuthorDto> CoAuthors { get; set; } = new();
        /// <summary>该 commit 关联的缺陷修复记录</summary>
        public List<GitHubLinkedDefectDto> LinkedDefects { get; set; } = new();
    }

    public sealed class GitHubLinkedDefectDto
    {
        public string TraceId { get; set; } = string.Empty;
        public string DefectId { get; set; } = string.Empty;
        public string? DefectNo { get; set; }
        public string? DefectTitle { get; set; }
        public string? ReporterName { get; set; }
        public bool IsSubmittedByMe { get; set; }
        public string FixStatus { get; set; } = string.Empty;
        public string PublishStatus { get; set; } = string.Empty;
        public string? PreviewUrl { get; set; }
        public string? VisualReportUrl { get; set; }
        public string? KnowledgeBaseUrl { get; set; }
        public int? PullRequestNumber { get; set; }
        public string? PullRequestUrl { get; set; }
        public string CommitSha { get; set; } = string.Empty;
    }

    public sealed class GitHubCoAuthorDto
    {
        public string Name { get; set; } = string.Empty;
        public string? MatchedUsername { get; set; }
        public string? MatchedDisplayName { get; set; }
    }

    public sealed class GitHubLogsDto
    {
        public bool DataSourceAvailable { get; set; }
        public string Source { get; set; } = "none";
        public string FetchedAt { get; set; } = string.Empty;
        /// <summary>「最近一周」窗口内的 commit 总数（不受 limit 影响，列表数据上限）</summary>
        public int TotalCount { get; set; }
        /// <summary>仓库全历史提交总数（不限窗口），null=暂未统计成功，前端降级用 TotalCount</summary>
        public int? RepoTotalCommitCount { get; set; }
        /// <summary>是否还有更多，前端据此触发 loadMore</summary>
        public bool HasMore { get; set; }
        /// <summary>下一页 cursor（=本批次最后一条的 sha），前端传给 before 参数取下一批</summary>
        public string? NextCursor { get; set; }
        public List<GitHubLogEntryDto> Logs { get; set; } = new();
    }

    public sealed class GitHubPendingReviewEntryDto
    {
        public int Number { get; set; }
        public string Title { get; set; } = string.Empty;
        public string AuthorName { get; set; } = string.Empty;
        public string? AuthorAvatarUrl { get; set; }
        public string HeadBranch { get; set; } = string.Empty;
        public string BaseBranch { get; set; } = string.Empty;
        public string HeadSha { get; set; } = string.Empty;
        public string ShortSha { get; set; } = string.Empty;
        public bool IsDraft { get; set; }
        public string CreatedAtUtc { get; set; } = string.Empty;
        public string UpdatedAtUtc { get; set; } = string.Empty;
        public string HtmlUrl { get; set; } = string.Empty;
    }

    public sealed class GitHubPendingReviewDto
    {
        public bool DataSourceAvailable { get; set; }
        public string Source { get; set; } = "none";
        public string FetchedAt { get; set; } = string.Empty;
        public int TotalCount { get; set; }
        public List<GitHubPendingReviewEntryDto> Items { get; set; } = new();
    }
}
