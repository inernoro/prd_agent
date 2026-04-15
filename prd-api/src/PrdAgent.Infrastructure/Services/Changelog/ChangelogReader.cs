using System.Globalization;
using System.Net.Http;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace PrdAgent.Infrastructure.Services.Changelog;

/// <summary>
/// 单条更新记录（从 changelogs 碎片或 CHANGELOG.md 表格行解析）
/// 对应表格行格式：| type | module | description |
/// </summary>
public sealed class ChangelogEntry
{
    public string Type { get; set; } = string.Empty; // feat / fix / refactor / perf / docs ...
    public string Module { get; set; } = string.Empty; // prd-api / prd-admin / prd-desktop / prd-video / cds / doc ...
    public string Description { get; set; } = string.Empty;
}

/// <summary>
/// 一个 changelog 碎片文件（一次 PR 的所有变更）
/// </summary>
public sealed class ChangelogFragment
{
    public string FileName { get; set; } = string.Empty;
    public DateOnly Date { get; set; }
    public List<ChangelogEntry> Entries { get; set; } = new();
}

/// <summary>
/// 一个日条目（CHANGELOG.md 中的 ### YYYY-MM-DD 段落）
/// </summary>
public sealed class ChangelogDay
{
    public DateOnly Date { get; set; }
    public List<ChangelogEntry> Entries { get; set; } = new();
}

/// <summary>
/// 一个版本块（CHANGELOG.md 中的 ## [version] 段落）
/// </summary>
public sealed class ChangelogRelease
{
    public string Version { get; set; } = string.Empty; // "未发布" / "1.7.0" / ...
    public DateOnly? ReleaseDate { get; set; }
    /// <summary>用户更新项 highlights（版本块开头的 > - bullet 列表）</summary>
    public List<string> Highlights { get; set; } = new();
    public List<ChangelogDay> Days { get; set; } = new();
}

/// <summary>
/// "本周更新" 视图（基于 changelogs 碎片）
/// </summary>
public sealed class CurrentWeekView
{
    public DateOnly WeekStart { get; set; }
    public DateOnly WeekEnd { get; set; }
    public List<ChangelogFragment> Fragments { get; set; } = new();
    /// <summary>数据源是否可用</summary>
    public bool DataSourceAvailable { get; set; }
    /// <summary>数据来源标识："local" / "github" / "none"</summary>
    public string Source { get; set; } = "none";
    /// <summary>数据快照时间（拉取时刻）</summary>
    public DateTime FetchedAt { get; set; }
}

/// <summary>
/// "历史发布" 视图（基于 CHANGELOG.md）
/// </summary>
public sealed class ReleasesView
{
    public List<ChangelogRelease> Releases { get; set; } = new();
    public bool DataSourceAvailable { get; set; }
    public string Source { get; set; } = "none";
    public DateTime FetchedAt { get; set; }
}

/// <summary>
/// 从仓库的 changelogs/ 目录和 CHANGELOG.md 文件读取并解析更新记录。
///
/// 数据源策略（按优先级）：
/// 1. 本地文件（仓库内）：dev 模式快速命中，5 分钟缓存
/// 2. GitHub Contents API + raw.githubusercontent.com：生产 Docker 模式，24 小时缓存
///
/// 本地查找顺序：
/// - 配置项 Changelog:RootPath（绝对路径）
/// - 从 ContentRootPath 向上递归查找包含 changelogs/ 目录的祖先目录（最多 8 层）
/// - 从 AppContext.BaseDirectory 向上递归查找
///
/// GitHub 配置（appsettings 或环境变量）：
/// - Changelog:GitHubOwner   = "inernoro"  （默认）
/// - Changelog:GitHubRepo    = "prd_agent" （默认）
/// - Changelog:GitHubBranch  = "main"      （默认）
/// - Changelog:GitHubApiBase = "https://api.github.com"
/// - Changelog:GitHubRawBase = "https://raw.githubusercontent.com"
/// - Changelog:GitHubToken   = ""          （可选，提升速率限制）
/// - Changelog:CacheTtlHours = 24          （GitHub 路径的缓存 TTL）
/// </summary>
public interface IChangelogReader
{
    Task<CurrentWeekView> GetCurrentWeekAsync(bool force = false);
    Task<ReleasesView> GetReleasesAsync(int limit, bool force = false);
}

