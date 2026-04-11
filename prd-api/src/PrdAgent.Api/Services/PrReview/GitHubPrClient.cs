using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
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
        if (!PrUrlParser.IsSafeOwnerRepo(owner, repo))
        {
            // 二次守护：即便数据库里藏了脏数据，我们也拒绝拼进 URL
            throw PrReviewException.UrlInvalid("owner/repo 含非法字符");
        }

        using var client = CreateAuthedClient(accessToken);

        var prPath = $"repos/{owner}/{repo}/pulls/{number}";
        using var resp = await client.GetAsync(prPath, ct);

        if (resp.IsSuccessStatusCode)
        {
            var dto = await resp.Content.ReadFromJsonAsync<GitHubPullRequestDto>(cancellationToken: ct);
            if (dto == null)
            {
                throw PrReviewException.Upstream((int)resp.StatusCode);
            }
            return MapToSnapshot(dto);
        }

        await ThrowClassifiedAsync(client, resp, owner, repo, number, ct);
        throw new InvalidOperationException("unreachable");
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
}

// ===== GitHub REST API DTOs =====

internal sealed class GitHubPullRequestDto
{
    [JsonPropertyName("title")] public string? Title { get; set; }
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
