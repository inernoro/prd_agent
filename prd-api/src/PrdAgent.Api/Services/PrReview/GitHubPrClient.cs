using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.PrReview;

/// <summary>
/// 以 per-user OAuth token 调用 GitHub REST API 拉取单个 PR 的最新快照。
///
/// 设计关键：消灭 404 歧义 —— 当 /repos/{owner}/{repo}/pulls/{number} 返回 404 时，
/// 再探一次 /repos/{owner}/{repo} 以区分：
///   - 仓库自身 404：仓库不存在 or 无权访问（私有仓）→ GITHUB_REPO_NOT_VISIBLE
///   - 仓库 200 但 PR 404：PR 编号真的不存在 → PR_NUMBER_INVALID
///
/// Happy path 仍只消耗 1 次 API 调用；只有出错时才多一次探测。
/// </summary>
public sealed class GitHubPrClient
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<GitHubPrClient> _logger;

    public GitHubPrClient(IHttpClientFactory httpClientFactory, ILogger<GitHubPrClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    // ===== 体积上限（防 MongoDB 单文档膨胀 + 防 LLM 上下文爆炸）=====
    private const int MaxBodyChars = 20_000;
    private const int MaxFileCount = 80;
    private const int MaxPatchCharsPerFile = 4_000;
    private const int MaxLinkedIssueBodyChars = 8_000;

    /// <summary>
    /// 以指定 token 拉取 (owner, repo, #number) 的最新快照。
    /// 失败时抛 <see cref="PrReviewException"/>，携带明确错误码。
    /// </summary>
    public async Task<PrReviewSnapshot> FetchPullRequestAsync(
        string accessToken,
        string owner,
        string repo,
        int number,
        CancellationToken ct)
    {
        return await FetchPullRequestAsync(accessToken, owner, repo, number, includeFilesAndIssue: true, ct);
    }

    /// <summary>
    /// 细粒度版本：控制是否要一起拉取 files/linked issue。
    /// 默认开启（AI 对齐度检查需要）；未来如果有只要元数据的场景可以传 false 省配额。
    /// </summary>
    public async Task<PrReviewSnapshot> FetchPullRequestAsync(
        string accessToken,
        string owner,
        string repo,
        int number,
        bool includeFilesAndIssue,
        CancellationToken ct)
    {
        if (!PrUrlParser.IsSafeOwnerRepo(owner, repo))
        {
            // 二次守护：即便数据库里藏了脏数据，我们也拒绝拼进 URL
            throw PrReviewException.UrlInvalid("owner/repo 含非法字符");
        }

        using var client = CreateAuthedClient(accessToken);

        var prPath = $"repos/{owner}/{repo}/pulls/{number}";
        using var resp = await client.GetAsync(prPath, ct);

        if (!resp.IsSuccessStatusCode)
        {
            await ThrowClassifiedAsync(client, resp, owner, repo, number, ct);
            throw new InvalidOperationException("unreachable");
        }

        var dto = await resp.Content.ReadFromJsonAsync<GitHubPullRequestDto>(cancellationToken: ct);
        if (dto == null)
        {
            throw PrReviewException.Upstream((int)resp.StatusCode);
        }

        var snapshot = MapToSnapshot(dto);

        if (!includeFilesAndIssue)
        {
            return snapshot;
        }

        // 附加上下文（AI 对齐度需要）。这些调用失败不致命，记日志就行。
        try
        {
            snapshot.Files = await FetchFilesAsync(client, owner, repo, number, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PrReview fetch files failed for {Owner}/{Repo}#{Number}", owner, repo, number);
        }

        var linkedIssue = TryParseLinkedIssue(dto.Body);
        if (linkedIssue.HasValue)
        {
            try
            {
                var issue = await FetchIssueAsync(client, owner, repo, linkedIssue.Value, ct);
                if (issue != null)
                {
                    snapshot.LinkedIssueNumber = linkedIssue.Value;
                    snapshot.LinkedIssueTitle = issue.Title;
                    snapshot.LinkedIssueBody = Truncate(issue.Body, MaxLinkedIssueBodyChars);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "PrReview fetch linked issue #{Issue} failed", linkedIssue.Value);
            }
        }

        return snapshot;
    }

    /// <summary>
    /// 拉取 PR 变更的文件清单 + unified diff 片段。
    /// GitHub /pulls/{n}/files 默认分页 30 条，最多 3000 条；我们只拿前 MaxFileCount 条。
    /// </summary>
    private async Task<List<PrFileSummary>> FetchFilesAsync(
        HttpClient client,
        string owner,
        string repo,
        int number,
        CancellationToken ct)
    {
        var results = new List<PrFileSummary>();
        var page = 1;
        const int perPage = 30;

        while (results.Count < MaxFileCount)
        {
            var path = $"repos/{owner}/{repo}/pulls/{number}/files?per_page={perPage}&page={page}";
            using var resp = await client.GetAsync(path, ct);
            if (!resp.IsSuccessStatusCode)
            {
                break;
            }

            var dtos = await resp.Content.ReadFromJsonAsync<List<GitHubPullRequestFileDto>>(cancellationToken: ct);
            if (dtos == null || dtos.Count == 0)
            {
                break;
            }

            foreach (var dto in dtos)
            {
                if (results.Count >= MaxFileCount) break;
                results.Add(new PrFileSummary
                {
                    Filename = dto.Filename ?? string.Empty,
                    Status = dto.Status ?? string.Empty,
                    Additions = dto.Additions,
                    Deletions = dto.Deletions,
                    Patch = Truncate(dto.Patch, MaxPatchCharsPerFile),
                });
            }

            if (dtos.Count < perPage)
            {
                break;
            }
            page++;
        }

        return results;
    }

    /// <summary>
    /// 拉取关联 issue 的 title + body。失败返回 null。
    /// </summary>
    private async Task<GitHubIssueDto?> FetchIssueAsync(
        HttpClient client,
        string owner,
        string repo,
        int number,
        CancellationToken ct)
    {
        var path = $"repos/{owner}/{repo}/issues/{number}";
        using var resp = await client.GetAsync(path, ct);
        if (!resp.IsSuccessStatusCode)
        {
            return null;
        }
        return await resp.Content.ReadFromJsonAsync<GitHubIssueDto>(cancellationToken: ct);
    }

    /// <summary>
    /// 从 PR body 里提取关联 issue 编号。支持常见的 GitHub 关闭关键词：
    /// Closes #123 / Fixes #45 / Resolves #678（大小写不敏感）。
    /// 没有匹配到返回 null——不强求，有则更准。
    /// </summary>
    internal static int? TryParseLinkedIssue(string? body)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        var match = Regex.Match(
            body!,
            @"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*[:\s]*#(\d+)\b",
            RegexOptions.IgnoreCase);
        if (match.Success && int.TryParse(match.Groups[1].Value, out var n))
        {
            return n;
        }
        return null;
    }

    private static string? Truncate(string? text, int maxChars)
    {
        if (string.IsNullOrEmpty(text)) return text;
        if (text!.Length <= maxChars) return text;
        return text[..maxChars] + $"\n\n[... 已截断，原始长度 {text.Length} 字符 ...]";
    }

    // ===== internal =====

    private HttpClient CreateAuthedClient(string accessToken)
    {
        var client = _httpClientFactory.CreateClient("GitHubApi");
        client.BaseAddress = new Uri("https://api.github.com/");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        client.DefaultRequestHeaders.Accept.Clear();
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        return client;
    }

    /// <summary>
    /// 根据 PR 请求失败的响应，分类抛出领域异常。
    /// 对 404 执行两步探测：先看 /repos 是否也 404 以区分"仓库不可见"与"PR 编号错"。
    /// </summary>
    private async Task ThrowClassifiedAsync(
        HttpClient client,
        HttpResponseMessage prResp,
        string owner,
        string repo,
        int number,
        CancellationToken ct)
    {
        var status = (int)prResp.StatusCode;

        switch (prResp.StatusCode)
        {
            case HttpStatusCode.Unauthorized:
                throw PrReviewException.TokenExpired();

            case HttpStatusCode.Forbidden:
                if (IsRateLimited(prResp))
                {
                    throw PrReviewException.RateLimited(ExtractResetHint(prResp));
                }
                throw PrReviewException.Forbidden();

            case (HttpStatusCode)429:
                throw PrReviewException.RateLimited(ExtractResetHint(prResp));

            case HttpStatusCode.NotFound:
                await DisambiguateNotFoundAsync(client, owner, repo, number, ct);
                throw new InvalidOperationException("unreachable");

            default:
                if (status >= 500)
                {
                    throw PrReviewException.Upstream(status);
                }
                throw PrReviewException.Upstream(status);
        }
    }

    private async Task DisambiguateNotFoundAsync(
        HttpClient client,
        string owner,
        string repo,
        int number,
        CancellationToken ct)
    {
        var repoPath = $"repos/{owner}/{repo}";
        using var resp = await client.GetAsync(repoPath, ct);
        if (resp.StatusCode == HttpStatusCode.NotFound)
        {
            throw PrReviewException.RepoNotVisible(owner, repo);
        }
        if (resp.StatusCode == HttpStatusCode.Unauthorized)
        {
            throw PrReviewException.TokenExpired();
        }
        if (resp.StatusCode == HttpStatusCode.Forbidden)
        {
            if (IsRateLimited(resp))
            {
                throw PrReviewException.RateLimited(ExtractResetHint(resp));
            }
            // 能看到"被禁止"说明仓库存在
            throw PrReviewException.PrNumberInvalid(owner, repo, number);
        }
        if (resp.IsSuccessStatusCode)
        {
            throw PrReviewException.PrNumberInvalid(owner, repo, number);
        }
        // 其他异常（5xx 等）
        throw PrReviewException.Upstream((int)resp.StatusCode);
    }

    private static bool IsRateLimited(HttpResponseMessage resp)
    {
        if (resp.Headers.TryGetValues("X-RateLimit-Remaining", out var remaining))
        {
            var first = remaining.FirstOrDefault();
            if (first != null && int.TryParse(first, out var r) && r == 0)
            {
                return true;
            }
        }
        return false;
    }

    private static string? ExtractResetHint(HttpResponseMessage resp)
    {
        if (resp.Headers.TryGetValues("X-RateLimit-Reset", out var reset))
        {
            var first = reset.FirstOrDefault();
            if (first != null && long.TryParse(first, out var unix))
            {
                var when = DateTimeOffset.FromUnixTimeSeconds(unix).ToLocalTime();
                return when.ToString("HH:mm:ss");
            }
        }
        return null;
    }

    private static PrReviewSnapshot MapToSnapshot(GitHubPullRequestDto dto)
    {
        var state = dto.State ?? "open";
        if (dto.MergedAt.HasValue)
        {
            state = PrReviewStates.Merged;
        }

        return new PrReviewSnapshot
        {
            Title = dto.Title ?? string.Empty,
            Body = Truncate(dto.Body, MaxBodyChars),
            State = state,
            AuthorLogin = dto.User?.Login ?? string.Empty,
            AuthorAvatarUrl = dto.User?.AvatarUrl,
            Labels = dto.Labels?.Select(l => l.Name ?? string.Empty)
                        .Where(n => !string.IsNullOrEmpty(n))
                        .ToList() ?? new List<string>(),
            Additions = dto.Additions,
            Deletions = dto.Deletions,
            ChangedFiles = dto.ChangedFiles,
            ReviewDecision = null,
            CreatedAt = dto.CreatedAt,
            MergedAt = dto.MergedAt,
            ClosedAt = dto.ClosedAt,
            HeadSha = dto.Head?.Sha ?? string.Empty,
        };
    }

    // =========================================================
    // 历史数据拉取：PR 的 commits / reviews / comments / timeline / check-runs
    // =========================================================

    /// <summary>
    /// 并行拉取一个 PR 的完整审查历史。失败的子请求不致命，会在对应字段放空列表，
    /// 这样至少能拿到部分数据展示。调用方应该检查 Errors 字段了解哪些段落拉不到。
    /// </summary>
    public async Task<GitHubPrHistoryDto> FetchHistoryAsync(
        string accessToken,
        string owner,
        string repo,
        int number,
        string? headSha,
        CancellationToken ct)
    {
        if (!PrUrlParser.IsSafeOwnerRepo(owner, repo))
        {
            throw PrReviewException.UrlInvalid("owner/repo 含非法字符");
        }

        using var client = CreateAuthedClient(accessToken);
        // timeline api 需要 mockingbird 版本 Accept header 才能看到全部事件
        // （否则只返回 issue 级事件，看不到 reviewed/committed 等 PR 专属事件）
        client.DefaultRequestHeaders.Accept.Clear();
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github.mockingbird-preview+json"));

        var errors = new List<string>();

        // 所有子请求并行发起，互不阻塞
        var commitsTask = SafeFetchAsync(
            () => FetchCommitsAsync(client, owner, repo, number, ct),
            nameof(FetchCommitsAsync), errors);

        var reviewsTask = SafeFetchAsync(
            () => FetchReviewsAsync(client, owner, repo, number, ct),
            nameof(FetchReviewsAsync), errors);

        var reviewCommentsTask = SafeFetchAsync(
            () => FetchReviewCommentsAsync(client, owner, repo, number, ct),
            nameof(FetchReviewCommentsAsync), errors);

        var issueCommentsTask = SafeFetchAsync(
            () => FetchIssueCommentsAsync(client, owner, repo, number, ct),
            nameof(FetchIssueCommentsAsync), errors);

        var timelineTask = SafeFetchAsync(
            () => FetchTimelineAsync(client, owner, repo, number, ct),
            nameof(FetchTimelineAsync), errors);

        var checkRunsTask = string.IsNullOrWhiteSpace(headSha)
            ? Task.FromResult(new List<GitHubCheckRunDto>())
            : SafeFetchAsync(
                () => FetchCheckRunsAsync(client, owner, repo, headSha!, ct),
                nameof(FetchCheckRunsAsync), errors);

        await Task.WhenAll(commitsTask, reviewsTask, reviewCommentsTask, issueCommentsTask, timelineTask, checkRunsTask);

        return new GitHubPrHistoryDto
        {
            Commits = await commitsTask,
            Reviews = await reviewsTask,
            ReviewComments = await reviewCommentsTask,
            IssueComments = await issueCommentsTask,
            Timeline = await timelineTask,
            CheckRuns = await checkRunsTask,
            Errors = errors,
        };
    }

    private async Task<List<T>> SafeFetchAsync<T>(
        Func<Task<List<T>>> fetcher,
        string name,
        List<string> errors)
    {
        try
        {
            return await fetcher();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PrReview history fetch {Name} failed", name);
            lock (errors) { errors.Add($"{name}: {ex.Message}"); }
            return new List<T>();
        }
    }

    private async Task<List<GitHubPrCommitDto>> FetchCommitsAsync(
        HttpClient client, string owner, string repo, int number, CancellationToken ct)
    {
        // per_page=100 足够覆盖大部分 PR；超过 100 commit 的 PR 极少见，忽略分页
        var path = $"repos/{owner}/{repo}/pulls/{number}/commits?per_page=100";
        using var resp = await client.GetAsync(path, ct);
        if (!resp.IsSuccessStatusCode) return new();
        var raw = await resp.Content.ReadFromJsonAsync<List<GitHubCommitRawDto>>(cancellationToken: ct) ?? new();
        return raw.Select(r => new GitHubPrCommitDto
        {
            Sha = r.Sha ?? string.Empty,
            Message = r.Commit?.Message ?? string.Empty,
            AuthorName = r.Commit?.Author?.Name ?? r.Author?.Login ?? string.Empty,
            AuthorLogin = r.Author?.Login,
            AuthorAvatarUrl = r.Author?.AvatarUrl,
            AuthoredAt = r.Commit?.Author?.Date,
            HtmlUrl = r.HtmlUrl,
        }).ToList();
    }

    private async Task<List<GitHubPrReviewDto>> FetchReviewsAsync(
        HttpClient client, string owner, string repo, int number, CancellationToken ct)
    {
        var path = $"repos/{owner}/{repo}/pulls/{number}/reviews?per_page=100";
        using var resp = await client.GetAsync(path, ct);
        if (!resp.IsSuccessStatusCode) return new();
        var raw = await resp.Content.ReadFromJsonAsync<List<GitHubReviewRawDto>>(cancellationToken: ct) ?? new();
        return raw.Select(r => new GitHubPrReviewDto
        {
            Id = r.Id,
            State = r.State ?? string.Empty, // APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED / PENDING
            AuthorLogin = r.User?.Login ?? string.Empty,
            AuthorAvatarUrl = r.User?.AvatarUrl,
            Body = Truncate(r.Body, 4000),
            SubmittedAt = r.SubmittedAt,
            HtmlUrl = r.HtmlUrl,
        }).ToList();
    }

    private async Task<List<GitHubPrReviewCommentDto>> FetchReviewCommentsAsync(
        HttpClient client, string owner, string repo, int number, CancellationToken ct)
    {
        var path = $"repos/{owner}/{repo}/pulls/{number}/comments?per_page=100";
        using var resp = await client.GetAsync(path, ct);
        if (!resp.IsSuccessStatusCode) return new();
        var raw = await resp.Content.ReadFromJsonAsync<List<GitHubReviewCommentRawDto>>(cancellationToken: ct) ?? new();
        return raw.Select(r => new GitHubPrReviewCommentDto
        {
            Id = r.Id,
            AuthorLogin = r.User?.Login ?? string.Empty,
            AuthorAvatarUrl = r.User?.AvatarUrl,
            Body = Truncate(r.Body, 4000),
            CreatedAt = r.CreatedAt,
            Path = r.Path,
            Line = r.Line ?? r.OriginalLine,
            DiffHunk = Truncate(r.DiffHunk, 1000),
            HtmlUrl = r.HtmlUrl,
        }).ToList();
    }

    private async Task<List<GitHubPrIssueCommentDto>> FetchIssueCommentsAsync(
        HttpClient client, string owner, string repo, int number, CancellationToken ct)
    {
        // issue comments 在 /issues/{n}/comments 下，与 PR 对话共享
        var path = $"repos/{owner}/{repo}/issues/{number}/comments?per_page=100";
        using var resp = await client.GetAsync(path, ct);
        if (!resp.IsSuccessStatusCode) return new();
        var raw = await resp.Content.ReadFromJsonAsync<List<GitHubIssueCommentRawDto>>(cancellationToken: ct) ?? new();
        return raw.Select(r => new GitHubPrIssueCommentDto
        {
            Id = r.Id,
            AuthorLogin = r.User?.Login ?? string.Empty,
            AuthorAvatarUrl = r.User?.AvatarUrl,
            Body = Truncate(r.Body, 4000),
            CreatedAt = r.CreatedAt,
            HtmlUrl = r.HtmlUrl,
        }).ToList();
    }

    private async Task<List<GitHubPrTimelineEventDto>> FetchTimelineAsync(
        HttpClient client, string owner, string repo, int number, CancellationToken ct)
    {
        // issues timeline 对 PR 同样适用，包含 committed / reviewed / commented /
        // labeled / unlabeled / assigned / unassigned / head_ref_force_pushed /
        // head_ref_deleted / merged / closed / reopened / ready_for_review /
        // converted_to_draft / review_requested / cross-referenced 等 20+ 事件类型
        var path = $"repos/{owner}/{repo}/issues/{number}/timeline?per_page=100";
        using var resp = await client.GetAsync(path, ct);
        if (!resp.IsSuccessStatusCode) return new();
        var raw = await resp.Content.ReadFromJsonAsync<List<GitHubTimelineRawDto>>(cancellationToken: ct) ?? new();
        return raw.Select(r => new GitHubPrTimelineEventDto
        {
            Event = r.Event ?? string.Empty,
            ActorLogin = r.Actor?.Login ?? r.User?.Login,
            ActorAvatarUrl = r.Actor?.AvatarUrl ?? r.User?.AvatarUrl,
            CreatedAt = r.CreatedAt ?? r.SubmittedAt ?? r.Author?.Date,
            Label = r.Label?.Name,
            AssigneeLogin = r.Assignee?.Login,
            RequestedReviewerLogin = r.RequestedReviewer?.Login,
            CommitSha = r.CommitId ?? r.Sha,
            CommitMessage = Truncate(r.Message ?? r.Commit?.Message, 500),
            State = r.State, // for reviewed events: APPROVED / CHANGES_REQUESTED / COMMENTED
            Body = Truncate(r.Body, 2000), // for commented events
            Rename = r.Rename != null ? $"{r.Rename.From} → {r.Rename.To}" : null,
        }).ToList();
    }

    private async Task<List<GitHubCheckRunDto>> FetchCheckRunsAsync(
        HttpClient client, string owner, string repo, string sha, CancellationToken ct)
    {
        var path = $"repos/{owner}/{repo}/commits/{sha}/check-runs?per_page=100";
        using var resp = await client.GetAsync(path, ct);
        if (!resp.IsSuccessStatusCode) return new();
        var wrapper = await resp.Content.ReadFromJsonAsync<GitHubCheckRunsWrapperDto>(cancellationToken: ct);
        return wrapper?.CheckRuns?.Select(c => new GitHubCheckRunDto
        {
            Id = c.Id,
            Name = c.Name ?? string.Empty,
            Status = c.Status ?? string.Empty, // queued / in_progress / completed
            Conclusion = c.Conclusion, // success / failure / neutral / cancelled / skipped / timed_out / action_required
            StartedAt = c.StartedAt,
            CompletedAt = c.CompletedAt,
            HtmlUrl = c.HtmlUrl,
            AppName = c.App?.Name,
        }).ToList() ?? new();
    }
}

