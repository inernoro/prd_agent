using System.Net.Http.Headers;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// GitHub REST API 连接器 — 拉取仓库提交记录
/// </summary>
public class GitHubConnector : ICodeSourceConnector
{
    private readonly ReportDataSource _source;
    private readonly string? _token;
    private readonly MongoDbContext _db;
    private readonly ILogger _logger;
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(30) };

    public GitHubConnector(ReportDataSource source, string? token, MongoDbContext db, ILogger logger)
    {
        _source = source;
        _token = token;
        _db = db;
        _logger = logger;
    }

    public async Task<bool> TestConnectionAsync(CancellationToken ct)
    {
        var (owner, repo) = ParseRepoUrl(_source.RepoUrl);
        var request = CreateRequest($"https://api.github.com/repos/{owner}/{repo}");
        var response = await Http.SendAsync(request, ct);
        return response.IsSuccessStatusCode;
    }

    public async Task<int> SyncAsync(CancellationToken ct)
    {
        var (owner, repo) = ParseRepoUrl(_source.RepoUrl);
        var branches = GetBranches();
        var since = _source.LastSyncAt?.ToString("o") ?? DateTime.UtcNow.AddDays(-30).ToString("o");
        var totalSynced = 0;

        foreach (var branch in branches)
        {
            var page = 1;
            bool hasMore;

            do
            {
                var url = $"https://api.github.com/repos/{owner}/{repo}/commits" +
                          $"?sha={Uri.EscapeDataString(branch)}&since={since}&per_page=100&page={page}";

                var request = CreateRequest(url);
                var response = await Http.SendAsync(request, ct);

                if (!response.IsSuccessStatusCode)
                {
                    var body = await response.Content.ReadAsStringAsync(ct);
                    throw new Exception($"GitHub API 返回 {response.StatusCode}: {body}");
                }

                var json = await response.Content.ReadAsStringAsync(ct);
                var commits = JsonDocument.Parse(json).RootElement;

                if (commits.ValueKind != JsonValueKind.Array || commits.GetArrayLength() == 0)
                    break;

                foreach (var commitJson in commits.EnumerateArray())
                {
                    var hash = commitJson.GetProperty("sha").GetString() ?? "";
                    var commitData = commitJson.GetProperty("commit");
                    var author = commitData.GetProperty("author");
                    var authorName = author.GetProperty("name").GetString() ?? "";
                    var authorEmail = author.GetProperty("email").GetString() ?? "";
                    var message = commitData.GetProperty("message").GetString() ?? "";
                    var dateStr = author.GetProperty("date").GetString();
                    var committedAt = DateTime.TryParse(dateStr, out var d) ? d : DateTime.UtcNow;

                    // 通过 UserMapping 映射用户
                    string? mappedUserId = null;
                    if (_source.UserMapping.TryGetValue(authorEmail, out var mapped))
                        mappedUserId = mapped;
                    else if (_source.UserMapping.TryGetValue(authorName, out mapped))
                        mappedUserId = mapped;

                    var commit = new ReportCommit
                    {
                        DataSourceId = _source.Id,
                        MappedUserId = mappedUserId,
                        AuthorName = authorName,
                        AuthorEmail = authorEmail,
                        CommitHash = hash,
                        Message = message.Length > 500 ? message[..500] : message,
                        CommittedAt = committedAt,
                        Branch = branch
                    };

                    // Upsert（幂等：DataSourceId+CommitHash 唯一索引）
                    try
                    {
                        await _db.ReportCommits.ReplaceOneAsync(
                            c => c.DataSourceId == _source.Id && c.CommitHash == hash,
                            commit,
                            new ReplaceOptions { IsUpsert = true },
                            ct);
                        totalSynced++;
                    }
                    catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
                    {
                        // 已存在，跳过
                    }
                }

                hasMore = commits.GetArrayLength() == 100;
                page++;

                // 安全限制：最多 2000 条/分支
                if (page > 20) break;

            } while (hasMore);
        }

        return totalSynced;
    }

    private HttpRequestMessage CreateRequest(string url)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.UserAgent.Add(new ProductInfoHeaderValue("PrdAgent", "1.0"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github.v3+json"));

        if (!string.IsNullOrEmpty(_token))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        }

        return request;
    }

    private string[] GetBranches()
    {
        if (string.IsNullOrWhiteSpace(_source.BranchFilter))
            return new[] { "main" };

        return _source.BranchFilter
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(b => !string.IsNullOrEmpty(b))
            .ToArray();
    }

    private static (string owner, string repo) ParseRepoUrl(string repoUrl)
    {
        // 支持格式: https://github.com/owner/repo 或 https://github.com/owner/repo.git
        var uri = repoUrl.TrimEnd('/');
        if (uri.EndsWith(".git"))
            uri = uri[..^4];

        var parts = uri.Split('/');
        if (parts.Length < 2)
            throw new ArgumentException($"无法解析仓库地址: {repoUrl}");

        return (parts[^2], parts[^1]);
    }
}