public sealed class ChangelogReader : IChangelogReader
{
    private readonly IMemoryCache _cache;
    private readonly IConfiguration _config;
    private readonly IHostEnvironment _env;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<ChangelogReader> _logger;

    private const string CacheKeyCurrentWeek = "changelog:current-week";
    private const string CacheKeyReleases = "changelog:releases";
    private static readonly TimeSpan LocalCacheTtl = TimeSpan.FromMinutes(5);

    // 文件名格式：YYYY-MM-DD_<short>.md
    private static readonly Regex FragmentFileNameRegex =
        new(@"^(\d{4})-(\d{2})-(\d{2})_.+\.md$", RegexOptions.Compiled);

    // 表格行：| type | module | description |（首尾空白容忍）
    private static readonly Regex TableRowRegex =
        new(@"^\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$", RegexOptions.Compiled);

    // 版本头：## [未发布]  或  ## [1.7.0] - 2026-03-20
    private static readonly Regex ReleaseHeaderRegex =
        new(@"^##\s*\[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$", RegexOptions.Compiled);

    // 日期头：### 2026-03-29
    private static readonly Regex DayHeaderRegex =
        new(@"^###\s*(\d{4}-\d{2}-\d{2})\s*$", RegexOptions.Compiled);

    // 用户更新项 bullet：> - xxx
    private static readonly Regex HighlightBulletRegex =
        new(@"^>\s*-\s*(.+?)\s*$", RegexOptions.Compiled);

