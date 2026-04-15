using System.Globalization;
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
    /// <summary>数据源是否可用（false 表示找不到 changelogs 目录）</summary>
    public bool DataSourceAvailable { get; set; }
    /// <summary>已生效的数据源根目录（调试用，可能为 null）</summary>
    public string? SourceRoot { get; set; }
}

/// <summary>
/// "历史发布" 视图（基于 CHANGELOG.md）
/// </summary>
public sealed class ReleasesView
{
    public List<ChangelogRelease> Releases { get; set; } = new();
    public bool DataSourceAvailable { get; set; }
    public string? SourceRoot { get; set; }
}

/// <summary>
/// 从仓库的 changelogs/ 目录和 CHANGELOG.md 文件读取并解析更新记录。
/// 注意：本服务读取的是仓库内的 Markdown 文件，而非数据库。
/// 数据源根目录解析顺序：
/// 1. 配置项 Changelog:RootPath（绝对路径）
/// 2. 从 ContentRootPath 向上递归查找包含 changelogs/ 目录的祖先目录（最多 6 层）
/// 3. 从 AppContext.BaseDirectory 向上递归查找
/// 内存缓存 5 分钟。
/// </summary>
public interface IChangelogReader
{
    CurrentWeekView GetCurrentWeek();
    ReleasesView GetReleases(int limit);
}

public sealed class ChangelogReader : IChangelogReader
{
    private readonly IMemoryCache _cache;
    private readonly IConfiguration _config;
    private readonly IHostEnvironment _env;
    private readonly ILogger<ChangelogReader> _logger;

    private const string CacheKeyCurrentWeek = "changelog:current-week";
    private const string CacheKeyReleases = "changelog:releases";
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

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
        ILogger<ChangelogReader> logger)
    {
        _cache = cache;
        _config = config;
        _env = env;
        _logger = logger;
    }

    public CurrentWeekView GetCurrentWeek()
    {
        return _cache.GetOrCreate(CacheKeyCurrentWeek, entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = CacheTtl;
            return BuildCurrentWeekView();
        }) ?? new CurrentWeekView();
    }

    public ReleasesView GetReleases(int limit)
    {
        var cacheKey = $"{CacheKeyReleases}:{limit}";
        return _cache.GetOrCreate(cacheKey, entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = CacheTtl;
            return BuildReleasesView(limit);
        }) ?? new ReleasesView();
    }

    // ── 数据源根目录解析 ───────────────────────────────────────────────

    /// <summary>
    /// 找到包含 changelogs/ 子目录的根目录。返回 null 表示找不到。
    /// </summary>
    private string? ResolveSourceRoot()
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

    // ── current-week 解析 ─────────────────────────────────────────────

    private CurrentWeekView BuildCurrentWeekView()
    {
        var now = DateTime.Now;
        // 周一为周首（中国习惯）：Sunday=0, Monday=1, ..., Saturday=6
        // 想得到「今天距离本周一的天数」：Monday=0, Tuesday=1, ..., Sunday=6
        var dayOfWeek = (int)now.DayOfWeek; // 0..6
        var daysSinceMonday = (dayOfWeek + 6) % 7;
        var weekStart = DateOnly.FromDateTime(now.AddDays(-daysSinceMonday));
        var weekEnd = weekStart.AddDays(6);
        var view = new CurrentWeekView { WeekStart = weekStart, WeekEnd = weekEnd };

        var root = ResolveSourceRoot();
        if (root == null)
        {
            _logger.LogWarning("[Changelog] 未找到包含 changelogs/ 的源目录，返回空视图");
            return view;
        }

        view.DataSourceAvailable = true;
        view.SourceRoot = root;

        var changelogsDir = Path.Combine(root, "changelogs");
        try
        {
            var files = Directory.GetFiles(changelogsDir, "*.md", SearchOption.TopDirectoryOnly);
            foreach (var file in files)
            {
                var fileName = Path.GetFileName(file);
                var match = FragmentFileNameRegex.Match(fileName);
                if (!match.Success) continue;

                var year = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
                var month = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
                var day = int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
                DateOnly date;
                try { date = new DateOnly(year, month, day); }
                catch { continue; }

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
                    Date = date,
                    Entries = entries,
                });
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Changelog] 扫描 changelogs/ 目录失败");
        }

        // 按日期倒序、文件名倒序
        view.Fragments = view.Fragments
            .OrderByDescending(f => f.Date)
            .ThenByDescending(f => f.FileName, StringComparer.Ordinal)
            .ToList();

        return view;
    }

    // ── releases 解析 ─────────────────────────────────────────────────

    private ReleasesView BuildReleasesView(int limit)
    {
        var view = new ReleasesView();

        var root = ResolveSourceRoot();
        if (root == null)
        {
            return view;
        }

        var changelogPath = Path.Combine(root, "CHANGELOG.md");
        if (!File.Exists(changelogPath))
        {
            view.SourceRoot = root;
            return view;
        }

        view.DataSourceAvailable = true;
        view.SourceRoot = root;

        string[] lines;
        try { lines = File.ReadAllLines(changelogPath); }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Changelog] 读取 CHANGELOG.md 失败");
            return view;
        }

        ChangelogRelease? currentRelease = null;
        ChangelogDay? currentDay = null;
        var inHighlightSection = false;

        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];

            // 版本头
            var releaseMatch = ReleaseHeaderRegex.Match(line);
            if (releaseMatch.Success)
            {
                if (currentRelease != null)
                {
                    view.Releases.Add(currentRelease);
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
            view.Releases.Add(currentRelease);
        }

        // 去除空 day（仅有表头/分隔行）
        foreach (var release in view.Releases)
        {
            release.Days.RemoveAll(d => d.Entries.Count == 0);
        }

        // CHANGELOG.md 顺序天然就是新→旧，截断 limit 即可
        if (limit > 0 && view.Releases.Count > limit)
        {
            view.Releases = view.Releases.Take(limit).ToList();
        }

        return view;
    }

    // ── 表格行解析 ────────────────────────────────────────────────────

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
