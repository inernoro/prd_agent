using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// GitHub API 实现的 CodeProvider (MVP 阶段)
/// 使用 GitHub Search API / Contents API / Commits API 访问代码
/// </summary>
public class GitHubCodeProvider : ICodeProvider
{
    private readonly HttpClient _httpClient;
    private readonly string _owner;
    private readonly string _repo;
    private readonly string _defaultBranch;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    // 敏感路径黑名单
    private static readonly HashSet<string> BlockedPaths = new(StringComparer.OrdinalIgnoreCase)
    {
        ".env", ".env.local", ".env.production",
        "credentials.json", "secrets.json",
        "node_modules", ".git", "dist", "build"
    };

    public GitHubCodeProvider(string owner, string repo, string token, string defaultBranch = "main")
    {
        _owner = owner;
        _repo = repo;
        _defaultBranch = defaultBranch;
        _httpClient = new HttpClient
        {
            BaseAddress = new Uri("https://api.github.com/")
        };
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        _httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("PrdAgent-DefectBot/1.0");
        _httpClient.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github.v3+json");
    }

    public async Task<List<CodeSearchResult>> SearchAsync(
        string query, string? pathPrefix = null, string? fileExtension = null,
        int maxResults = 20, CancellationToken ct = default)
    {
        var q = $"{query} repo:{_owner}/{_repo}";
        if (!string.IsNullOrEmpty(pathPrefix)) q += $" path:{pathPrefix}";
        if (!string.IsNullOrEmpty(fileExtension)) q += $" extension:{fileExtension.TrimStart('.')}";

        var url = $"search/code?q={Uri.EscapeDataString(q)}&per_page={Math.Min(maxResults, 30)}";
        var response = await _httpClient.GetAsync(url, ct);
        if (!response.IsSuccessStatusCode) return new List<CodeSearchResult>();

        var json = await response.Content.ReadAsStringAsync(ct);
        var doc = JsonDocument.Parse(json);
        var results = new List<CodeSearchResult>();

        if (doc.RootElement.TryGetProperty("items", out var items))
        {
            foreach (var item in items.EnumerateArray())
            {
                var path = item.GetProperty("path").GetString() ?? "";
                if (IsBlocked(path)) continue;
                results.Add(new CodeSearchResult
                {
                    FilePath = path,
                    Context = item.TryGetProperty("text_matches", out _) ? "match" : null
                });
            }
        }

        return results;
    }

    public async Task<CodeFileContent> ReadFileAsync(
        string path, int? startLine = null, int? endLine = null, CancellationToken ct = default)
    {
        if (IsBlocked(path))
            return new CodeFileContent { FilePath = path, Content = "[BLOCKED: sensitive path]" };

        var url = $"repos/{_owner}/{_repo}/contents/{path}?ref={_defaultBranch}";
        var response = await _httpClient.GetAsync(url, ct);
        if (!response.IsSuccessStatusCode)
            return new CodeFileContent { FilePath = path, Content = $"[ERROR: {response.StatusCode}]" };

        var json = await response.Content.ReadAsStringAsync(ct);
        var doc = JsonDocument.Parse(json);
        var contentBase64 = doc.RootElement.GetProperty("content").GetString() ?? "";
        var content = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(contentBase64.Replace("\n", "")));

        var lines = content.Split('\n');
        var totalLines = lines.Length;

        if (startLine.HasValue || endLine.HasValue)
        {
            var start = Math.Max(0, (startLine ?? 1) - 1);
            var end = Math.Min(totalLines, endLine ?? totalLines);
            content = string.Join('\n', lines.Skip(start).Take(end - start));
        }

        return new CodeFileContent
        {
            FilePath = path,
            Content = content,
            TotalLines = totalLines,
            StartLine = startLine,
            EndLine = endLine
        };
    }

    public async Task<List<DirectoryEntry>> ListDirectoryAsync(
        string path, int depth = 2, string? pattern = null, CancellationToken ct = default)
    {
        var url = $"repos/{_owner}/{_repo}/contents/{path}?ref={_defaultBranch}";
        var response = await _httpClient.GetAsync(url, ct);
        if (!response.IsSuccessStatusCode) return new List<DirectoryEntry>();

        var json = await response.Content.ReadAsStringAsync(ct);
        var items = JsonSerializer.Deserialize<List<JsonElement>>(json, JsonOptions) ?? new();
        var results = new List<DirectoryEntry>();

        foreach (var item in items)
        {
            var name = item.GetProperty("name").GetString() ?? "";
            var itemPath = item.GetProperty("path").GetString() ?? "";
            var type = item.GetProperty("type").GetString() ?? "";

            if (IsBlocked(name) || IsBlocked(itemPath)) continue;
            if (!string.IsNullOrEmpty(pattern) && !MatchesPattern(name, pattern)) continue;

            var entry = new DirectoryEntry
            {
                Path = itemPath,
                Name = name,
                IsDirectory = type == "dir"
            };

            if (entry.IsDirectory && depth > 1)
            {
                entry.Children = await ListDirectoryAsync(itemPath, depth - 1, pattern, ct);
            }

            results.Add(entry);
        }

        return results;
    }

    public async Task<List<CodeSearchResult>> FindReferencesAsync(
        string symbol, string? pathPrefix = null, CancellationToken ct = default)
    {
        // Simulate find_references via code search
        return await SearchAsync(symbol, pathPrefix, maxResults: 30, ct: ct);
    }

    public async Task<List<GitCommitInfo>> GetGitLogAsync(
        string path, int count = 5, CancellationToken ct = default)
    {
        var url = $"repos/{_owner}/{_repo}/commits?path={Uri.EscapeDataString(path)}&per_page={count}";
        var response = await _httpClient.GetAsync(url, ct);
        if (!response.IsSuccessStatusCode) return new List<GitCommitInfo>();

        var json = await response.Content.ReadAsStringAsync(ct);
        var commits = JsonDocument.Parse(json);
        var results = new List<GitCommitInfo>();

        foreach (var commit in commits.RootElement.EnumerateArray())
        {
            var c = commit.GetProperty("commit");
            results.Add(new GitCommitInfo
            {
                Sha = commit.GetProperty("sha").GetString()?[..7] ?? "",
                Message = c.GetProperty("message").GetString() ?? "",
                Author = c.GetProperty("author").GetProperty("name").GetString() ?? "",
                Date = c.GetProperty("author").GetProperty("date").GetDateTime()
            });
        }

        return results;
    }

    private static bool IsBlocked(string path)
    {
        var segments = path.Split('/', '\\');
        return segments.Any(s => BlockedPaths.Contains(s));
    }

    private static bool MatchesPattern(string name, string pattern)
    {
        // Simple glob: *.tsx → ends with .tsx
        if (pattern.StartsWith("*"))
            return name.EndsWith(pattern[1..], StringComparison.OrdinalIgnoreCase);
        return name.Contains(pattern, StringComparison.OrdinalIgnoreCase);
    }
}

/// <summary>
/// CodeProvider 工厂实现
/// </summary>
public class CodeProviderFactory : ICodeProviderFactory
{
    public ICodeProvider Create(DefectRepoConfig repoConfig, string? token = null)
    {
        if (string.IsNullOrEmpty(token))
            throw new InvalidOperationException("GitHub token is required");

        return new GitHubCodeProvider(
            repoConfig.RepoOwner,
            repoConfig.RepoName,
            token,
            repoConfig.DefaultBranch);
    }
}
