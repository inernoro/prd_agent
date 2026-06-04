using System.Linq;
using System.Text.Json;
using System.Threading.Channels;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
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

    public ChangelogController(
        IChangelogReader reader,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        IChangelogPushHub pushHub)
    {
        _reader = reader;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _pushHub = pushHub;
    }

    /// <summary>
    /// 待发布更新（从全部 changelogs/ 碎片读取，按日期倒序）
    /// </summary>
    /// <param name="force">true 时绕过服务端缓存，重新从源拉取（GitHub 路径意味着真实 API 调用）</param>
    [HttpGet("current-week")]
    public async Task<IActionResult> GetCurrentWeek([FromQuery] bool force = false)
    {
        var view = await _reader.GetCurrentWeekAsync(force).ConfigureAwait(false);
        if (!force) SetClientCacheHeaders();
        return Ok(ApiResponse<CurrentWeekDto>.Ok(MapCurrentWeek(view)));
    }

    /// <summary>
    /// 历史发布（从 CHANGELOG.md 读取，按版本倒序）
    /// </summary>
    /// <param name="limit">最多返回的版本数量（1..100，默认 20）</param>
    /// <param name="force">true 时绕过服务端缓存，重新从源拉取</param>
    [HttpGet("releases")]
    public async Task<IActionResult> GetReleases([FromQuery] int limit = 20, [FromQuery] bool force = false)
    {
        if (limit <= 0 || limit > 100) limit = 20;
        var view = await _reader.GetReleasesAsync(limit, force).ConfigureAwait(false);
        if (!force) SetClientCacheHeaders();
        return Ok(ApiResponse<ReleasesDto>.Ok(MapReleases(view)));
    }

    /// <summary>
    /// GitHub 日志（优先本地 git log，失败时回退 GitHub commits API）
    /// </summary>
    [HttpGet("github-logs")]
    public async Task<IActionResult> GetGitHubLogs([FromQuery] int limit = 30, [FromQuery] bool force = false)
    {
        if (limit <= 0 || limit > 1000) limit = 1000;
        var view = await _reader.GetGitHubLogsAsync(limit, force).ConfigureAwait(false);
        if (!force) SetClientCacheHeaders();
        return Ok(ApiResponse<GitHubLogsDto>.Ok(MapGitHubLogs(view)));
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

    private static CurrentWeekDto MapCurrentWeek(CurrentWeekView view) => new()
    {
        WeekStart = view.WeekStart.ToString("yyyy-MM-dd"),
        WeekEnd = view.WeekEnd.ToString("yyyy-MM-dd"),
        DataSourceAvailable = view.DataSourceAvailable,
        Source = view.Source,
        FetchedAt = view.FetchedAt.ToString("o"),
        Fragments = view.Fragments.ConvertAll(f => new ChangelogFragmentDto
        {
            FileName = f.FileName,
            Date = f.Date.ToString("yyyy-MM-dd"),
            Entries = f.Entries.ConvertAll(MapEntry),
        }),
    };

    private static ReleasesDto MapReleases(ReleasesView view) => new()
    {
        DataSourceAvailable = view.DataSourceAvailable,
        Source = view.Source,
        FetchedAt = view.FetchedAt.ToString("o"),
        Releases = view.Releases.ConvertAll(r => new ChangelogReleaseDto
        {
            Version = r.Version,
            ReleaseDate = r.ReleaseDate?.ToString("yyyy-MM-dd"),
            EntryCount = r.Days.Sum(d => d.Entries.Count),
            SourceScope = r.Version == "未发布" ? "changelog-unreleased-block" : "changelog-release-block",
            Highlights = r.Highlights,
            Days = r.Days.ConvertAll(d => new ChangelogDayDto
            {
                Date = d.Date.ToString("yyyy-MM-dd"),
                CommitTimeUtc = d.CommitTimeUtc?.ToString("o"),
                Entries = d.Entries.ConvertAll(MapEntry),
            }),
        }),
    };

    private static GitHubLogsDto MapGitHubLogs(GitHubLogsView view) => new()
    {
        DataSourceAvailable = view.DataSourceAvailable,
        Source = view.Source,
        FetchedAt = view.FetchedAt.ToString("o"),
        Logs = view.Logs.ConvertAll(l => new GitHubLogEntryDto
        {
            Sha = l.Sha,
            ShortSha = l.ShortSha,
            Message = l.Message,
            AuthorName = l.AuthorName,
            AuthorAvatarUrl = l.AuthorAvatarUrl,
            CommitTimeUtc = l.CommitTimeUtc.ToString("o"),
            HtmlUrl = l.HtmlUrl,
        }),
    };

    private static ChangelogEntryDto MapEntry(ChangelogEntry e) => new()
    {
        Type = e.Type,
        Module = e.Module,
        Description = e.Description,
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
        /// <summary>releases / fragments / github_logs</summary>
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
        public List<ChangelogDayDto> Days { get; set; } = new();
    }

    public sealed class ReleasesDto
    {
        public bool DataSourceAvailable { get; set; }
        public string Source { get; set; } = "none";
        public string FetchedAt { get; set; } = string.Empty;
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
    }

    public sealed class GitHubLogsDto
    {
        public bool DataSourceAvailable { get; set; }
        public string Source { get; set; } = "none";
        public string FetchedAt { get; set; } = string.Empty;
        public List<GitHubLogEntryDto> Logs { get; set; } = new();
    }
}
