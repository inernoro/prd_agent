using System.Net.Http.Headers;
using System.Text.Json;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// 个人数据源连接器接口（v2.0）
/// </summary>
public interface IPersonalSourceConnector
{
    Task<bool> TestConnectionAsync(CancellationToken ct);
    Task<SourceStats> CollectStatsAsync(DateTime from, DateTime to, CancellationToken ct);
}

/// <summary>
/// 语雀知识库引用（由 URL 解析得到）
/// </summary>
public sealed class YuqueRepoRef
{
    public string RepoId { get; init; } = string.Empty;
    public string? RepoName { get; init; }
    public string? Namespace { get; init; }
}

/// <summary>
/// 语雀 URL 工具
/// </summary>
public static class YuqueUrlHelper
{
    /// <summary>
    /// 归一化 URL 到知识库级别：
    /// https://www.yuque.com/{namespace}/{repo}
    /// </summary>
    public static string? NormalizeRepoUrl(string? input)
    {
        if (string.IsNullOrWhiteSpace(input))
            return null;

        if (!TryExtractNamespaceAndRepo(input, out var ns, out var repo))
            return null;

        return $"https://www.yuque.com/{ns}/{repo}".ToLowerInvariant();
    }

    public static bool TryExtractNamespaceAndRepo(string input, out string ns, out string repo)
    {
        ns = string.Empty;
        repo = string.Empty;

        if (!Uri.TryCreate(input.Trim(), UriKind.Absolute, out var uri))
            return false;

        if (!uri.Host.Contains("yuque.com", StringComparison.OrdinalIgnoreCase))
            return false;

        var segs = uri.AbsolutePath.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segs.Length < 2)
            return false;

        ns = Uri.UnescapeDataString(segs[0]).Trim().ToLowerInvariant();
        repo = Uri.UnescapeDataString(segs[1]).Trim().ToLowerInvariant();
        return !string.IsNullOrEmpty(ns) && !string.IsNullOrEmpty(repo);
    }
}

/// <summary>
/// 个人 GitHub 数据源连接器 — 通过 GitHub REST API 采集个人活动统计
/// </summary>
public class PersonalGitHubConnector : IPersonalSourceConnector
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive = true };

    private readonly string _token;
    private readonly string _username;
    private readonly string? _repoUrl;

    public PersonalGitHubConnector(string token, string username, string? repoUrl)
    {
        _token = token;
        _username = username;
        _repoUrl = repoUrl;
    }

    public async Task<bool> TestConnectionAsync(CancellationToken ct)
    {
        try
        {
            var request = new HttpRequestMessage(HttpMethod.Get, "https://api.github.com/user");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
            request.Headers.UserAgent.ParseAdd("PrdAgent/2.0");

            var response = await Http.SendAsync(request, ct);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<SourceStats> CollectStatsAsync(DateTime from, DateTime to, CancellationToken ct)
    {
        var stats = new SourceStats
        {
            SourceType = PersonalSourceType.GitHub,
            CollectedAt = DateTime.UtcNow
        };

        if (!string.IsNullOrEmpty(_repoUrl))
        {
            // 指定仓库模式：获取该仓库的 commits
            await CollectRepoCommitsAsync(stats, from, to, ct);
        }
        else
        {
            // 全局模式：获取用户所有事件
            await CollectUserEventsAsync(stats, from, to, ct);
        }

        return stats;
    }

    private async Task CollectRepoCommitsAsync(SourceStats stats, DateTime from, DateTime to, CancellationToken ct)
    {
        // 从 repoUrl 解析 owner/repo
        var (owner, repo) = ParseRepoUrl(_repoUrl!);
        if (owner == null || repo == null) return;

        var url = $"https://api.github.com/repos/{owner}/{repo}/commits?author={Uri.EscapeDataString(_username)}&since={from:yyyy-MM-ddTHH:mm:ssZ}&until={to:yyyy-MM-ddTHH:mm:ssZ}&per_page=100";

        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        request.Headers.UserAgent.ParseAdd("PrdAgent/2.0");

        var response = await Http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) return;

        var json = await response.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);

        int commitCount = 0;
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            commitCount++;
            var sha = item.TryGetProperty("sha", out var s) ? s.GetString()?[..7] : null;
            var message = item.TryGetProperty("commit", out var c) && c.TryGetProperty("message", out var m)
                ? m.GetString()?.Split('\n')[0] ?? ""
                : "";

            stats.Details.Add(new StatsDetail
            {
                Id = sha,
                Title = message.Length > 100 ? message[..100] : message,
                Type = "commit",
                Assignee = _username,
                Timestamp = item.TryGetProperty("commit", out var cm) && cm.TryGetProperty("author", out var a)
                    && a.TryGetProperty("date", out var d) && DateTime.TryParse(d.GetString(), out var dt)
                    ? dt : null
            });
        }

        stats.Summary["commits"] = commitCount;
    }

    private async Task CollectUserEventsAsync(SourceStats stats, DateTime from, DateTime to, CancellationToken ct)
    {
        var url = $"https://api.github.com/users/{Uri.EscapeDataString(_username)}/events?per_page=100";

        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        request.Headers.UserAgent.ParseAdd("PrdAgent/2.0");

        var response = await Http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) return;

        var json = await response.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);

        int pushCount = 0, prCount = 0;
        foreach (var ev in doc.RootElement.EnumerateArray())
        {
            if (!ev.TryGetProperty("created_at", out var caProp)) continue;
            if (!DateTime.TryParse(caProp.GetString(), out var created)) continue;
            if (created < from || created > to) continue;

            var evType = ev.TryGetProperty("type", out var tp) ? tp.GetString() : "";
            switch (evType)
            {
                case "PushEvent":
                    pushCount++;
                    if (ev.TryGetProperty("payload", out var payload) &&
                        payload.TryGetProperty("commits", out var commits))
                    {
                        foreach (var commit in commits.EnumerateArray())
                        {
                            var msg = commit.TryGetProperty("message", out var msgProp) ? msgProp.GetString() ?? "" : "";
                            stats.Details.Add(new StatsDetail
                            {
                                Id = commit.TryGetProperty("sha", out var sha) ? sha.GetString()?[..7] : null,
                                Title = msg.Length > 100 ? msg[..100] : msg,
                                Type = "commit",
                                Assignee = _username,
                                Timestamp = created
                            });
                        }
                    }
                    break;
                case "PullRequestEvent":
                    prCount++;
                    break;
            }
        }

        stats.Summary["commits"] = stats.Details.Count;
        stats.Summary["push_events"] = pushCount;
        stats.Summary["pr_events"] = prCount;
    }

    private static (string? owner, string? repo) ParseRepoUrl(string url)
    {
        // 支持 https://github.com/owner/repo 或 https://github.com/owner/repo.git
        try
        {
            var uri = new Uri(url.TrimEnd('/'));
            var parts = uri.AbsolutePath.Trim('/').Split('/');
            if (parts.Length >= 2)
                return (parts[0], parts[1].Replace(".git", ""));
        }
        catch { }
        return (null, null);
    }
}