// =========================================================
// 历史数据 DTO（服务层和 Controller 共用，对外暴露给前端）
// =========================================================

public sealed class GitHubPrHistoryDto
{
    public List<GitHubPrCommitDto> Commits { get; set; } = new();
    public List<GitHubPrReviewDto> Reviews { get; set; } = new();
    public List<GitHubPrReviewCommentDto> ReviewComments { get; set; } = new();
    public List<GitHubPrIssueCommentDto> IssueComments { get; set; } = new();
    public List<GitHubPrTimelineEventDto> Timeline { get; set; } = new();
    public List<GitHubCheckRunDto> CheckRuns { get; set; } = new();
    public List<string> Errors { get; set; } = new();
}

public sealed class GitHubPrCommitDto
{
    public string Sha { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
    public string AuthorName { get; set; } = string.Empty;
    public string? AuthorLogin { get; set; }
    public string? AuthorAvatarUrl { get; set; }
    public DateTime? AuthoredAt { get; set; }
    public string? HtmlUrl { get; set; }
}

public sealed class GitHubPrReviewDto
{
    public long Id { get; set; }
    public string State { get; set; } = string.Empty;
    public string AuthorLogin { get; set; } = string.Empty;
    public string? AuthorAvatarUrl { get; set; }
    public string? Body { get; set; }
    public DateTime? SubmittedAt { get; set; }
    public string? HtmlUrl { get; set; }
}

public sealed class GitHubPrReviewCommentDto
{
    public long Id { get; set; }
    public string AuthorLogin { get; set; } = string.Empty;
    public string? AuthorAvatarUrl { get; set; }
    public string? Body { get; set; }
    public DateTime? CreatedAt { get; set; }
    public string? Path { get; set; }
    public int? Line { get; set; }
    public string? DiffHunk { get; set; }
    public string? HtmlUrl { get; set; }
}

public sealed class GitHubPrIssueCommentDto
{
    public long Id { get; set; }
    public string AuthorLogin { get; set; } = string.Empty;
    public string? AuthorAvatarUrl { get; set; }
    public string? Body { get; set; }
    public DateTime? CreatedAt { get; set; }
    public string? HtmlUrl { get; set; }
}

public sealed class GitHubPrTimelineEventDto
{
    public string Event { get; set; } = string.Empty;
    public string? ActorLogin { get; set; }
    public string? ActorAvatarUrl { get; set; }
    public DateTime? CreatedAt { get; set; }
    public string? Label { get; set; }
    public string? AssigneeLogin { get; set; }
    public string? RequestedReviewerLogin { get; set; }
    public string? CommitSha { get; set; }
    public string? CommitMessage { get; set; }
    public string? State { get; set; }
    public string? Body { get; set; }
    public string? Rename { get; set; }
}

public sealed class GitHubCheckRunDto
{
    public long Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public string? Conclusion { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public string? HtmlUrl { get; set; }
    public string? AppName { get; set; }
}

// =========================================================
// 内部 Raw DTO（反序列化 GitHub REST 响应，不对外暴露）
// =========================================================

internal sealed class GitHubCommitRawDto
{
    [JsonPropertyName("sha")] public string? Sha { get; set; }
    [JsonPropertyName("commit")] public GitHubCommitInnerDto? Commit { get; set; }
    [JsonPropertyName("author")] public GitHubUserRef? Author { get; set; }
    [JsonPropertyName("html_url")] public string? HtmlUrl { get; set; }
}

internal sealed class GitHubCommitInnerDto
{
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("author")] public GitHubCommitAuthorDto? Author { get; set; }
}

internal sealed class GitHubCommitAuthorDto
{
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("date")] public DateTime? Date { get; set; }
}

