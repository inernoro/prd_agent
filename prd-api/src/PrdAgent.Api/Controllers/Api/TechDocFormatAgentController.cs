using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.GitHub;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 技术分析文档格式校验 Agent。
/// GitHub 能力复用 per-user Device Flow 连接，供用户选择需求对应的仓库与项目路径。
/// </summary>
[ApiController]
[Route("api/tech-doc-format-agent")]
[Authorize]
[AdminController("tech-doc-format-agent", AdminPermissionCatalog.Access)]
public sealed class TechDocFormatAgentController : ControllerBase
{
    private const string AppKey = "tech-doc-format-agent";
    private const int MaxReposPageSize = 50;
    private const int MaxTreeItems = 200;
    private const int MaxContextFiles = 16;
    private const int MaxContextDepth = 2;
    private const int MaxContextFileBytes = 120_000;
    private const int MaxContextFileChars = 24_000;
    private static readonly string[] ContextFileExtensions =
    [
        ".md", ".txt", ".json", ".yml", ".yaml", ".csproj", ".sln", ".cs",
        ".ts", ".tsx", ".js", ".jsx", ".vue", ".config", ".props", ".targets"
    ];
    private static readonly string[] ContextFileNameHints =
    [
        "readme", "package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json",
        "dockerfile", "docker-compose", "program.cs", "startup.cs", "appsettings",
        "controller", "service", "route", "router"
    ];

    private readonly MongoDbContext _db;
    private readonly IGitHubOAuthService _oauth;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _config;
    private readonly ILogger<TechDocFormatAgentController> _logger;

    public TechDocFormatAgentController(
        MongoDbContext db,
        IGitHubOAuthService oauth,
        IHttpClientFactory httpClientFactory,
        IConfiguration config,
        ILogger<TechDocFormatAgentController> logger)
    {
        _db = db;
        _oauth = oauth;
        _httpClientFactory = httpClientFactory;
        _config = config;
        _logger = logger;
    }