/// <summary>
/// 个人语雀数据源连接器 — 通过语雀 Open API 采集文档统计
/// </summary>
public class PersonalYuqueConnector : IPersonalSourceConnector
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

    private readonly string _token;
    private readonly string? _spaceId;
    private readonly string? _repoId;
    private readonly string? _yuqueUrl;

    public PersonalYuqueConnector(string token, string? spaceId, string? repoId, string? yuqueUrl)
    {
        _token = token;
        _spaceId = spaceId;
        _repoId = repoId;
        _yuqueUrl = yuqueUrl;
    }

    public async Task<bool> TestConnectionAsync(CancellationToken ct)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(_repoId))
            {
                return await CheckRepoByIdAsync(_repoId, ct);
            }

            if (!string.IsNullOrWhiteSpace(_yuqueUrl))
            {
                return (await ResolveRepoByUrlAsync(_token, _yuqueUrl, ct)) != null;
            }

            var req = BuildYuqueRequest(HttpMethod.Get, "https://www.yuque.com/api/v2/user");
            var res = await Http.SendAsync(req, ct);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public async Task<SourceStats> CollectStatsAsync(DateTime from, DateTime to, CancellationToken ct)
    {
        var stats = new SourceStats
        {
            SourceType = PersonalSourceType.Yuque,
            CollectedAt = DateTime.UtcNow
        };

        var userLogin = await GetUserLoginAsync(ct) ?? "yuque-user";
        var repos = await GetTargetReposAsync(ct);
        if (repos.Count == 0) return stats;

        int articlesPublished = 0, docsUpdated = 0;

        foreach (var repoId in repos)
        {
            // 如果指定了 spaceId，只采集该空间
            if (!string.IsNullOrEmpty(_spaceId) && repoId != _spaceId)
                continue;

            var docs = await GetRecentDocsAsync(repoId, from, to, ct);
            foreach (var doc in docs)
            {
                if (doc.CreatedAt >= from && doc.CreatedAt <= to)
                {
                    articlesPublished++;
                    stats.Details.Add(new StatsDetail
                    {
                        Id = doc.Id,
                        Title = doc.Title,
                        Type = "article_published",
                        Assignee = userLogin,
                        Timestamp = doc.CreatedAt
                    });
                }
                else if (doc.UpdatedAt >= from && doc.UpdatedAt <= to)
                {
                    docsUpdated++;
                    stats.Details.Add(new StatsDetail
                    {
                        Id = doc.Id,
                        Title = doc.Title,
                        Type = "doc_updated",
                        Assignee = userLogin,
                        Timestamp = doc.UpdatedAt
                    });
                }
            }
        }

        stats.Summary["articles_published"] = articlesPublished;
        stats.Summary["docs_updated"] = docsUpdated;

        return stats;
    }

    /// <summary>
    /// 用 token + 语雀 URL 解析 repoId（用于创建/更新时落库）
    /// </summary>
    public static async Task<YuqueRepoRef?> ResolveRepoByUrlAsync(string token, string yuqueUrl, CancellationToken ct)
    {
        if (!YuqueUrlHelper.TryExtractNamespaceAndRepo(yuqueUrl, out var ns, out var repo))
            return null;

        var req = new HttpRequestMessage(HttpMethod.Get, $"https://www.yuque.com/api/v2/repos/{Uri.EscapeDataString(ns)}/{Uri.EscapeDataString(repo)}");
        req.Headers.Add("X-Auth-Token", token);
        req.Headers.UserAgent.ParseAdd("PrdAgent/2.0");

        var res = await Http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode) return null;

        var json = await res.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("data", out var data))
            return null;

        var repoId = data.TryGetProperty("id", out var id) ? id.GetRawText().Trim('"') : null;
        if (string.IsNullOrWhiteSpace(repoId))
            return null;

        var repoName = data.TryGetProperty("name", out var name) ? name.GetString() : null;
        var namespacePath = $"{ns}/{repo}";

        return new YuqueRepoRef
        {
            RepoId = repoId,
            RepoName = repoName,
            Namespace = namespacePath
        };
    }

    private async Task<List<string>> GetTargetReposAsync(CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(_repoId))
            return new List<string> { _repoId };

        if (!string.IsNullOrWhiteSpace(_yuqueUrl))
        {
            var resolved = await ResolveRepoByUrlAsync(_token, _yuqueUrl, ct);
            if (resolved != null)
                return new List<string> { resolved.RepoId };
        }

        var userLogin = await GetUserLoginAsync(ct);
        if (string.IsNullOrWhiteSpace(userLogin))
            return new List<string>();

        return await GetReposAsync(userLogin, ct);
    }

    private async Task<bool> CheckRepoByIdAsync(string repoId, CancellationToken ct)
    {
        var req = BuildYuqueRequest(HttpMethod.Get, $"https://www.yuque.com/api/v2/repos/{repoId}");
        var res = await Http.SendAsync(req, ct);
        return res.IsSuccessStatusCode;
    }

    private async Task<string?> GetUserLoginAsync(CancellationToken ct)
    {
        var request = BuildYuqueRequest(HttpMethod.Get, "https://www.yuque.com/api/v2/user");

        var response = await Http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) return null;

        var json = await response.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);

        return doc.RootElement.TryGetProperty("data", out var data) &&
               data.TryGetProperty("login", out var login)
            ? login.GetString()
            : null;
    }

    private async Task<List<string>> GetReposAsync(string userLogin, CancellationToken ct)
    {
        var repos = new List<string>();
        var request = BuildYuqueRequest(HttpMethod.Get, $"https://www.yuque.com/api/v2/users/{userLogin}/repos");

        var response = await Http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) return repos;

        var json = await response.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);

        if (doc.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            foreach (var repo in data.EnumerateArray())
            {
                if (repo.TryGetProperty("id", out var id))
                    repos.Add(id.GetRawText());
            }
        }

        return repos;
    }

    private async Task<List<YuqueDocInfo>> GetRecentDocsAsync(string repoId, DateTime from, DateTime to, CancellationToken ct)
    {
        var result = new List<YuqueDocInfo>();
        var request = BuildYuqueRequest(HttpMethod.Get, $"https://www.yuque.com/api/v2/repos/{repoId}/docs");

        var response = await Http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) return result;

        var json = await response.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);

        if (doc.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in data.EnumerateArray())
            {
                var createdAt = item.TryGetProperty("created_at", out var ca) && DateTime.TryParse(ca.GetString(), out var caDt) ? caDt : DateTime.MinValue;
                var updatedAt = item.TryGetProperty("updated_at", out var ua) && DateTime.TryParse(ua.GetString(), out var uaDt) ? uaDt : DateTime.MinValue;

                // 只收集时间范围内的文档
                if (createdAt >= from || updatedAt >= from)
                {
                    result.Add(new YuqueDocInfo
                    {
                        Id = item.TryGetProperty("id", out var id) ? id.GetRawText() : "",
                        Title = item.TryGetProperty("title", out var title) ? title.GetString() ?? "" : "",
                        CreatedAt = createdAt,
                        UpdatedAt = updatedAt
                    });
                }
            }
        }

        return result;
    }

    private HttpRequestMessage BuildYuqueRequest(HttpMethod method, string url)
    {
        var req = new HttpRequestMessage(method, url);
        req.Headers.Add("X-Auth-Token", _token);
        req.Headers.UserAgent.ParseAdd("PrdAgent/2.0");
        return req;
    }

    private class YuqueDocInfo
    {
        public string Id { get; set; } = "";
        public string Title { get; set; } = "";
        public DateTime CreatedAt { get; set; }
        public DateTime UpdatedAt { get; set; }
    }
}