internal sealed class GitHubReviewRawDto
{
    [JsonPropertyName("id")] public long Id { get; set; }
    [JsonPropertyName("state")] public string? State { get; set; }
    [JsonPropertyName("user")] public GitHubUserRef? User { get; set; }
    [JsonPropertyName("body")] public string? Body { get; set; }
    [JsonPropertyName("submitted_at")] public DateTime? SubmittedAt { get; set; }
    [JsonPropertyName("html_url")] public string? HtmlUrl { get; set; }
}

internal sealed class GitHubReviewCommentRawDto
{
    [JsonPropertyName("id")] public long Id { get; set; }
    [JsonPropertyName("user")] public GitHubUserRef? User { get; set; }
    [JsonPropertyName("body")] public string? Body { get; set; }
    [JsonPropertyName("created_at")] public DateTime? CreatedAt { get; set; }
    [JsonPropertyName("path")] public string? Path { get; set; }
    [JsonPropertyName("line")] public int? Line { get; set; }
    [JsonPropertyName("original_line")] public int? OriginalLine { get; set; }
    [JsonPropertyName("diff_hunk")] public string? DiffHunk { get; set; }
    [JsonPropertyName("html_url")] public string? HtmlUrl { get; set; }
}

internal sealed class GitHubIssueCommentRawDto
{
    [JsonPropertyName("id")] public long Id { get; set; }
    [JsonPropertyName("user")] public GitHubUserRef? User { get; set; }
    [JsonPropertyName("body")] public string? Body { get; set; }
    [JsonPropertyName("created_at")] public DateTime? CreatedAt { get; set; }
    [JsonPropertyName("html_url")] public string? HtmlUrl { get; set; }
}