    [HttpGet("github/auth/status")]
    public async Task<IActionResult> GetAuthStatus(CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var conn = await _db.GitHubUserConnections
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync(ct);

        if (conn == null)
        {
            return Ok(ApiResponse<object>.Ok(new
            {
                connected = false,
                oauthConfigured = IsOAuthConfigured(),
                appKey = AppKey,
            }));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            connected = true,
            oauthConfigured = IsOAuthConfigured(),
            appKey = AppKey,
            login = conn.GitHubLogin,
            avatarUrl = conn.AvatarUrl,
            scopes = conn.Scopes,
            connectedAt = conn.ConnectedAt,
            lastUsedAt = conn.LastUsedAt,
        }));
    }

    [HttpPost("github/auth/device/start")]
    public async Task<IActionResult> StartDeviceFlow(CancellationToken ct)
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

    [HttpPost("github/auth/device/poll")]
    public async Task<IActionResult> PollDeviceFlow([FromBody] TechDocDeviceFlowPollRequest req)
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
                    await PersistConnectionAsync(userId, result.AccessToken!, result.Scope ?? string.Empty);
                    return Ok(ApiResponse<object>.Ok(new { status = "done" }));
                default:
                    return Ok(ApiResponse<object>.Ok(new { status = "pending" }));
            }
        }
        catch (GitHubException ex)
        {
            return MapException(ex);
        }
    }

    [HttpGet("github/repositories")]
    public async Task<IActionResult> ListRepositories(
        [FromQuery] string? query,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 30,
        CancellationToken ct = default)
    {
        try
        {
            var userId = this.GetRequiredUserId();
            var token = await ResolveUserTokenAsync(userId, CancellationToken.None);
            page = Math.Max(1, page);
            pageSize = Math.Clamp(pageSize, 1, MaxReposPageSize);

            using var client = CreateGitHubClient(token);
            var path = $"user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page={pageSize}&page={page}";
            using var resp = await client.GetAsync(path, CancellationToken.None);
            await ThrowIfGitHubErrorAsync(resp, "读取仓库列表失败", CancellationToken.None);

            var repos = await resp.Content.ReadFromJsonAsync<List<TechDocGitHubRepositoryDto>>(cancellationToken: CancellationToken.None)
                ?? new List<TechDocGitHubRepositoryDto>();

            var keyword = (query ?? string.Empty).Trim();
            if (!string.IsNullOrWhiteSpace(keyword))
            {
                repos = repos
                    .Where(r =>
                        (r.FullName ?? string.Empty).Contains(keyword, StringComparison.OrdinalIgnoreCase)
                        || (r.Description ?? string.Empty).Contains(keyword, StringComparison.OrdinalIgnoreCase))
                    .ToList();
            }

            await TouchLastUsedAsync(userId, CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new
            {
                items = repos.Select(MapRepository),
                page,
                pageSize,
                hasMore = repos.Count >= pageSize,
            }));
        }
        catch (GitHubException ex)
        {
            return MapException(ex);
        }
    }

    [HttpGet("github/tree")]
    public async Task<IActionResult> GetRepositoryTree(
        [FromQuery] string owner,
        [FromQuery] string repo,
        [FromQuery] string? path,
        [FromQuery] string? branch,
        CancellationToken ct = default)
    {
        try
        {
            if (!PrUrlParser.IsSafeOwnerRepo(owner, repo))
            {
                return BadRequest(ApiResponse<object>.Fail(GitHubErrorCodes.PR_URL_INVALID, "owner/repo 含非法字符"));
            }

            var userId = this.GetRequiredUserId();
            var token = await ResolveUserTokenAsync(userId, CancellationToken.None);
            var safePath = NormalizePath(path);
            using var client = CreateGitHubClient(token);

            var contentsPath = string.IsNullOrWhiteSpace(safePath)
                ? $"repos/{owner}/{repo}/contents"
                : $"repos/{owner}/{repo}/contents/{Uri.EscapeDataString(safePath).Replace("%2F", "/", StringComparison.Ordinal)}";

            if (!string.IsNullOrWhiteSpace(branch))
            {
                contentsPath += $"?ref={Uri.EscapeDataString(branch)}";
            }

            using var resp = await client.GetAsync(contentsPath, CancellationToken.None);
            await ThrowIfGitHubErrorAsync(resp, $"读取 {owner}/{repo}/{safePath} 失败", CancellationToken.None);

            var text = await resp.Content.ReadAsStringAsync(CancellationToken.None);
            var items = System.Text.Json.JsonSerializer.Deserialize<List<TechDocGitHubContentDto>>(text)
                ?? new List<TechDocGitHubContentDto>();

            var normalized = items
                .OrderByDescending(x => string.Equals(x.Type, "dir", StringComparison.OrdinalIgnoreCase))
                .ThenBy(x => x.Name)
                .Take(MaxTreeItems)
                .Select(MapContent)
                .ToList();

            await TouchLastUsedAsync(userId, CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new
            {
                owner,
                repo,
                path = safePath,
                branch,
                items = normalized,
            }));
        }
        catch (GitHubException ex)
        {
            return MapException(ex);
        }
    }

    [HttpGet("github/context")]
    public async Task<IActionResult> GetRepositoryContext(
        [FromQuery] string owner,
        [FromQuery] string repo,
        [FromQuery] string? path,
        [FromQuery] string? branch,
        CancellationToken ct = default)
    {
        try
        {
            if (!PrUrlParser.IsSafeOwnerRepo(owner, repo))
            {
                return BadRequest(ApiResponse<object>.Fail(GitHubErrorCodes.PR_URL_INVALID, "owner/repo 含非法字符"));
            }

            var userId = this.GetRequiredUserId();
            var token = await ResolveUserTokenAsync(userId, CancellationToken.None);
            var safePath = NormalizePath(path);
            using var client = CreateGitHubClient(token);

            var files = await CollectContextFilesAsync(
                client,
                owner,
                repo,
                safePath,
                branch,
                depth: 0,
                CancellationToken.None);

            await TouchLastUsedAsync(userId, CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new
            {
                owner,
                repo,
                path = safePath,
                branch,
                files = files.Select(file => new
                {
                    file.Path,
                    file.Name,
                    file.Size,
                    file.Content,
                    file.Truncated,
                    file.HtmlUrl,
                }),
            }));
        }
        catch (GitHubException ex)
        {
            return MapException(ex);
        }
    }

    private async Task PersistConnectionAsync(string userId, string accessToken, string scope)
    {
        var userInfo = await _oauth.FetchUserInfoAsync(accessToken, CancellationToken.None);
        var jwtSecret = _config["Jwt:Secret"] ?? throw new InvalidOperationException("Jwt:Secret missing");
        var encrypted = ApiKeyCrypto.Encrypt(accessToken, jwtSecret);
        var now = DateTime.UtcNow;
        var filter = Builders<GitHubUserConnection>.Filter.Eq(x => x.UserId, userId);
        var update = Builders<GitHubUserConnection>.Update
            .Set(x => x.UserId, userId)
            .Set(x => x.GitHubLogin, userInfo.Login)
            .Set(x => x.GitHubUserId, userInfo.Id.ToString())
            .Set(x => x.AvatarUrl, userInfo.AvatarUrl)
            .Set(x => x.AccessTokenEncrypted, encrypted)
            .Set(x => x.Scopes, scope)
            .Set(x => x.ConnectedAt, now)
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"));

        await _db.GitHubUserConnections.UpdateOneAsync(
            filter,
            update,
            new UpdateOptions { IsUpsert = true },
            CancellationToken.None);

        _logger.LogInformation("TechDocFormatAgent GitHub connected: user={UserId} login={Login}", userId, userInfo.Login);
    }

    private async Task<string> ResolveUserTokenAsync(string userId, CancellationToken ct)
    {
        var conn = await _db.GitHubUserConnections
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync(ct);
        if (conn == null || string.IsNullOrEmpty(conn.AccessTokenEncrypted))
        {
            throw GitHubException.NotConnected();
        }

        var jwtSecret = _config["Jwt:Secret"] ?? throw new InvalidOperationException("Jwt:Secret missing");
        var token = ApiKeyCrypto.Decrypt(conn.AccessTokenEncrypted, jwtSecret);
        if (string.IsNullOrEmpty(token))
        {
            throw GitHubException.TokenExpired();
        }
        return token;
    }

    private HttpClient CreateGitHubClient(string accessToken)
    {
        var client = _httpClientFactory.CreateClient("GitHubApi");
        client.BaseAddress = new Uri("https://api.github.com/");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        client.DefaultRequestHeaders.Accept.Clear();
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        return client;
    }

    private async Task ThrowIfGitHubErrorAsync(HttpResponseMessage resp, string message, CancellationToken ct)
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
                _logger.LogWarning("TechDocFormatAgent GitHub API failed: status={Status} body={Body}", (int)resp.StatusCode, body);
                throw GitHubException.Upstream((int)resp.StatusCode);
        }
    }

    private async Task TouchLastUsedAsync(string userId, CancellationToken ct)
    {
        await _db.GitHubUserConnections.UpdateOneAsync(
            x => x.UserId == userId,
            Builders<GitHubUserConnection>.Update.Set(x => x.LastUsedAt, DateTime.UtcNow),
            cancellationToken: ct);
    }

    private bool IsOAuthConfigured()
    {
        return !string.IsNullOrWhiteSpace(_config["GitHubOAuth:ClientId"]);
    }

    private IActionResult MapException(GitHubException ex)
    {
        _logger.LogInformation("TechDocFormatAgent GitHub error: {Code} {Message}", ex.Code, ex.Message);
        return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.Code, ex.Message));
    }

    private static string NormalizePath(string? path)
    {
        return (path ?? string.Empty).Trim().Trim('/');
    }

    private static object MapRepository(TechDocGitHubRepositoryDto repo)
    {
        var fullName = repo.FullName ?? string.Empty;
        var parts = fullName.Split('/', 2);
        return new
        {
            id = repo.Id,
            name = repo.Name,
            fullName,
            owner = repo.Owner?.Login ?? (parts.Length > 0 ? parts[0] : string.Empty),
            repo = repo.Name ?? (parts.Length > 1 ? parts[1] : string.Empty),
            description = repo.Description,
            isPrivate = repo.Private,
            defaultBranch = repo.DefaultBranch,
            htmlUrl = repo.HtmlUrl,
            updatedAt = repo.UpdatedAt,
            ownerAvatarUrl = repo.Owner?.AvatarUrl,
        };
    }

    private static object MapContent(TechDocGitHubContentDto item) => new
    {
        name = item.Name,
        path = item.Path,
        type = item.Type,
        size = item.Size,
        htmlUrl = item.HtmlUrl,
    };

    private async Task<List<TechDocGitHubContextFile>> CollectContextFilesAsync(
        HttpClient client,
        string owner,
        string repo,
        string path,
        string? branch,
        int depth,
        CancellationToken ct)
    {
        if (depth > MaxContextDepth) return [];

        var contentsPath = string.IsNullOrWhiteSpace(path)
            ? $"repos/{owner}/{repo}/contents"
            : $"repos/{owner}/{repo}/contents/{Uri.EscapeDataString(path).Replace("%2F", "/", StringComparison.Ordinal)}";
        if (!string.IsNullOrWhiteSpace(branch))
        {
            contentsPath += $"?ref={Uri.EscapeDataString(branch)}";
        }

        using var resp = await client.GetAsync(contentsPath, ct);
        await ThrowIfGitHubErrorAsync(resp, $"读取 {owner}/{repo}/{path} 失败", ct);
        var text = await resp.Content.ReadAsStringAsync(ct);
        var items = System.Text.Json.JsonSerializer.Deserialize<List<TechDocGitHubContentDto>>(text)
            ?? new List<TechDocGitHubContentDto>();

        var files = new List<TechDocGitHubContextFile>();
        foreach (var item in RankContextCandidates(items))
        {
            if (files.Count >= MaxContextFiles) break;

            if (string.Equals(item.Type, "file", StringComparison.OrdinalIgnoreCase) && IsContextFile(item))
            {
                var file = await FetchContextFileAsync(client, item, ct);
                if (file != null) files.Add(file);
            }
            else if (string.Equals(item.Type, "dir", StringComparison.OrdinalIgnoreCase)
                && depth < MaxContextDepth
                && IsUsefulContextDirectory(item.Name))
            {
                var nested = await CollectContextFilesAsync(
                    client,
                    owner,
                    repo,
                    item.Path ?? string.Empty,
                    branch,
                    depth + 1,
                    ct);
                files.AddRange(nested.Take(MaxContextFiles - files.Count));
            }
        }
        return files.Take(MaxContextFiles).ToList();
    }

    private async Task<TechDocGitHubContextFile?> FetchContextFileAsync(
        HttpClient client,
        TechDocGitHubContentDto item,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(item.DownloadUrl)) return null;
        if (item.Size is > MaxContextFileBytes) return null;

        using var resp = await client.GetAsync(item.DownloadUrl, ct);
        if (!resp.IsSuccessStatusCode) return null;

        var content = await resp.Content.ReadAsStringAsync(ct);
        var truncated = content.Length > MaxContextFileChars;
        if (truncated) content = content[..MaxContextFileChars] + "\n\n[... 文件内容已截断 ...]";

        return new TechDocGitHubContextFile
        {
            Name = item.Name ?? string.Empty,
            Path = item.Path ?? item.Name ?? string.Empty,
            Size = item.Size,
            HtmlUrl = item.HtmlUrl,
            Content = content,
            Truncated = truncated,
        };
    }

    private static IEnumerable<TechDocGitHubContentDto> RankContextCandidates(IEnumerable<TechDocGitHubContentDto> items)
    {
        return items.OrderByDescending(item => ContextScore(item)).ThenBy(item => item.Name);
    }

    private static int ContextScore(TechDocGitHubContentDto item)
    {
        var name = (item.Name ?? string.Empty).ToLowerInvariant();
        var path = (item.Path ?? string.Empty).ToLowerInvariant();
        var score = 0;
        if (string.Equals(item.Type, "dir", StringComparison.OrdinalIgnoreCase)) score += 20;
        if (ContextFileNameHints.Any(hint => name.Contains(hint) || path.Contains(hint))) score += 50;
        if (name.StartsWith("readme")) score += 80;
        if (name.EndsWith(".csproj") || name.EndsWith(".sln") || name == "package.json") score += 70;
        if (path.Contains("controller") || path.Contains("service") || path.Contains("src/")) score += 20;
        return score;
    }

    private static bool IsContextFile(TechDocGitHubContentDto item)
    {
        var name = item.Name ?? string.Empty;
        var lower = name.ToLowerInvariant();
        return ContextFileExtensions.Any(ext => lower.EndsWith(ext, StringComparison.Ordinal))
            || ContextFileNameHints.Any(hint => lower.Contains(hint));
    }

    private static bool IsUsefulContextDirectory(string? name)
    {
        var lower = (name ?? string.Empty).ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(lower)) return false;
        if (lower is "node_modules" or "bin" or "obj" or "dist" or "build" or ".git") return false;
        return lower is "src" or "app" or "api" or "backend" or "frontend" or "controllers" or "services"
            or "pages" or "components" or "lib" or "docs" or "doc" or "miduo-md"
            || lower.Contains("service")
            || lower.Contains("controller")
            || lower.Contains("api");
    }
}