    public ChangelogReader(
        IMemoryCache cache,
        IConfiguration config,
        IHostEnvironment env,
        IHttpClientFactory httpClientFactory,
        ILogger<ChangelogReader> logger)
    {
        _cache = cache;
        _config = config;
        _env = env;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    // ── 公共 API ──────────────────────────────────────────────────────

    public async Task<CurrentWeekView> GetCurrentWeekAsync(bool force = false)
    {
        if (!force && _cache.TryGetValue(CacheKeyCurrentWeek, out CurrentWeekView? cached) && cached != null)
        {
            return cached;
        }

        // 1) 本地优先（dev 快路径）
        // 注意：只要本地有 changelogs/ 目录就用本地（即使本周空），不向 GitHub 兜底
        var localView = BuildCurrentWeekViewFromLocal();
        if (localView.DataSourceAvailable)
        {
            _cache.Set(CacheKeyCurrentWeek, localView, LocalCacheTtl);
            return localView;
        }

        // 2) GitHub 兜底（生产 Docker 等无本地源场景）
        try
        {
            var githubView = await BuildCurrentWeekViewFromGitHubAsync().ConfigureAwait(false);
            if (githubView.DataSourceAvailable)
            {
                _cache.Set(CacheKeyCurrentWeek, githubView, GetGitHubCacheTtl());
                return githubView;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Changelog] GitHub 拉取本周更新失败");
        }

        // 3) 都失败：返回空视图（不缓存，下次重试）
        return new CurrentWeekView
        {
            WeekStart = ComputeWeekStart(),
            WeekEnd = ComputeWeekStart().AddDays(6),
            DataSourceAvailable = false,
            Source = "none",
            FetchedAt = DateTime.UtcNow,
        };
    }

    public async Task<ReleasesView> GetReleasesAsync(int limit, bool force = false)
    {
        var cacheKey = $"{CacheKeyReleases}:{limit}";
        if (!force && _cache.TryGetValue(cacheKey, out ReleasesView? cached) && cached != null)
        {
            return cached;
        }

        // 1) 本地优先
        var localView = BuildReleasesViewFromLocal(limit);
        if (localView.DataSourceAvailable)
        {
            _cache.Set(cacheKey, localView, LocalCacheTtl);
            return localView;
        }

        // 2) GitHub 兜底
        try
        {
            var githubView = await BuildReleasesViewFromGitHubAsync(limit).ConfigureAwait(false);
            if (githubView.DataSourceAvailable)
            {
                _cache.Set(cacheKey, githubView, GetGitHubCacheTtl());
                return githubView;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Changelog] GitHub 拉取历史发布失败");
        }

        return new ReleasesView
        {
            DataSourceAvailable = false,
            Source = "none",
            FetchedAt = DateTime.UtcNow,
        };
    }

    // ── 本地文件源 ────────────────────────────────────────────────────

    /// <summary>
    /// 找到包含 changelogs/ 子目录的根目录。返回 null 表示找不到。
    /// </summary>
    private string? ResolveLocalRoot()
    {
        // 1. 显式配置
        var configured = _config["Changelog:RootPath"];
        if (!string.IsNullOrWhiteSpace(configured) && Directory.Exists(Path.Combine(configured, "changelogs")))
        {
            return configured;
        }

        // 2. 从 ContentRootPath 向上找
        var fromContent = WalkUpForChangelogs(_env.ContentRootPath);
        if (fromContent != null) return fromContent;

        // 3. 从 AppContext.BaseDirectory 向上找
        var fromBase = WalkUpForChangelogs(AppContext.BaseDirectory);
        if (fromBase != null) return fromBase;

        return null;
    }

    private static string? WalkUpForChangelogs(string? start)
    {
        if (string.IsNullOrWhiteSpace(start)) return null;
        try
        {
            var dir = new DirectoryInfo(start);
            for (var i = 0; i < 8 && dir != null; i++, dir = dir.Parent)
            {
                if (Directory.Exists(Path.Combine(dir.FullName, "changelogs")))
                {
                    return dir.FullName;
                }
            }
        }
        catch
        {
            // 忽略权限/路径异常
        }
        return null;
    }

    private CurrentWeekView BuildCurrentWeekViewFromLocal()
    {
        var weekStart = ComputeWeekStart();
        var weekEnd = weekStart.AddDays(6);
        var view = new CurrentWeekView
        {
            WeekStart = weekStart,
            WeekEnd = weekEnd,
            Source = "local",
            FetchedAt = DateTime.UtcNow,
        };

        var root = ResolveLocalRoot();
        if (root == null)
        {
            view.DataSourceAvailable = false;
            return view;
        }

        view.DataSourceAvailable = true;

        var changelogsDir = Path.Combine(root, "changelogs");
        try
        {
            var files = Directory.GetFiles(changelogsDir, "*.md", SearchOption.TopDirectoryOnly);
            foreach (var file in files)
            {
                var fileName = Path.GetFileName(file);
                var date = ParseFragmentDate(fileName);
                if (date == null) continue;
                if (date < weekStart || date > weekEnd) continue;

                string content;
                try { content = File.ReadAllText(file); }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[Changelog] 读取碎片文件失败 {File}", fileName);
                    continue;
                }

                var entries = ParseTableRows(content);
                if (entries.Count == 0) continue;

                view.Fragments.Add(new ChangelogFragment
                {
                    FileName = fileName,
                    Date = date.Value,
                    Entries = entries,
                });
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Changelog] 扫描 changelogs/ 目录失败");
        }

        view.Fragments = SortFragments(view.Fragments);
        return view;
    }

