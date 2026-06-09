using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.ProjectRouteAgent;

namespace PrdAgent.Infrastructure.Services.ChannelTraceAgent;

/// <summary>
/// 商品溯源智能体「代码扫描子 agent」：把内置的两个仓库（fc_codeapi / fc_YmSystem）浅克隆到本地缓存，
/// 再按关键词在代码文件里做轻量检索，返回相关文件 + 命中片段，供上层 LLM 做「描述 vs 代码」异同分析。
///
/// 设计取舍：项目暂无向量检索（RAG 未落地），先用关键词命中计数排序的确定性检索兜底（MVP 可接受）。
/// 仓库克隆复用 ProjectRouteAgent 的 <see cref="GitRepoCacheService"/>（depth=1 + 6h 缓存）。
/// </summary>
public sealed class ChannelTraceCodeScanService
{
    private const int MaxFileBytes = 256 * 1024;
    private const int MaxFilesScannedPerRepo = 4000;
    private const int DefaultMaxHits = 12;
    private const int SnippetContextLines = 6;
    private const int MaxSnippetChars = 1600;

    private static readonly HashSet<string> CodeExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".cs", ".ts", ".tsx", ".js", ".jsx", ".vue", ".java", ".kt", ".py", ".go", ".php",
        ".rb", ".rs", ".sql", ".json", ".xml", ".yaml", ".yml", ".razor", ".cshtml",
        ".html", ".css", ".scss", ".less", ".config", ".proto", ".sh",
    };

    private static readonly HashSet<string> SkipDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", "node_modules", "bin", "obj", "dist", "build", "out", "vendor", "packages",
        ".vs", ".idea", ".vscode", "wwwroot", "Migrations", "__pycache__", "target",
    };

    private readonly GitRepoCacheService _gitCache;
    private readonly IConfiguration _config;
    private readonly ILogger<ChannelTraceCodeScanService> _logger;

    public ChannelTraceCodeScanService(
        GitRepoCacheService gitCache,
        IConfiguration config,
        ILogger<ChannelTraceCodeScanService> logger)
    {
        _gitCache = gitCache;
        _config = config;
        _logger = logger;
    }

    public sealed class RepoConfig
    {
        public string Name { get; set; } = string.Empty;
        public string Url { get; set; } = string.Empty;
        public string Branch { get; set; } = "master";
    }

    public IReadOnlyList<RepoConfig> GetConfiguredRepos()
        => _config.GetSection("ChannelTrace:Repos").Get<List<RepoConfig>>() ?? new List<RepoConfig>();

    /// <summary>读取配置的服务级 GitHub PAT（建议用环境变量 ChannelTrace__GitHubToken 注入，勿提交明文）。</summary>
    public string? GetGitHubToken()
    {
        var t = _config["ChannelTrace:GitHubToken"];
        return string.IsNullOrWhiteSpace(t) ? null : t.Trim();
    }

    public sealed class RepoScanResult
    {
        public string Name { get; set; } = string.Empty;
        public string Branch { get; set; } = string.Empty;
        public string? Dir { get; set; }
        public string? Error { get; set; }
    }

    /// <summary>
    /// 确保所有配置仓库已克隆到本地缓存。每个仓库独立处理，单仓库失败不影响其它仓库。
    /// </summary>
    public async Task<List<RepoScanResult>> EnsureReposAsync(CancellationToken ct)
    {
        var token = GetGitHubToken();
        var results = new List<RepoScanResult>();
        foreach (var repo in GetConfiguredRepos())
        {
            if (string.IsNullOrWhiteSpace(repo.Url))
                continue;
            var branch = string.IsNullOrWhiteSpace(repo.Branch) ? "master" : repo.Branch;
            try
            {
                var dir = await _gitCache.EnsureClonedAsync(repo.Url, branch, token, ct);
                results.Add(new RepoScanResult { Name = repo.Name, Branch = branch, Dir = dir });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[ChannelTraceCodeScan] clone failed: {Repo}@{Branch}", repo.Url, branch);
                results.Add(new RepoScanResult { Name = repo.Name, Branch = branch, Error = ex.Message });
            }
        }
        return results;
    }

    /// <summary>
    /// 在已克隆的仓库目录里按关键词检索代码文件，返回命中评分最高的若干文件 + 片段。
    /// </summary>
    public List<ChannelTraceCodeHit> SearchRepo(string repoName, string repoDir, IReadOnlyList<string> keywords, int maxHits = DefaultMaxHits)
    {
        var normalizedKeywords = keywords
            .Where(k => !string.IsNullOrWhiteSpace(k))
            .Select(k => k.Trim().ToLowerInvariant())
            .Where(k => k.Length >= 2)
            .Distinct()
            .ToList();
        if (normalizedKeywords.Count == 0 || !Directory.Exists(repoDir))
            return new List<ChannelTraceCodeHit>();

        var scored = new List<(string Path, int Score, string[] Lines, string LowerContent)>();
        var scanned = 0;

        foreach (var file in EnumerateCodeFiles(repoDir))
        {
            if (scanned >= MaxFilesScannedPerRepo) break;
            scanned++;
            string content;
            try
            {
                var info = new FileInfo(file);
                if (info.Length > MaxFileBytes) continue;
                content = File.ReadAllText(file);
            }
            catch { continue; }

            var lower = content.ToLowerInvariant();
            var score = 0;
            foreach (var kw in normalizedKeywords)
            {
                var idx = 0;
                while ((idx = lower.IndexOf(kw, idx, StringComparison.Ordinal)) >= 0)
                {
                    score++;
                    idx += kw.Length;
                    if (score > 1000) break;
                }
            }
            if (score > 0)
            {
                var rel = Path.GetRelativePath(repoDir, file).Replace('\\', '/');
                scored.Add((rel, score, content.Split('\n'), lower));
            }
        }

        return scored
            .OrderByDescending(x => x.Score)
            .Take(maxHits)
            .Select(x => new ChannelTraceCodeHit
            {
                Repo = repoName,
                Path = x.Path,
                Score = x.Score,
                Snippet = BuildSnippet(x.Lines, x.LowerContent, normalizedKeywords),
            })
            .ToList();
    }

    private IEnumerable<string> EnumerateCodeFiles(string root)
    {
        var stack = new Stack<string>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            string[] subDirs;
            string[] files;
            try
            {
                subDirs = Directory.GetDirectories(dir);
                files = Directory.GetFiles(dir);
            }
            catch { continue; }

            foreach (var sub in subDirs)
            {
                var name = Path.GetFileName(sub);
                if (SkipDirs.Contains(name)) continue;
                stack.Push(sub);
            }
            foreach (var f in files)
            {
                if (CodeExtensions.Contains(Path.GetExtension(f)))
                    yield return f;
            }
        }
    }

    /// <summary>取首个命中关键词附近的若干行作为片段，带上下文，限制总长度。</summary>
    private static string BuildSnippet(string[] lines, string lowerContent, IReadOnlyList<string> keywords)
    {
        var hitLineIndexes = new List<int>();
        for (var i = 0; i < lines.Length && hitLineIndexes.Count < 4; i++)
        {
            var lowerLine = lines[i].ToLowerInvariant();
            if (keywords.Any(k => lowerLine.Contains(k)))
                hitLineIndexes.Add(i);
        }
        if (hitLineIndexes.Count == 0)
            return string.Join("\n", lines.Take(SnippetContextLines * 2));

        var ranges = new List<(int Start, int End)>();
        foreach (var idx in hitLineIndexes)
        {
            var start = Math.Max(0, idx - SnippetContextLines);
            var end = Math.Min(lines.Length - 1, idx + SnippetContextLines);
            if (ranges.Count > 0 && start <= ranges[^1].End + 1)
                ranges[^1] = (ranges[^1].Start, Math.Max(ranges[^1].End, end));
            else
                ranges.Add((start, end));
        }

        var sb = new System.Text.StringBuilder();
        foreach (var (start, end) in ranges)
        {
            for (var i = start; i <= end; i++)
            {
                sb.Append(i + 1).Append(": ").AppendLine(lines[i].TrimEnd());
                if (sb.Length >= MaxSnippetChars) break;
            }
            sb.AppendLine("…");
            if (sb.Length >= MaxSnippetChars) break;
        }
        var text = sb.ToString();
        return text.Length > MaxSnippetChars ? text[..MaxSnippetChars] + "…" : text;
    }
}