internal sealed class GitHubTimelineRawDto
{
    [JsonPropertyName("event")] public string? Event { get; set; }
    [JsonPropertyName("actor")] public GitHubUserRef? Actor { get; set; }
    [JsonPropertyName("user")] public GitHubUserRef? User { get; set; }
    [JsonPropertyName("created_at")] public DateTime? CreatedAt { get; set; }
    [JsonPropertyName("submitted_at")] public DateTime? SubmittedAt { get; set; }
    [JsonPropertyName("label")] public GitHubLabelDto? Label { get; set; }
    [JsonPropertyName("assignee")] public GitHubUserRef? Assignee { get; set; }
    [JsonPropertyName("requested_reviewer")] public GitHubUserRef? RequestedReviewer { get; set; }
    [JsonPropertyName("commit_id")] public string? CommitId { get; set; }
    [JsonPropertyName("sha")] public string? Sha { get; set; }
    [JsonPropertyName("message")] public string? Message { get; set; }
    [JsonPropertyName("commit")] public GitHubCommitInnerDto? Commit { get; set; }
    [JsonPropertyName("author")] public GitHubCommitAuthorDto? Author { get; set; }
    [JsonPropertyName("state")] public string? State { get; set; }
    [JsonPropertyName("body")] public string? Body { get; set; }
    [JsonPropertyName("rename")] public GitHubRenameDto? Rename { get; set; }
}

