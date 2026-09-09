using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.GitHub;

/// <summary>
/// per-user GitHub 连接的唯一判定源：连接状态、token 解密、仓库/分支/目录读取。
///
/// 为什么要有这一层：Device Flow 的 status/start/poll/disconnect 与「列仓库、列目录」
/// 此前在 pr-review、project-route-agent、tech-doc-format-agent 三个 Controller 里各抄了一份，
/// 改一处忘一处（predicate-and-wiring-discipline 形状 3）。新增能力一律走这里，
/// Controller 只负责把结果翻成 HTTP。
///
/// token 存 <see cref="GitHubUserConnection.AccessTokenEncrypted"/>（AES，密钥来自 Jwt:Secret），
/// 任何时候都不出本服务边界之外的日志。
/// </summary>
public sealed class GitHubUserConnectionService
{
    private const int MaxRepositoriesPageSize = 50;
    private const int MaxTreeItems = 300;

    private readonly MongoDbContext _db;
    private readonly IGitHubOAuthService _oauth;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _config;
    private readonly ILogger<GitHubUserConnectionService> _logger;

    public GitHubUserConnectionService(
        MongoDbContext db,
        IGitHubOAuthService oauth,
        IHttpClientFactory httpClientFactory,
        IConfiguration config,
        ILogger<GitHubUserConnectionService> logger)
    {
        _db = db;
        _oauth = oauth;
        _httpClientFactory = httpClientFactory;
        _config = config;
        _logger = logger;
    }

    /// <summary>管理员是否配置了 OAuth App（没配就连不了，前端要给出明确提示而不是空转）。</summary>
    public bool IsOAuthConfigured()
        => !string.IsNullOrWhiteSpace(_config["GitHubOAuth:ClientId"]);