public sealed class TechDocDeviceFlowPollRequest
{
    public string? FlowToken { get; set; }
}

internal sealed class TechDocGitHubRepositoryDto
{
    [JsonPropertyName("id")]
    public long Id { get; set; }

    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("full_name")]
    public string? FullName { get; set; }

    [JsonPropertyName("private")]
    public bool Private { get; set; }

    [JsonPropertyName("description")]
    public string? Description { get; set; }

    [JsonPropertyName("html_url")]
    public string? HtmlUrl { get; set; }

    [JsonPropertyName("default_branch")]
    public string? DefaultBranch { get; set; }

    [JsonPropertyName("updated_at")]
    public DateTime? UpdatedAt { get; set; }

    [JsonPropertyName("owner")]
    public TechDocGitHubOwnerDto? Owner { get; set; }
}

internal sealed class TechDocGitHubOwnerDto
{
    [JsonPropertyName("login")]
    public string? Login { get; set; }

    [JsonPropertyName("avatar_url")]
    public string? AvatarUrl { get; set; }
}

internal sealed class TechDocGitHubContentDto
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("path")]
    public string? Path { get; set; }

    [JsonPropertyName("type")]
    public string? Type { get; set; }

    [JsonPropertyName("size")]
    public long? Size { get; set; }

    [JsonPropertyName("html_url")]
    public string? HtmlUrl { get; set; }

    [JsonPropertyName("download_url")]
    public string? DownloadUrl { get; set; }
}

internal sealed class TechDocGitHubContextFile
{
    public string Name { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public long? Size { get; set; }
    public string? HtmlUrl { get; set; }
    public string Content { get; set; } = string.Empty;
    public bool Truncated { get; set; }
}