internal sealed class GitHubRenameDto
{
    [JsonPropertyName("from")] public string? From { get; set; }
    [JsonPropertyName("to")] public string? To { get; set; }
}

internal sealed class GitHubCheckRunsWrapperDto
{
    [JsonPropertyName("total_count")] public int TotalCount { get; set; }
    [JsonPropertyName("check_runs")] public List<GitHubCheckRunRawDto>? CheckRuns { get; set; }
}

internal sealed class GitHubCheckRunRawDto
{
    [JsonPropertyName("id")] public long Id { get; set; }
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("status")] public string? Status { get; set; }
    [JsonPropertyName("conclusion")] public string? Conclusion { get; set; }
    [JsonPropertyName("started_at")] public DateTime? StartedAt { get; set; }
    [JsonPropertyName("completed_at")] public DateTime? CompletedAt { get; set; }
    [JsonPropertyName("html_url")] public string? HtmlUrl { get; set; }
    [JsonPropertyName("app")] public GitHubCheckAppDto? App { get; set; }
}

internal sealed class GitHubCheckAppDto
{
    [JsonPropertyName("name")] public string? Name { get; set; }
}

// ===== GitHub REST API DTOs =====

internal sealed class GitHubPullRequestDto
{
    [JsonPropertyName("title")] public string? Title { get; set; }
    [JsonPropertyName("body")] public string? Body { get; set; }
    [JsonPropertyName("state")] public string? State { get; set; }
    [JsonPropertyName("user")] public GitHubUserRef? User { get; set; }
    [JsonPropertyName("labels")] public List<GitHubLabelDto>? Labels { get; set; }
    [JsonPropertyName("additions")] public int Additions { get; set; }
    [JsonPropertyName("deletions")] public int Deletions { get; set; }
    [JsonPropertyName("changed_files")] public int ChangedFiles { get; set; }
    [JsonPropertyName("created_at")] public DateTime CreatedAt { get; set; }
    [JsonPropertyName("merged_at")] public DateTime? MergedAt { get; set; }
    [JsonPropertyName("closed_at")] public DateTime? ClosedAt { get; set; }
    [JsonPropertyName("head")] public GitHubRefDto? Head { get; set; }
}

internal sealed class GitHubPullRequestFileDto
{
    [JsonPropertyName("filename")] public string? Filename { get; set; }
    [JsonPropertyName("status")] public string? Status { get; set; }
    [JsonPropertyName("additions")] public int Additions { get; set; }
    [JsonPropertyName("deletions")] public int Deletions { get; set; }
    [JsonPropertyName("patch")] public string? Patch { get; set; }
}

internal sealed class GitHubIssueDto
{
    [JsonPropertyName("title")] public string? Title { get; set; }
    [JsonPropertyName("body")] public string? Body { get; set; }
}

internal sealed class GitHubUserRef
{
    [JsonPropertyName("login")] public string? Login { get; set; }
    [JsonPropertyName("avatar_url")] public string? AvatarUrl { get; set; }
}

internal sealed class GitHubLabelDto
{
    [JsonPropertyName("name")] public string? Name { get; set; }
}

internal sealed class GitHubRefDto
{
    [JsonPropertyName("sha")] public string? Sha { get; set; }
}