    private ReleasesView BuildReleasesViewFromLocal(int limit)
    {
        var view = new ReleasesView
        {
            Source = "local",
            FetchedAt = DateTime.UtcNow,
        };

        var root = ResolveLocalRoot();
        if (root == null)
        {
            view.DataSourceAvailable = false;
            return view;
        }

        var changelogPath = Path.Combine(root, "CHANGELOG.md");
        if (!File.Exists(changelogPath))
        {
            view.DataSourceAvailable = false;
            return view;
        }

        view.DataSourceAvailable = true;

        string changelogText;
        try { changelogText = File.ReadAllText(changelogPath); }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Changelog] 读取 CHANGELOG.md 失败");
            view.DataSourceAvailable = false;
            return view;
        }

        view.Releases = ParseChangelogMarkdown(changelogText, limit);
        return view;
    }

    // ── GitHub 源 ─────────────────────────────────────────────────────

    private string GetGitHubOwner() => _config["Changelog:GitHubOwner"] ?? "inernoro";
    private string GetGitHubRepo() => _config["Changelog:GitHubRepo"] ?? "prd_agent";
    private string GetGitHubBranch() => _config["Changelog:GitHubBranch"] ?? "main";
    private string GetGitHubApiBase() => (_config["Changelog:GitHubApiBase"] ?? "https://api.github.com").TrimEnd('/');
    private string GetGitHubRawBase() => (_config["Changelog:GitHubRawBase"] ?? "https://raw.githubusercontent.com").TrimEnd('/');
    private string? GetGitHubToken() => _config["Changelog:GitHubToken"];

    private TimeSpan GetGitHubCacheTtl()
    {
        var hours = _config.GetValue<int?>("Changelog:CacheTtlHours") ?? 24;
        if (hours <= 0) hours = 24;
        return TimeSpan.FromHours(hours);
    }

    /// <summary>
    /// 创建 HttpClient（复用 Program.cs 注册的 "GitHubApi" 命名客户端，
    /// 已带 User-Agent / Accept / X-GitHub-Api-Version 头）。
    /// 注意：IHttpClientFactory 拥有 client 生命周期，调用方禁止 Dispose。
    /// Token 在每次请求时通过请求级 header 注入（避免污染 DefaultRequestHeaders）。
    /// </summary>
    private HttpClient CreateGitHubClient()
    {
        return _httpClientFactory.CreateClient("GitHubApi");
    }

    /// <summary>
    /// 创建带 token 的请求消息
    /// </summary>
    private HttpRequestMessage CreateGitHubApiRequest(HttpMethod method, string url)
    {
        var req = new HttpRequestMessage(method, url);
        var token = GetGitHubToken();
        if (!string.IsNullOrWhiteSpace(token))
        {
            req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
        }
        return req;
    }

    /// <summary>
    /// 用 raw URL 拉单个文本文件（不消耗 GitHub API 配额）
    /// </summary>
    private async Task<string?> FetchRawFileAsync(HttpClient client, string repoPath)
    {
        var owner = GetGitHubOwner();
        var repo = GetGitHubRepo();
        var branch = GetGitHubBranch();
        var rawBase = GetGitHubRawBase();
        var url = $"{rawBase}/{owner}/{repo}/{branch}/{repoPath}";
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            // raw.githubusercontent.com 也支持私有仓 token
            var token = GetGitHubToken();
            if (!string.IsNullOrWhiteSpace(token))
            {
                req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
            }
            using var resp = await client.SendAsync(req).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("[Changelog] GitHub raw 拉取失败 {Url} status={Status}", url, (int)resp.StatusCode);
                return null;
            }
            return await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Changelog] GitHub raw 拉取异常 {Url}", url);
            return null;
        }
    }

    /// <summary>
    /// GitHub Contents API：列出 changelogs/ 目录，返回所有文件名。
    /// 1 次 API 请求即可获得整个目录列表。
    /// </summary>
    private async Task<List<string>> ListChangelogFragmentsFromGitHubAsync(HttpClient client)
    {
        var owner = GetGitHubOwner();
        var repo = GetGitHubRepo();
        var branch = GetGitHubBranch();
        var apiBase = GetGitHubApiBase();
        var url = $"{apiBase}/repos/{owner}/{repo}/contents/changelogs?ref={branch}";

        try
        {
            using var req = CreateGitHubApiRequest(HttpMethod.Get, url);
            using var resp = await client.SendAsync(req).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("[Changelog] GitHub Contents API 失败 {Url} status={Status}", url, (int)resp.StatusCode);
                return new List<string>();
            }

            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
            {
                return new List<string>();
            }

            var names = new List<string>();
            foreach (var item in doc.RootElement.EnumerateArray())
            {
                if (item.TryGetProperty("type", out var typeProp) &&
                    typeProp.GetString() == "file" &&
                    item.TryGetProperty("name", out var nameProp))
                {
                    var name = nameProp.GetString();
                    if (!string.IsNullOrEmpty(name) && name.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
                    {
                        names.Add(name);
                    }
                }
            }
            return names;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Changelog] GitHub Contents API 异常 {Url}", url);
            return new List<string>();
        }
    }

    private async Task<CurrentWeekView> BuildCurrentWeekViewFromGitHubAsync()
    {
        var weekStart = ComputeWeekStart();
        var weekEnd = weekStart.AddDays(6);
        var view = new CurrentWeekView
        {
            WeekStart = weekStart,
            WeekEnd = weekEnd,
            Source = "github",
            FetchedAt = DateTime.UtcNow,
        };

        var client = CreateGitHubClient();

        var allNames = await ListChangelogFragmentsFromGitHubAsync(client).ConfigureAwait(false);
        if (allNames.Count == 0)
        {
            view.DataSourceAvailable = false;
            return view;
        }

        view.DataSourceAvailable = true;

        // 仅保留本周日期范围内的文件，避免下载 100+ 个文件
        var filtered = new List<(string name, DateOnly date)>();
        foreach (var name in allNames)
        {
            var date = ParseFragmentDate(name);
            if (date == null) continue;
            if (date < weekStart || date > weekEnd) continue;
            filtered.Add((name, date.Value));
        }

        // 并行下载本周内的碎片文件（数量很少，最多 7-10 个）
        var tasks = filtered.Select(async f =>
        {
            var content = await FetchRawFileAsync(client, $"changelogs/{f.name}").ConfigureAwait(false);
            if (string.IsNullOrEmpty(content)) return null;
            var entries = ParseTableRows(content);
            if (entries.Count == 0) return null;
            return new ChangelogFragment
            {
                FileName = f.name,
                Date = f.date,
                Entries = entries,
            };
        }).ToList();

        var results = await Task.WhenAll(tasks).ConfigureAwait(false);
        foreach (var fragment in results)
        {
            if (fragment != null) view.Fragments.Add(fragment);
        }

        view.Fragments = SortFragments(view.Fragments);
        return view;
    }

    private async Task<ReleasesView> BuildReleasesViewFromGitHubAsync(int limit)
    {
        var view = new ReleasesView
        {
            Source = "github",
            FetchedAt = DateTime.UtcNow,
        };

        var client = CreateGitHubClient();
        var content = await FetchRawFileAsync(client, "CHANGELOG.md").ConfigureAwait(false);
        if (content == null)
        {
            view.DataSourceAvailable = false;
            return view;
        }

        view.DataSourceAvailable = true;
        view.Releases = ParseChangelogMarkdown(content, limit);
        return view;
    }

    // ── 解析逻辑（local 与 github 共用） ──────────────────────────────

    private static DateOnly ComputeWeekStart()
    {
        var now = DateTime.Now;
        // 周一为周首（中国习惯）：Sunday=0, Monday=1, ..., Saturday=6
        var dayOfWeek = (int)now.DayOfWeek;
        var daysSinceMonday = (dayOfWeek + 6) % 7;
        return DateOnly.FromDateTime(now.AddDays(-daysSinceMonday));
    }

    private static DateOnly? ParseFragmentDate(string fileName)
    {
        var match = FragmentFileNameRegex.Match(fileName);
        if (!match.Success) return null;
        try
        {
            var year = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
            var month = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
            var day = int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
            return new DateOnly(year, month, day);
        }
        catch
        {
            return null;
        }
    }

    private static List<ChangelogFragment> SortFragments(List<ChangelogFragment> fragments)
    {
        return fragments
            .OrderByDescending(f => f.Date)
            .ThenByDescending(f => f.FileName, StringComparer.Ordinal)
            .ToList();
    }

    private static List<ChangelogRelease> ParseChangelogMarkdown(string changelogText, int limit)
    {
        var releases = new List<ChangelogRelease>();
        var lines = changelogText.Split('\n');

        ChangelogRelease? currentRelease = null;
        ChangelogDay? currentDay = null;
        var inHighlightSection = false;

        foreach (var rawLine in lines)
        {
            var line = rawLine.TrimEnd('\r');

            // 版本头
            var releaseMatch = ReleaseHeaderRegex.Match(line);
            if (releaseMatch.Success)
            {
                if (currentRelease != null)
                {
                    releases.Add(currentRelease);
                }
                currentRelease = new ChangelogRelease
                {
                    Version = releaseMatch.Groups[1].Value.Trim(),
                };
                if (releaseMatch.Groups[2].Success &&
                    DateOnly.TryParseExact(releaseMatch.Groups[2].Value, "yyyy-MM-dd", out var releaseDate))
                {
                    currentRelease.ReleaseDate = releaseDate;
                }
                currentDay = null;
                inHighlightSection = true;
                continue;
            }

            if (currentRelease == null) continue;

            // 用户更新项 highlights
            if (inHighlightSection && line.StartsWith(">", StringComparison.Ordinal))
            {
                var bulletMatch = HighlightBulletRegex.Match(line);
                if (bulletMatch.Success)
                {
                    currentRelease.Highlights.Add(bulletMatch.Groups[1].Value);
                }
                continue;
            }

            // 日期头
            var dayMatch = DayHeaderRegex.Match(line);
            if (dayMatch.Success)
            {
                inHighlightSection = false;
                if (DateOnly.TryParseExact(dayMatch.Groups[1].Value, "yyyy-MM-dd", out var date))
                {
                    currentDay = new ChangelogDay { Date = date };
                    currentRelease.Days.Add(currentDay);
                }
                continue;
            }

            // 表格行
            if (currentDay != null)
            {
                var entry = ParseTableRow(line);
                if (entry != null)
                {
                    currentDay.Entries.Add(entry);
                }
            }
        }

        if (currentRelease != null)
        {
            releases.Add(currentRelease);
        }

        // 去除空 day（仅有表头/分隔行）
        foreach (var release in releases)
        {
            release.Days.RemoveAll(d => d.Entries.Count == 0);
        }

        if (limit > 0 && releases.Count > limit)
        {
            releases = releases.Take(limit).ToList();
        }

        return releases;
    }

    private static List<ChangelogEntry> ParseTableRows(string content)
    {
        var result = new List<ChangelogEntry>();
        foreach (var rawLine in content.Split('\n'))
        {
            var entry = ParseTableRow(rawLine);
            if (entry != null) result.Add(entry);
        }
        return result;
    }

    /// <summary>
    /// 解析单行表格，返回 null 表示这不是一行有效的 entry（可能是表头、分隔线、空行等）。
    /// </summary>
    private static ChangelogEntry? ParseTableRow(string rawLine)
    {
        var line = rawLine.TrimEnd('\r');
        if (string.IsNullOrWhiteSpace(line)) return null;

        var match = TableRowRegex.Match(line);
        if (!match.Success) return null;

        var col1 = match.Groups[1].Value.Trim();
        var col2 = match.Groups[2].Value.Trim();
        var col3 = match.Groups[3].Value.Trim();

        // 跳过表头
        if (col1.Equals("类型", StringComparison.OrdinalIgnoreCase) ||
            col1.Equals("type", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        // 跳过分隔行：| --- | --- | --- |
        if (col1.All(c => c == '-' || c == ':' || char.IsWhiteSpace(c)) &&
            col2.All(c => c == '-' || c == ':' || char.IsWhiteSpace(c)))
        {
            return null;
        }

        // 三列都得有内容
        if (string.IsNullOrWhiteSpace(col1) || string.IsNullOrWhiteSpace(col2) || string.IsNullOrWhiteSpace(col3))
        {
            return null;
        }

        return new ChangelogEntry
        {
            Type = col1,
            Module = col2,
            Description = col3,
        };
    }
}
