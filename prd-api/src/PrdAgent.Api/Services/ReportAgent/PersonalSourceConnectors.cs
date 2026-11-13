using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
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
/// 个人 GitHub 数据源连接器 — 通过 GitHub REST API 采集个人活动统计
/// </summary>
public class PersonalGitHubConnector : IPersonalSourceConnector
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private readonly HttpClient _http;
    private readonly string _token;
    private readonly string _username;
    private readonly string? _repoUrl;

    public PersonalGitHubConnector(string token, string username, string? repoUrl)
        : this(token, username, repoUrl, Http) { }

    internal PersonalGitHubConnector(string token, string username, string? repoUrl, HttpClient http)
    {
        _token = token;
        _username = username;
        _repoUrl = repoUrl;
        _http = http;
    }

    public async Task<bool> TestConnectionAsync(CancellationToken ct)
    {
        try
        {
            using var request = CreateRequest("https://api.github.com/user");
            using var response = await _http.SendAsync(request, ct);
            return response.IsSuccessStatusCode;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch { return false; }
    }

    public async Task<SourceStats> CollectStatsAsync(DateTime from, DateTime to, CancellationToken ct)
    {
        var stats = new SourceStats { SourceType = PersonalSourceType.GitHub, CollectedAt = DateTime.UtcNow };
        try
        {
            if (!string.IsNullOrEmpty(_repoUrl))
                await CollectRepoCommitsAsync(stats, from, to, ct);
            else
                await CollectUserEventsAsync(stats, from, to, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or OperationCanceledException)
        {
            stats.CollectionWarnings.Add("GitHub 来源采集未完成；已取得的明细只代表部分记录，不能据此判定无活动。");
        }
        return stats;
    }

    private async Task CollectRepoCommitsAsync(SourceStats stats, DateTime from, DateTime to, CancellationToken ct)
    {
        var (owner, repo) = ParseRepoUrl(_repoUrl!);
        if (owner == null || repo == null)
        {
            stats.CollectionWarnings.Add("GitHub 仓库地址无效，未取得可用活动数据。");
            return;
        }
        var url = $"https://api.github.com/repos/{owner}/{repo}/commits?author={Uri.EscapeDataString(_username)}&since={from:yyyy-MM-ddTHH:mm:ssZ}&until={to:yyyy-MM-ddTHH:mm:ssZ}&per_page=100";
        using var request = CreateRequest(url);
        using var response = await _http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
        {
            AddRequestWarning(stats, response);
            return;
        }
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        if (doc.RootElement.ValueKind != JsonValueKind.Array)
        {
            stats.CollectionWarnings.Add("GitHub 来源返回的数据格式无效，不能判定提交数量。");
            return;
        }
        if (doc.RootElement.GetArrayLength() >= 100)
            stats.CollectionWarnings.Add("GitHub 提交采集触及单页 100 条上限，周期完整性未证实。");
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            var sha = Text(item, "sha");
            if (string.IsNullOrWhiteSpace(sha))
            {
                stats.CollectionWarnings.Add("GitHub 返回了缺少完整提交身份的记录，该记录未计数。");
                continue;
            }
            var commit = Child(item, "commit");
            // committer.date is the actual commit timestamp; collection time is never a fallback.
            var timestamp = UtcDate(Text(Child(commit, "committer"), "date"));
            if (!timestamp.HasValue)
                stats.CollectionWarnings.Add("部分 GitHub 提交缺少提交时间，不按采集时间归入本期成果。");
            AddCommit(stats, new StatsDetail
            {
                Id = sha,
                Revision = sha,
                Title = Text(commit, "message")?.Split('\n')[0] ?? "",
                Type = "commit",
                EvidenceKind = "commit",
                SourceUrl = Text(item, "html_url"),
                Assignee = _username,
                Timestamp = timestamp,
                TimeBasis = "occurred"
            });
        }
        stats.Summary["commits"] = stats.Details.Count(d => d.Type == "commit");
    }

    private async Task CollectUserEventsAsync(SourceStats stats, DateTime from, DateTime to, CancellationToken ct)
    {
        var url = $"https://api.github.com/users/{Uri.EscapeDataString(_username)}/events?per_page=100";
        using var request = CreateRequest(url);
        using var response = await _http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
        {
            AddRequestWarning(stats, response);
            return;
        }
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        if (doc.RootElement.ValueKind != JsonValueKind.Array)
        {
            stats.CollectionWarnings.Add("GitHub 来源返回的数据格式无效，不能判定活动数量。");
            return;
        }
        if (doc.RootElement.GetArrayLength() >= 100)
            stats.CollectionWarnings.Add("GitHub 事件采集触及单页 100 条上限，周期完整性未证实。");
        var eventDates = doc.RootElement.EnumerateArray().Select(e => UtcDate(Text(e, "created_at"))).Where(t => t.HasValue).Select(t => t!.Value).ToList();
        if (eventDates.Count == 0 || eventDates.Min() > from)
            stats.CollectionWarnings.Add("GitHub 最近事件未覆盖到请求周期起点，不能将未返回的历史活动记为零。");
        var eventIds = new HashSet<string>(StringComparer.Ordinal);
        int pushCount = 0, prCount = 0;
        foreach (var ev in doc.RootElement.EnumerateArray())
        {
            var eventId = Text(ev, "id");
            if (eventId != null && !eventIds.Add(eventId)) continue;
            var created = UtcDate(Text(ev, "created_at"));
            if (!created.HasValue || created < from || created >= to) continue;
            var payload = Child(ev, "payload");
            switch (Text(ev, "type"))
            {
                case "PushEvent":
                    pushCount++;
                    if (payload.TryGetProperty("commits", out var commits) && commits.ValueKind == JsonValueKind.Array)
                        foreach (var commit in commits.EnumerateArray())
                        {
                            var sha = Text(commit, "sha");
                            if (string.IsNullOrWhiteSpace(sha)) continue;
                            AddCommit(stats, new StatsDetail
                            {
                                Id = sha,
                                Revision = sha,
                                Title = Text(commit, "message") ?? "",
                                Type = "commit",
                                EvidenceKind = "commit",
                                Assignee = _username,
                                SourceUrl = Text(commit, "url"),
                                // Push time is observable; original commit time is not supplied by this endpoint.
                                Timestamp = created,
                                TimeBasis = "observed"
                            });
                        }
                    break;
                case "PullRequestEvent":
                    prCount++;
                    var pr = Child(payload, "pull_request");
                    var prUrl = Text(pr, "html_url");
                    var merged = pr.TryGetProperty("merged", out var mergedValue) && mergedValue.ValueKind == JsonValueKind.True;
                    var action = Text(payload, "action");
                    var occurred = merged ? UtcDate(Text(pr, "merged_at")) : action == "opened" ? UtcDate(Text(pr, "created_at")) : created;
                    if (!occurred.HasValue)
                        stats.CollectionWarnings.Add("部分 GitHub PR 记录缺少事实发生时间，不能按采集时间认定本期进展。");
                    var workItemId = ResolvePullRequestWorkItem(pr, prUrl, stats.CollectionWarnings);
                    stats.Details.Add(new StatsDetail
                    {
                        Id = eventId ?? prUrl,
                        WorkItemId = workItemId,
                        SourceUrl = prUrl,
                        Title = Text(pr, "title") ?? "",
                        Type = "pull_request",
                        Status = merged ? "merged" : Text(pr, "state"),
                        Revision = merged ? Text(pr, "merge_commit_sha") : Text(Child(pr, "head"), "sha"),
                        EvidenceKind = merged ? "merged" : action == "opened" ? "started" : null,
                        Assignee = _username,
                        Timestamp = occurred,
                        TimeBasis = merged || action == "opened" ? "occurred" : "observed"
                    });
                    break;
            }
        }
        stats.Summary["commits"] = stats.Details.Where(d => d.Type == "commit").Select(d => d.Revision).Distinct().Count();
        stats.Summary["push_events"] = pushCount;
        stats.Summary["pr_events"] = prCount;
        stats.Summary["prs_merged"] = stats.Details.Where(d => d.Type == "pull_request" && d.Status == "merged" && d.SourceUrl != null).Select(d => d.SourceUrl).Distinct().Count();
    }

    private static readonly Regex ClosingPrefix = new(@"^ {0,3}(?:Fixes|Closes|Resolves)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex ClosingDirective = new(@"^ {0,3}(?:Fixes|Closes|Resolves)[ \t]+(?<ref>#[1-9][0-9]*|https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9_.-]+/issues/[1-9][0-9]*)[ \t]*[.!]?[ \t]*$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex CodeFence = new(@"^ {0,3}(?<fence>`{3,}|~{3,})", RegexOptions.CultureInvariant);

    /// <summary>只认明确的 GitHub 关闭指令；不从标题相似度推测功能归属。</summary>
    internal static string? ResolvePullRequestWorkItem(JsonElement pr, string? prUrl, List<string> warnings)
    {
        var body = Text(pr, "body");
        if (string.IsNullOrWhiteSpace(body)) return prUrl;
        var candidates = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        bool ambiguous = false;
        char fenceCharacter = '\0';
        int fenceLength = 0;
        foreach (var rawLine in body.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r');
            var fence = CodeFence.Match(line);
            if (fence.Success)
            {
                var marker = fence.Groups["fence"].Value;
                if (fenceCharacter == '\0') { fenceCharacter = marker[0]; fenceLength = marker.Length; }
                else if (marker[0] == fenceCharacter && marker.Length >= fenceLength && string.IsNullOrWhiteSpace(line[fence.Length..]))
                    fenceCharacter = '\0';
                continue;
            }
            if (fenceCharacter != '\0' || !ClosingPrefix.IsMatch(line)) continue;
            var directive = ClosingDirective.Match(line);
            if (!directive.Success) { ambiguous = true; continue; }
            var reference = directive.Groups["ref"].Value;
            if (reference.StartsWith('#'))
            {
                if (!Uri.TryCreate(prUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
                    !uri.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) || !string.IsNullOrEmpty(uri.UserInfo))
                { ambiguous = true; continue; }
                var path = uri.AbsolutePath.Trim('/').Split('/');
                if (path.Length != 4 || path[2] != "pull") { ambiguous = true; continue; }
                candidates.Add($"https://github.com/{path[0]}/{path[1]}/issues/{reference[1..]}");
            }
            else candidates.Add(reference);
        }
        if (!ambiguous && candidates.Count == 1) return candidates.Single();
        if (ambiguous || candidates.Count > 1)
            warnings.Add("GitHub PR 含多个或不明确的关闭事项引用，保留 PR 自身身份，需确认主要业务事项。");
        return prUrl;
    }

    private static void AddCommit(SourceStats stats, StatsDetail detail)
    {
        var existing = stats.Details.FindIndex(d => d.Type == "commit" && d.Revision == detail.Revision);
        if (existing < 0) stats.Details.Add(detail);
        else if (detail.Timestamp < stats.Details[existing].Timestamp) stats.Details[existing] = detail;
    }

    private HttpRequestMessage CreateRequest(string url)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        request.Headers.UserAgent.ParseAdd("PrdAgent/2.0");
        return request;
    }

    private static void AddRequestWarning(SourceStats stats, HttpResponseMessage response)
        => stats.CollectionWarnings.Add($"GitHub 来源请求失败（HTTP {(int)response.StatusCode}），未取得可用活动数据。");

    private static JsonElement Child(JsonElement item, string property)
        => item.ValueKind == JsonValueKind.Object && item.TryGetProperty(property, out var child) && child.ValueKind == JsonValueKind.Object
            ? child : EmptyObject;
    private static readonly JsonElement EmptyObject = JsonDocument.Parse("{}").RootElement.Clone();
    private static string? Text(JsonElement item, string property)
        => item.ValueKind == JsonValueKind.Object && item.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static DateTime? UtcDate(string? value)
    {
        var timeIndex = value?.IndexOf('T') ?? -1;
        var hasOffset = timeIndex >= 0 && (value!.EndsWith("Z", StringComparison.OrdinalIgnoreCase)
            || value.LastIndexOf('+') > timeIndex || value.LastIndexOf('-') > timeIndex);
        return hasOffset && DateTimeOffset.TryParse(value, out var timestamp) ? timestamp.UtcDateTime : null;
    }

    private static (string? owner, string? repo) ParseRepoUrl(string url)
    {
        if (Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps &&
            uri.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) && string.IsNullOrEmpty(uri.UserInfo))
        {
            var parts = uri.AbsolutePath.Trim('/').Split('/');
            if (parts.Length == 2)
                return (parts[0], parts[1].EndsWith(".git", StringComparison.Ordinal) ? parts[1][..^4] : parts[1]);
        }
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
    private readonly string? _spaceSelector;

    public PersonalYuqueConnector(string token, string? spaceId)
    {
        _token = token;
        _spaceSelector = NormalizeSpaceSelector(spaceId);
    }

    public async Task<bool> TestConnectionAsync(CancellationToken ct)
    {
        try
        {
            var request = new HttpRequestMessage(HttpMethod.Get, "https://www.yuque.com/api/v2/user");
            request.Headers.Add("X-Auth-Token", _token);
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
            SourceType = PersonalSourceType.Yuque,
            CollectedAt = DateTime.UtcNow
        };

        // 获取用户信息来确定 login
        var userLogin = await GetUserLoginAsync(ct);
        if (string.IsNullOrEmpty(userLogin)) return stats;

        // 获取知识库列表
        var repos = await GetReposAsync(userLogin, ct);

        int articlesPublished = 0, docsUpdated = 0;

        foreach (var repo in repos)
        {
            // 如果指定了 spaceId，只采集该空间
            if (!string.IsNullOrEmpty(_spaceSelector) && !IsRepoMatch(repo, _spaceSelector))
                continue;

            var repoKey = !string.IsNullOrWhiteSpace(repo.Id) ? repo.Id : repo.Namespace;
            if (string.IsNullOrWhiteSpace(repoKey))
                continue;

            var docs = await GetRecentDocsAsync(repoKey, from, to, ct);
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

    private async Task<string?> GetUserLoginAsync(CancellationToken ct)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "https://www.yuque.com/api/v2/user");
        request.Headers.Add("X-Auth-Token", _token);
        request.Headers.UserAgent.ParseAdd("PrdAgent/2.0");

        var response = await Http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) return null;

        var json = await response.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);

        return doc.RootElement.TryGetProperty("data", out var data) &&
               data.TryGetProperty("login", out var login)
            ? login.GetString()
            : null;
    }

    private async Task<List<YuqueRepoInfo>> GetReposAsync(string userLogin, CancellationToken ct)
    {
        var repos = new List<YuqueRepoInfo>();
        var request = new HttpRequestMessage(HttpMethod.Get, $"https://www.yuque.com/api/v2/users/{userLogin}/repos");
        request.Headers.Add("X-Auth-Token", _token);
        request.Headers.UserAgent.ParseAdd("PrdAgent/2.0");

        var response = await Http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) return repos;

        var json = await response.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);

        if (doc.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            foreach (var repo in data.EnumerateArray())
            {
                var id = ReadJsonScalarAsString(repo, "id");
                var repoNamespace = ReadJsonScalarAsString(repo, "namespace");
                var slug = ReadJsonScalarAsString(repo, "slug");
                var name = ReadJsonScalarAsString(repo, "name");

                if (!string.IsNullOrWhiteSpace(repoNamespace) && string.IsNullOrWhiteSpace(slug))
                    slug = repoNamespace.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault();

                if (string.IsNullOrWhiteSpace(id) && string.IsNullOrWhiteSpace(repoNamespace))
                    continue;

                repos.Add(new YuqueRepoInfo
                {
                    Id = id ?? string.Empty,
                    Namespace = repoNamespace ?? string.Empty,
                    Slug = slug ?? string.Empty,
                    Name = name ?? string.Empty
                });
            }
        }

        return repos;
    }

    private async Task<List<YuqueDocInfo>> GetRecentDocsAsync(string repoId, DateTime from, DateTime to, CancellationToken ct)
    {
        var result = new List<YuqueDocInfo>();
        var request = new HttpRequestMessage(HttpMethod.Get, $"https://www.yuque.com/api/v2/repos/{repoId}/docs");
        request.Headers.Add("X-Auth-Token", _token);
        request.Headers.UserAgent.ParseAdd("PrdAgent/2.0");

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

    private class YuqueDocInfo
    {
        public string Id { get; set; } = "";
        public string Title { get; set; } = "";
        public DateTime CreatedAt { get; set; }
        public DateTime UpdatedAt { get; set; }
    }

    private class YuqueRepoInfo
    {
        public string Id { get; set; } = "";
        public string Namespace { get; set; } = "";
        public string Slug { get; set; } = "";
        public string Name { get; set; } = "";
    }

    private static string? ReadJsonScalarAsString(JsonElement obj, string propertyName)
    {
        if (!obj.TryGetProperty(propertyName, out var value))
            return null;

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => null
        };
    }

    private static string? NormalizeSpaceSelector(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return null;

        var trimmed = raw.Trim();
        if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) &&
            uri.Host.Contains("yuque.com", StringComparison.OrdinalIgnoreCase))
        {
            var segments = uri.AbsolutePath
                .Split('/', StringSplitOptions.RemoveEmptyEntries)
                .Select(s => s.Trim())
                .Where(s => !string.IsNullOrWhiteSpace(s))
                .ToArray();

            if (segments.Length >= 2)
                return $"{segments[0]}/{segments[1]}";
            if (segments.Length == 1)
                return segments[0];
        }

        return trimmed.Trim('/');
    }

    private static bool IsRepoMatch(YuqueRepoInfo repo, string selector)
    {
        if (string.IsNullOrWhiteSpace(selector))
            return true;

        var normalized = selector.Trim().Trim('/');
        if (string.IsNullOrWhiteSpace(normalized))
            return true;

        if (string.Equals(repo.Id, normalized, StringComparison.OrdinalIgnoreCase))
            return true;
        if (!string.IsNullOrWhiteSpace(repo.Namespace) &&
            string.Equals(repo.Namespace, normalized, StringComparison.OrdinalIgnoreCase))
            return true;
        if (!string.IsNullOrWhiteSpace(repo.Slug) &&
            string.Equals(repo.Slug, normalized, StringComparison.OrdinalIgnoreCase))
            return true;

        var lastSegment = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
        if (!string.IsNullOrWhiteSpace(lastSegment) &&
            !string.IsNullOrWhiteSpace(repo.Slug) &&
            string.Equals(repo.Slug, lastSegment, StringComparison.OrdinalIgnoreCase))
            return true;

        return false;
    }
}