    public async Task<GitHubUserConnection?> GetConnectionAsync(string userId, CancellationToken ct)
        => await _db.GitHubUserConnections.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);

    /// <summary>取出并解密当前用户的 access token；未连接 / 解不出来都抛 <see cref="GitHubException"/>。</summary>
    public async Task<string> ResolveTokenAsync(string userId, CancellationToken ct)
    {
        var conn = await GetConnectionAsync(userId, ct);
        if (conn == null || string.IsNullOrEmpty(conn.AccessTokenEncrypted))
        {
            throw GitHubException.NotConnected();
        }

        var jwtSecret = _config["Jwt:Secret"]
            ?? throw new InvalidOperationException("Jwt:Secret missing");
        var token = ApiKeyCrypto.Decrypt(conn.AccessTokenEncrypted, jwtSecret);
        if (string.IsNullOrEmpty(token))
        {
            throw GitHubException.TokenExpired();
        }
        return token;
    }

    /// <summary>Device Flow 成功后落库（同一用户覆盖旧连接）。</summary>
    public async Task<GitHubUserInfo> PersistConnectionAsync(
        string userId, string accessToken, string scope, CancellationToken ct)
    {
        var userInfo = await _oauth.FetchUserInfoAsync(accessToken, ct);
        var jwtSecret = _config["Jwt:Secret"]
            ?? throw new InvalidOperationException("Jwt:Secret missing");
        var encrypted = ApiKeyCrypto.Encrypt(accessToken, jwtSecret);

        var update = Builders<GitHubUserConnection>.Update
            .Set(x => x.UserId, userId)
            .Set(x => x.GitHubLogin, userInfo.Login)
            .Set(x => x.GitHubUserId, userInfo.Id.ToString())
            .Set(x => x.AvatarUrl, userInfo.AvatarUrl)
            .Set(x => x.AccessTokenEncrypted, encrypted)
            .Set(x => x.Scopes, scope)
            .Set(x => x.ConnectedAt, DateTime.UtcNow)
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"));

        await _db.GitHubUserConnections.UpdateOneAsync(
            Builders<GitHubUserConnection>.Filter.Eq(x => x.UserId, userId),
            update,
            new UpdateOptions { IsUpsert = true },
            ct);

        _logger.LogInformation("[GitHubConnect] connected user={UserId} login={Login}", userId, userInfo.Login);
        return userInfo;
    }

    public async Task<bool> DisconnectAsync(string userId, CancellationToken ct)
    {
        var result = await _db.GitHubUserConnections.DeleteOneAsync(x => x.UserId == userId, ct);
        return result.DeletedCount > 0;
    }

    public Task TouchLastUsedAsync(string userId, CancellationToken ct)
        => _db.GitHubUserConnections.UpdateOneAsync(
            x => x.UserId == userId,
            Builders<GitHubUserConnection>.Update.Set(x => x.LastUsedAt, DateTime.UtcNow),
            cancellationToken: ct);

    /// <summary>带 Bearer token 的 GitHub API 客户端（调用方负责 Dispose）。</summary>
    public HttpClient CreateApiClient(string accessToken)
    {
        var client = _httpClientFactory.CreateClient("GitHubApi");
        client.BaseAddress = new Uri("https://api.github.com/");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        client.DefaultRequestHeaders.Accept.Clear();
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        return client;
    }

    /// <summary>列出当前用户可访问的仓库（owner / collaborator / org member，按更新时间倒序）。</summary>
    public async Task<IReadOnlyList<GitHubRepositorySummary>> ListRepositoriesAsync(
        string token, string? query, int page, int pageSize, CancellationToken ct)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, MaxRepositoriesPageSize);

        using var client = CreateApiClient(token);
        var path = "user/repos?affiliation=owner,collaborator,organization_member"
                 + $"&sort=updated&direction=desc&per_page={pageSize}&page={page}";
        using var resp = await client.GetAsync(path, ct);
        await ThrowIfErrorAsync(resp, "读取仓库列表失败", ct);

        var repos = await resp.Content.ReadFromJsonAsync<List<GitHubRepositoryDto>>(cancellationToken: ct)
                    ?? [];

        var keyword = (query ?? string.Empty).Trim();
        if (keyword.Length > 0)
        {
            repos = repos.Where(r =>
                (r.FullName ?? string.Empty).Contains(keyword, StringComparison.OrdinalIgnoreCase)
                || (r.Description ?? string.Empty).Contains(keyword, StringComparison.OrdinalIgnoreCase))
                .ToList();
        }

        return repos.Select(r =>
        {
            var fullName = r.FullName ?? string.Empty;
            var parts = fullName.Split('/', 2);
            return new GitHubRepositorySummary
            {
                Id = r.Id,
                FullName = fullName,
                Owner = r.Owner?.Login ?? (parts.Length > 0 ? parts[0] : string.Empty),
                Repo = r.Name ?? (parts.Length > 1 ? parts[1] : string.Empty),
                Description = r.Description,
                IsPrivate = r.Private,
                DefaultBranch = r.DefaultBranch,
                HtmlUrl = r.HtmlUrl,
                UpdatedAt = r.UpdatedAt,
                OwnerAvatarUrl = r.Owner?.AvatarUrl,
            };
        }).ToList();
    }

    /// <summary>列出仓库分支（最多 100 条，够覆盖绝大多数仓库的选择场景）。</summary>
    public async Task<IReadOnlyList<GitHubBranchSummary>> ListBranchesAsync(
        string token, string owner, string repo, CancellationToken ct)
    {
        using var client = CreateApiClient(token);
        using var resp = await client.GetAsync(
            $"repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}/branches?per_page=100", ct);
        await ThrowIfErrorAsync(resp, $"读取 {owner}/{repo} 分支失败", ct);

        var branches = await resp.Content.ReadFromJsonAsync<List<GitHubBranchDto>>(cancellationToken: ct) ?? [];
        return branches
            .Where(b => !string.IsNullOrWhiteSpace(b.Name))
            .Select(b => new GitHubBranchSummary { Name = b.Name!, Protected = b.Protected })
            .ToList();
    }

    /// <summary>列出单层目录内容（自由浏览用）。</summary>
    public async Task<IReadOnlyList<GitHubContentSummary>> ListDirectoryAsync(
        string token, string owner, string repo, string? path, string? branch, CancellationToken ct)
    {
        var safePath = (path ?? string.Empty).Trim().Trim('/');
        using var client = CreateApiClient(token);

        var contentsPath = safePath.Length == 0
            ? $"repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}/contents"
            : $"repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}/contents/{EscapePath(safePath)}";
        if (!string.IsNullOrWhiteSpace(branch))
        {
            contentsPath += $"?ref={Uri.EscapeDataString(branch)}";
        }

        using var resp = await client.GetAsync(contentsPath, ct);
        await ThrowIfErrorAsync(resp, $"读取 {owner}/{repo}/{safePath} 失败", ct);

        var items = await resp.Content.ReadFromJsonAsync<List<GitHubContentDto>>(cancellationToken: ct) ?? [];
        return items
            .OrderByDescending(x => string.Equals(x.Type, "dir", StringComparison.OrdinalIgnoreCase))
            .ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
            .Take(MaxTreeItems)
            .Select(x => new GitHubContentSummary
            {
                Name = x.Name ?? string.Empty,
                Path = x.Path ?? string.Empty,
                Type = x.Type ?? string.Empty,
                Size = x.Size,
                HtmlUrl = x.HtmlUrl,
            })
            .ToList();
    }

    /// <summary>
    /// 一次 Git Trees API（recursive=1）拉全仓路径，折成可勾选的目录清单 + 默认预勾选集合。
    /// 判据全部在 <see cref="GitHubDocDirectoryPlanner"/> 里，本方法只负责取数。
    /// </summary>
    public async Task<GitHubDirectoryScan> ScanDirectoriesAsync(
        string token, string owner, string repo, string? branch, CancellationToken ct)
    {
        using var client = CreateApiClient(token);

        var resolvedBranch = branch;
        if (string.IsNullOrWhiteSpace(resolvedBranch))
        {
            using var repoResp = await client.GetAsync(
                $"repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}", ct);
            await ThrowIfErrorAsync(repoResp, $"读取 {owner}/{repo} 失败", ct);
            var meta = await repoResp.Content.ReadFromJsonAsync<GitHubRepositoryDto>(cancellationToken: ct);
            resolvedBranch = meta?.DefaultBranch ?? "main";
        }

        using var resp = await client.GetAsync(
            $"repos/{Uri.EscapeDataString(owner)}/{Uri.EscapeDataString(repo)}/git/trees/"
            + $"{Uri.EscapeDataString(resolvedBranch!)}?recursive=1", ct);
        await ThrowIfErrorAsync(resp, $"读取 {owner}/{repo}@{resolvedBranch} 目录树失败", ct);

        var tree = await resp.Content.ReadFromJsonAsync<GitHubTreeResponseDto>(cancellationToken: ct)
                   ?? new GitHubTreeResponseDto();

        var entries = (tree.Tree ?? [])
            .Where(t => !string.IsNullOrWhiteSpace(t.Path) && !string.IsNullOrWhiteSpace(t.Type))
            .Select(t => new GitHubTreeEntry(t.Path!, t.Type!));

        return GitHubDocDirectoryPlanner.BuildDirectories(
            entries, owner, repo, resolvedBranch!, truncatedUpstream: tree.Truncated);
    }

    /// <summary>GitHub 非 2xx 统一翻成领域异常，让 Controller 只用 catch 一种。</summary>
    public async Task ThrowIfErrorAsync(HttpResponseMessage resp, string message, CancellationToken ct)
    {
        if (resp.IsSuccessStatusCode) return;

        switch (resp.StatusCode)
        {
            case HttpStatusCode.Unauthorized:
                throw GitHubException.TokenExpired();
            case HttpStatusCode.Forbidden:
                throw GitHubException.Forbidden();
            case HttpStatusCode.NotFound:
                throw new GitHubException(GitHubErrorCodes.GITHUB_REPO_NOT_VISIBLE, 404, message);
            case (HttpStatusCode)429:
                throw GitHubException.RateLimited(null);
            default:
                var body = await resp.Content.ReadAsStringAsync(ct);
                _logger.LogWarning("[GitHubConnect] API failed: status={Status} body={Body}", (int)resp.StatusCode, body);
                throw GitHubException.Upstream((int)resp.StatusCode);
        }
    }

    private static string EscapePath(string path)
        => Uri.EscapeDataString(path).Replace("%2F", "/", StringComparison.Ordinal);

    // ===== 对外结果模型 =====

    public sealed class GitHubRepositorySummary
    {
        public long Id { get; init; }
        public string FullName { get; init; } = string.Empty;
        public string Owner { get; init; } = string.Empty;
        public string Repo { get; init; } = string.Empty;
        public string? Description { get; init; }
        public bool IsPrivate { get; init; }
        public string? DefaultBranch { get; init; }
        public string? HtmlUrl { get; init; }
        public DateTime? UpdatedAt { get; init; }
        public string? OwnerAvatarUrl { get; init; }
    }

    public sealed class GitHubBranchSummary
    {
        public string Name { get; init; } = string.Empty;
        public bool Protected { get; init; }
    }

    public sealed class GitHubContentSummary
    {
        public string Name { get; init; } = string.Empty;
        public string Path { get; init; } = string.Empty;
        public string Type { get; init; } = string.Empty;
        public long? Size { get; init; }
        public string? HtmlUrl { get; init; }
    }

    // ===== GitHub 原始 DTO =====

    private sealed class GitHubRepositoryDto
    {
        [JsonPropertyName("id")] public long Id { get; set; }
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("full_name")] public string? FullName { get; set; }
        [JsonPropertyName("private")] public bool Private { get; set; }
        [JsonPropertyName("description")] public string? Description { get; set; }
        [JsonPropertyName("html_url")] public string? HtmlUrl { get; set; }
        [JsonPropertyName("default_branch")] public string? DefaultBranch { get; set; }
        [JsonPropertyName("updated_at")] public DateTime? UpdatedAt { get; set; }
        [JsonPropertyName("owner")] public GitHubOwnerDto? Owner { get; set; }
    }

    private sealed class GitHubOwnerDto
    {
        [JsonPropertyName("login")] public string? Login { get; set; }
        [JsonPropertyName("avatar_url")] public string? AvatarUrl { get; set; }
    }

    private sealed class GitHubBranchDto
    {
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("protected")] public bool Protected { get; set; }
    }

    private sealed class GitHubContentDto
    {
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("path")] public string? Path { get; set; }
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("size")] public long? Size { get; set; }
        [JsonPropertyName("html_url")] public string? HtmlUrl { get; set; }
    }

    private sealed class GitHubTreeResponseDto
    {
        [JsonPropertyName("truncated")] public bool Truncated { get; set; }
        [JsonPropertyName("tree")] public List<GitHubTreeItemDto>? Tree { get; set; }
    }

    private sealed class GitHubTreeItemDto
    {
        [JsonPropertyName("path")] public string? Path { get; set; }
        [JsonPropertyName("type")] public string? Type { get; set; }
    }
}
