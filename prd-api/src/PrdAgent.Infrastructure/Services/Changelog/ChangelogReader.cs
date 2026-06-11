using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
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
    /// <summary>
    /// 该日期对应的最新 GitHub commit 时间（秒级精度，UTC）。
    /// 通过 GitHub Commits API 获取 CHANGELOG.md 的提交历史后，按日期取该日最后一次提交。
    /// 仅 GitHub 源可用；本地源无法获取 commit 时间时为 null。
    /// </summary>
    public DateTime? CommitTimeUtc { get; set; }
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
/// 更新中心视图公共契约：数据源可用性 + 来源 + 拉取时间。
/// 终身存储 / 推送逻辑据此统一处理三种视图。
/// </summary>
public interface IChangelogView
{
    bool DataSourceAvailable { get; }
    string Source { get; }
    DateTime FetchedAt { get; }
}

/// <summary>
/// "待发布" 视图（基于 changelogs 碎片）
/// </summary>
public sealed class CurrentWeekView : IChangelogView
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
public sealed class ReleasesView : IChangelogView
{
    public List<ChangelogRelease> Releases { get; set; } = new();
    public bool DataSourceAvailable { get; set; }
    public string Source { get; set; } = "none";
    public DateTime FetchedAt { get; set; }
}

/// <summary>
/// GitHub 日志单条记录（本地 git log 或 GitHub commits API）
/// </summary>
public sealed class GitHubLogEntry
{
    public string Sha { get; set; } = string.Empty;
    public string ShortSha { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
    public string AuthorName { get; set; } = string.Empty;
    public string? AuthorAvatarUrl { get; set; }
    /// <summary>commit message 里 Co-authored-by trailer 的联合作者名（已去邮箱、去重、剔除与主作者同人）</summary>
    public List<string> CoAuthorNames { get; set; } = new();
    public DateTime CommitTimeUtc { get; set; }
    public string HtmlUrl { get; set; } = string.Empty;
}

/// <summary>
/// GitHub 日志视图
/// </summary>
public sealed class GitHubLogsView : IChangelogView
{
    public List<GitHubLogEntry> Logs { get; set; } = new();
    /// <summary>
    /// 仓库全历史提交总数（不受「最近一周」窗口限制）。
    /// 本地源走 git rev-list --count（浅克隆数不准则置 null 由 GitHub 兜底），
    /// GitHub 源用 commits?per_page=1 的 Link header rel="last" 页码反推。
    /// null = 暂未统计成功，前端应降级展示窗口内条数。
    /// </summary>
    public int? RepoTotalCommitCount { get; set; }
    public bool DataSourceAvailable { get; set; }
    public string Source { get; set; } = "none";
    public DateTime FetchedAt { get; set; }
}

/// <summary>
/// 从仓库的 changelogs/ 目录和 CHANGELOG.md 文件读取并解析更新记录。
///
/// 数据源策略（按优先级）：
/// 1. 本地文件（仓库内）：dev 模式快速命中，5 分钟缓存
/// 2. GitHub Contents API + raw.githubusercontent.com：生产 Docker 模式，默认 5 分钟缓存
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
/// - Changelog:CacheTtlMinutes = 5         （GitHub 路径的缓存 TTL）
/// - Changelog:CacheTtlHours = 24          （兼容旧配置；仅显式配置时生效）
/// </summary>
public interface IChangelogReader
{
    Task<CurrentWeekView> GetCurrentWeekAsync(bool force = false);
    Task<ReleasesView> GetReleasesAsync(int limit, bool force = false);
    Task<GitHubLogsView> GetGitHubLogsAsync(int limit, bool force = false);

    /// <summary>
    /// 后台 Worker 专用：强制刷新全部三个视图（待发布 / 历史发布 / GitHub 日志），
    /// 内部走 force 路径 → 重新拉取 → 落库（内容变化才推送）。供固定周期刷新调用。
    /// </summary>
    Task RefreshAllAsync(int releasesLimit, int githubLogsLimit, CancellationToken ct = default);

    /// <summary>当前配置的后台刷新周期（小时），供前端「更新规则」展示。</summary>
    int GetRefreshIntervalHours();
}

public sealed class ChangelogReader : IChangelogReader
{
    private readonly IMemoryCache _cache;
    private readonly IConfiguration _config;
    private readonly IHostEnvironment _env;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<ChangelogReader> _logger;
    // 终身存储 + 推送（生产注入；单元测试可为 null，退化为纯内存 SWR）
    private readonly IChangelogSnapshotStore? _snapshotStore;
    private readonly IChangelogPushHub? _pushHub;

    private const string CacheKeyCurrentWeek = "changelog:current-week";
    private const string CacheKeyReleases = "changelog:releases";
    private const string CacheKeyGitHubLogs = "changelog:github-logs";

    /// <summary>默认后台刷新周期（小时）。可由 Changelog:RefreshIntervalHours 覆盖。</summary>
    private const int DefaultRefreshIntervalHours = 4;

    // 快照序列化：camelCase + 大小写不敏感，保证「序列化 → 存库 → 反序列化」无损往返。
    private static readonly JsonSerializerOptions SnapshotJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    // 「待发布」碎片走 GitHub raw 逐文件拉取，碎片数可能达数百个。限并发避免上百个
    // 并发连接打爆连接池 / 触发限速导致冷缓存首屏长时间转圈（卡顿排查 2026-06-03）。
    private const int MaxGitHubFetchConcurrency = 8;

    // serve-stale-while-revalidate（业界通行做法，见 web.dev / RFC 5861 / .NET HybridCache 防击穿）：
    //  - 新鲜期（GetFreshWindow，默认 5 分钟）内：直接返回缓存，不刷新
    //  - 新鲜期过后、保留期（StaleKeepWindow，24 小时）内：先返回旧值、再后台静默刷新（用户不等待）
    //  - 保留期作为 IMemoryCache 绝对过期时间，超过才真正丢弃，下一次请求才同步拉取
    // 这样除了「首次启动且尚未预热」这一种情况外，用户几乎永远不会卡在 GitHub/磁盘拉取上。
    private static readonly TimeSpan StaleKeepWindow = TimeSpan.FromHours(24);

    // 按 cacheKey 串行化「真实拉取」，避免缓存过期瞬间并发请求同时打满 GitHub（惊群/stampede）
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _fetchLocks = new();
    // 标记某个 cacheKey 是否已有后台刷新在跑，避免重复刷新
    private readonly ConcurrentDictionary<string, byte> _refreshing = new();

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
        ILogger<ChangelogReader> logger,
        IChangelogSnapshotStore? snapshotStore = null,
        IChangelogPushHub? pushHub = null)
    {
        _cache = cache;
        _config = config;
        _env = env;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _snapshotStore = snapshotStore;
        _pushHub = pushHub;
    }

    // ── 视图类型标识（用于 SSE 推送 viewType 字段） ───────────────────
    private const string ViewTypeCurrentWeek = "current-week";
    private const string ViewTypeReleases = "releases";
    private const string ViewTypeGitHubLogs = "github-logs";

    // ── 公共 API（终身存储优先：加载只读存量，刷新交给后台 Worker） ─────

    public Task<CurrentWeekView> GetCurrentWeekAsync(bool force = false) =>
        GetStoredAsync(ViewTypeCurrentWeek, CacheKeyCurrentWeek, force, FetchCurrentWeekAsync);

    public Task<ReleasesView> GetReleasesAsync(int limit, bool force = false)
    {
        var cacheKey = $"{CacheKeyReleases}:{limit}";
        return GetStoredAsync(ViewTypeReleases, cacheKey, force, () => FetchReleasesAsync(limit));
    }

    public Task<GitHubLogsView> GetGitHubLogsAsync(int limit, bool force = false)
    {
        if (limit <= 0 || limit > 1000) limit = 1000;
        var cacheKey = $"{CacheKeyGitHubLogs}:{limit}";
        return GetStoredAsync(ViewTypeGitHubLogs, cacheKey, force, () => FetchGitHubLogsAsync(limit));
    }

    public async Task RefreshAllAsync(int releasesLimit, int githubLogsLimit, CancellationToken ct = default)
    {
        // force=true → 走真实拉取 → 落库（内容变化才推送）。三个视图各自独立，互不阻塞失败。
        await GetCurrentWeekAsync(force: true).ConfigureAwait(false);
        if (ct.IsCancellationRequested) return;
        await GetReleasesAsync(releasesLimit, force: true).ConfigureAwait(false);
        if (ct.IsCancellationRequested) return;
        await GetGitHubLogsAsync(githubLogsLimit, force: true).ConfigureAwait(false);
    }

    public int GetRefreshIntervalHours()
    {
        var h = _config.GetValue<int?>("Changelog:RefreshIntervalHours");
        return h is > 0 ? h.Value : DefaultRefreshIntervalHours;
    }

    // ── 终身存储 + SWR 核心 ───────────────────────────────────────────

    private sealed class CacheEntry<T>
    {
        public required T Value { get; init; }
        public required DateTime FetchedAt { get; init; }
    }

    /// <summary>
    /// 加载只读存量 + 后台刷新：
    ///  1) 内存缓存新鲜 → 直接返回；陈旧 → 先返回旧值再后台刷新
    ///  2) 内存缓存空 → 从数据库 hydrate（毫秒级，绝不在加载里同步打 GitHub）
    ///  3) 库也空（真冷启动）或 force → 同步拉取（按 key 去重）
    /// 任意一次成功拉取都会落库；内容有变化时通过 push hub 推送给打开的页面。
    /// </summary>
    private async Task<T> GetStoredAsync<T>(
        string viewType,
        string cacheKey,
        bool force,
        Func<Task<T>> fetch) where T : class, IChangelogView
    {
        if (!force && _cache.TryGetValue(cacheKey, out CacheEntry<T>? entry) && entry != null)
        {
            if (DateTime.UtcNow - entry.FetchedAt <= GetFreshWindow())
            {
                return entry.Value; // 新鲜：直接返回
            }
            TriggerBackgroundRefresh(viewType, cacheKey, fetch); // 陈旧：先返回旧值 + 后台刷新
            return entry.Value;
        }

        // 内存缓存空且非 force：先吃数据库存量，避免空白 + 避免在加载里同步打 GitHub
        if (!force)
        {
            var hydrated = await TryHydrateFromStoreAsync<T>(cacheKey).ConfigureAwait(false);
            if (hydrated != null)
            {
                _cache.Set(cacheKey, new CacheEntry<T> { Value = hydrated, FetchedAt = hydrated.FetchedAt }, StaleKeepWindow);
                // 与「热缓存陈旧」分支对称：冷实例/重启后 hydrate 到的快照若已超新鲜期，
                // 同样后台静默 revalidate（不阻塞本次返回，仍是只读存量；刷新里会落库 + 推送）。
                // 否则重启后首个请求会一直停在旧快照、要等 Worker 周期才更新（Bugbot #722 指出的不对称）。
                if (DateTime.UtcNow - hydrated.FetchedAt > GetFreshWindow())
                {
                    TriggerBackgroundRefresh(viewType, cacheKey, fetch);
                }
                return hydrated;
            }
        }

        // 真冷启动（库也空）或 force：同步拉取，按 key 串行去重避免惊群
        return await FetchCoalescedAsync(viewType, cacheKey, force, fetch).ConfigureAwait(false);
    }

    private async Task<T?> TryHydrateFromStoreAsync<T>(string cacheKey) where T : class
    {
        if (_snapshotStore == null) return null;
        var snap = await _snapshotStore.GetAsync(cacheKey).ConfigureAwait(false);
        if (snap == null || string.IsNullOrEmpty(snap.PayloadJson)) return null;
        try
        {
            return JsonSerializer.Deserialize<T>(snap.PayloadJson, SnapshotJsonOptions);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Changelog] 快照反序列化失败 key={Key}（退回拉取）", cacheKey);
            return null;
        }
    }

    private async Task<T> FetchCoalescedAsync<T>(
        string viewType,
        string cacheKey,
        bool force,
        Func<Task<T>> fetch) where T : class, IChangelogView
    {
        var gate = _fetchLocks.GetOrAdd(cacheKey, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync().ConfigureAwait(false);
        try
        {
            // double-check：等锁期间别的请求可能已填好新鲜缓存
            if (!force && _cache.TryGetValue(cacheKey, out CacheEntry<T>? entry) && entry != null
                && DateTime.UtcNow - entry.FetchedAt <= GetFreshWindow())
            {
                return entry.Value;
            }

            var fresh = await fetch().ConfigureAwait(false);
            if (fresh.DataSourceAvailable)
            {
                _cache.Set(cacheKey, new CacheEntry<T> { Value = fresh, FetchedAt = DateTime.UtcNow }, StaleKeepWindow);
                await PersistAndMaybePublishAsync(viewType, cacheKey, fresh).ConfigureAwait(false);
                return fresh;
            }

            // 拉取失败：内存有旧值 → 用内存；否则回退数据库存量；都没有才返回不可用结果。
            // force 只意味着「绕过缓存去重新拉取」；一旦拉取失败，仍应回退到最佳存量（内存→DB），
            // 不能把空的不可用视图返回给客户端覆盖好 UI。冷实例 + force + 上游失败时尤其重要（Bugbot Medium）。
            if (_cache.TryGetValue(cacheKey, out CacheEntry<T>? stale) && stale != null)
            {
                return stale.Value;
            }
            var hydrated = await TryHydrateFromStoreAsync<T>(cacheKey).ConfigureAwait(false);
            if (hydrated != null) return hydrated;
            return fresh;
        }
        finally
        {
            gate.Release();
        }
    }

    private void TriggerBackgroundRefresh<T>(
        string viewType,
        string cacheKey,
        Func<Task<T>> fetch) where T : class, IChangelogView
    {
        if (!_refreshing.TryAdd(cacheKey, 1)) return; // 已有同 key 后台刷新在跑
        _ = Task.Run(async () =>
        {
            try
            {
                var fresh = await fetch().ConfigureAwait(false);
                if (fresh.DataSourceAvailable)
                {
                    _cache.Set(cacheKey, new CacheEntry<T> { Value = fresh, FetchedAt = DateTime.UtcNow }, StaleKeepWindow);
                    await PersistAndMaybePublishAsync(viewType, cacheKey, fresh).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Changelog] 后台刷新失败 key={Key}（继续沿用旧值）", cacheKey);
            }
            finally
            {
                _refreshing.TryRemove(cacheKey, out _);
            }
        });
    }

    /// <summary>
    /// 落库（终身存储）+ 内容变化时推送。fetchedAt 不参与指纹比对，避免每次刷新都误报变化。
    /// </summary>
    private async Task PersistAndMaybePublishAsync<T>(string viewType, string cacheKey, T view)
        where T : class, IChangelogView
    {
        if (_snapshotStore == null || !view.DataSourceAvailable) return;
        try
        {
            var payloadJson = JsonSerializer.Serialize(view, SnapshotJsonOptions);
            var contentHash = ComputeContentHash(payloadJson);
            var changed = await _snapshotStore
                .UpsertIfChangedAsync(cacheKey, payloadJson, contentHash, view.Source, view.FetchedAt)
                .ConfigureAwait(false);
            if (changed)
            {
                _pushHub?.Publish(new ChangelogPushEvent(viewType, view.FetchedAt, view.Source));
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Changelog] 持久化/推送失败 key={Key}（不影响本次返回）", cacheKey);
        }
    }

    /// <summary>对 payload 求内容指纹：剔除顶层 fetchedAt（时间戳每次都变），只反映真实内容。</summary>
    private static string ComputeContentHash(string payloadJson)
    {
        try
        {
            var node = JsonNode.Parse(payloadJson);
            if (node is JsonObject obj)
            {
                obj.Remove("fetchedAt");
            }
            return IChangelogSnapshotStore.ComputeHash(node?.ToJsonString() ?? payloadJson);
        }
        catch
        {
            return IChangelogSnapshotStore.ComputeHash(payloadJson);
        }
    }

    // ── 真实拉取（本地优先 → GitHub 兜底），供 SWR 包装调用 ─────────────

    private async Task<CurrentWeekView> FetchCurrentWeekAsync()
    {
        // 本地优先：只要有 changelogs/ 目录就用本地（即使本周空），不向 GitHub 兜底
        var localView = BuildCurrentWeekViewFromLocal();
        if (localView.DataSourceAvailable) return localView;

        // GitHub 兜底（生产 Docker 等无本地源场景）
        try
        {
            var githubView = await BuildCurrentWeekViewFromGitHubAsync().ConfigureAwait(false);
            if (githubView.DataSourceAvailable) return githubView;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Changelog] GitHub 拉取本周更新失败");
        }

        return new CurrentWeekView
        {
            WeekStart = ComputeWeekStart(),
            WeekEnd = ComputeWeekStart().AddDays(6),
            DataSourceAvailable = false,
            Source = "none",
            FetchedAt = DateTime.UtcNow,
        };
    }

    private async Task<ReleasesView> FetchReleasesAsync(int limit)
    {
        var localView = BuildReleasesViewFromLocal(limit);
        if (localView.DataSourceAvailable) return localView;

        try
        {
            var githubView = await BuildReleasesViewFromGitHubAsync(limit).ConfigureAwait(false);
            if (githubView.DataSourceAvailable) return githubView;
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

    private async Task<GitHubLogsView> FetchGitHubLogsAsync(int limit)
    {
        var localView = await BuildGitHubLogsViewFromLocalAsync(limit).ConfigureAwait(false);
        if (localView.DataSourceAvailable)
        {
            // 浅克隆等场景本地数不出全量提交数 → 用 GitHub API 反推兜底（1 次调用，失败不影响列表）
            if (localView.RepoTotalCommitCount == null)
            {
                try
                {
                    localView.RepoTotalCommitCount =
                        await TryCountTotalCommitsFromGitHubAsync(CreateGitHubClient()).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[Changelog] GitHub 总提交数兜底统计失败（保持 null）");
                }
            }
            return localView;
        }

        try
        {
            var githubView = await BuildGitHubLogsViewFromGitHubAsync(limit).ConfigureAwait(false);
            if (githubView.DataSourceAvailable) return githubView;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Changelog] GitHub 日志拉取失败");
        }

        return new GitHubLogsView
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
        var dateRange = ComputeUnreleasedDateRange(null);
        var view = new CurrentWeekView
        {
            WeekStart = dateRange.start,
            WeekEnd = dateRange.end,
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

                string content;
                try { content = File.ReadAllText(file); }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[Changelog] 读取碎片文件失败 {File}", fileName);
                    continue;
                }

                var entries = ParseTableRows(content);
                if (entries.Count == 0) continue;

                AddCurrentWeekEntries(view, fileName, date.Value, entries);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Changelog] 扫描 changelogs/ 目录失败");
        }

        view.Fragments = SortFragments(view.Fragments);
        ApplyUnreleasedDateRange(view);
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

    private async Task<GitHubLogsView> BuildGitHubLogsViewFromLocalAsync(int limit)
    {
        var view = new GitHubLogsView
        {
            Source = "local",
            FetchedAt = DateTime.UtcNow,
        };

        var root = ResolveLocalRoot();
        var gitPath = root == null ? null : Path.Combine(root, ".git");
        if (root == null || gitPath == null || (!Directory.Exists(gitPath) && !File.Exists(gitPath)))
        {
            view.DataSourceAvailable = false;
            return view;
        }

        var logs = await TryReadGitLogsAsync(root, GetGitHubBranch(), limit).ConfigureAwait(false)
            ?? await TryReadGitLogsAsync(root, null, limit).ConfigureAwait(false)
            ?? new List<GitHubLogEntry>();

        if (logs.Count == 0)
        {
            view.DataSourceAvailable = false;
            return view;
        }

        view.DataSourceAvailable = true;
        view.Logs = logs;
        view.RepoTotalCommitCount =
            await TryCountLocalTotalCommitsAsync(root, GetGitHubBranch()).ConfigureAwait(false)
            ?? await TryCountLocalTotalCommitsAsync(root, null).ConfigureAwait(false);
        return view;
    }

    /// <summary>
    /// 本地仓库全历史提交总数（git rev-list --count）。浅克隆只能数到截断处、
    /// 结果严重偏小，此时返回 null 交给 GitHub API 兜底。
    /// </summary>
    private async Task<int?> TryCountLocalTotalCommitsAsync(string root, string? branch)
    {
        try
        {
            var shallow = await RunGitAsync(root, new[] { "rev-parse", "--is-shallow-repository" }).ConfigureAwait(false);
            if (shallow == null || shallow.Trim().Equals("true", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            var output = await RunGitAsync(root, new[] { "rev-list", "--count", branch ?? "HEAD" }).ConfigureAwait(false);
            return int.TryParse(output?.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) && n > 0
                ? n
                : null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Changelog] 本地总提交数统计异常 branch={Branch}", branch ?? "HEAD");
            return null;
        }
    }

    /// <summary>跑一条 git 命令并返回 stdout（exit code 非 0 返回 null）</summary>
    private static async Task<string?> RunGitAsync(string root, IReadOnlyList<string> args)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "git",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add("-C");
        startInfo.ArgumentList.Add(root);
        foreach (var arg in args)
        {
            startInfo.ArgumentList.Add(arg);
        }

        using var process = new Process { StartInfo = startInfo };
        if (!process.Start())
        {
            return null;
        }

        // 并行读 stdout/stderr，避免单管道先读满导致子进程阻塞死锁
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await Task.WhenAll(stdoutTask, stderrTask).ConfigureAwait(false);
        await process.WaitForExitAsync().ConfigureAwait(false);
        return process.ExitCode == 0 ? stdoutTask.Result : null;
    }

    // ── GitHub 源 ─────────────────────────────────────────────────────

    private string GetGitHubOwner() => _config["Changelog:GitHubOwner"] ?? "inernoro";
    private string GetGitHubRepo() => _config["Changelog:GitHubRepo"] ?? "prd_agent";
    private string GetGitHubBranch() => _config["Changelog:GitHubBranch"] ?? "main";
    private string GetGitHubApiBase() => (_config["Changelog:GitHubApiBase"] ?? "https://api.github.com").TrimEnd('/');
    private string GetGitHubRawBase() => (_config["Changelog:GitHubRawBase"] ?? "https://raw.githubusercontent.com").TrimEnd('/');
    private string? GetGitHubToken() => _config["Changelog:GitHubToken"];

    /// <summary>
    /// 缓存「新鲜期」：此窗口内直接返回缓存、不触发刷新。可由 Changelog:CacheTtlMinutes /
    /// CacheTtlHours 配置覆盖，默认 5 分钟。超过新鲜期后走 stale-while-revalidate（先旧值后台刷新）。
    /// </summary>
    private TimeSpan GetFreshWindow()
    {
        var minutes = _config.GetValue<int?>("Changelog:CacheTtlMinutes");
        if (minutes.HasValue && minutes.Value > 0)
        {
            return TimeSpan.FromMinutes(minutes.Value);
        }

        var hours = _config.GetValue<int?>("Changelog:CacheTtlHours");
        if (hours.HasValue && hours.Value > 0)
        {
            return TimeSpan.FromHours(hours.Value);
        }

        // 默认新鲜期 = 后台刷新周期：Worker 每 N 小时刷新一次，新鲜期内的读取只走存量、
        // 不再触发访问驱动的拉取（贴合「加载只读存量，刷新交给服务器」的设计）。
        return TimeSpan.FromHours(GetRefreshIntervalHours());
    }

    private string BuildCommitHtmlUrl(string sha)
    {
        var owner = GetGitHubOwner();
        var repo = GetGitHubRepo();
        return $"https://github.com/{owner}/{repo}/commit/{sha}";
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

    private async Task<List<GitHubLogEntry>?> TryReadGitLogsAsync(string root, string? branch, int limit)
    {
        try
        {
            var since = DateTime.UtcNow.AddDays(-7);
            var startInfo = new ProcessStartInfo
            {
                FileName = "git",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add("-C");
            startInfo.ArgumentList.Add(root);
            startInfo.ArgumentList.Add("log");
            if (!string.IsNullOrWhiteSpace(branch))
            {
                startInfo.ArgumentList.Add(branch!);
            }
            startInfo.ArgumentList.Add($"-n{Math.Clamp(limit, 30, 1000)}");
            startInfo.ArgumentList.Add($"--since={since:O}");
            startInfo.ArgumentList.Add("--date=iso-strict");
            // %cI：提交者时间，与 GitHub commits API 的 committer.date 对齐（%aI 为作者时间，rebase 后易不一致）
            // 末位 trailers：Co-authored-by 联合作者（valueonly，多个值以 0x02 分隔）
            startInfo.ArgumentList.Add("--pretty=format:%H%x1f%cI%x1f%an%x1f%s%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x02)%x1e");

            using var process = new Process { StartInfo = startInfo };
            if (!process.Start())
            {
                return null;
            }

            // 并行读 stdout/stderr，避免单管道先读满导致子进程阻塞死锁（见 Process 重定向说明）
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var stderrTask = process.StandardError.ReadToEndAsync();
            await Task.WhenAll(stdoutTask, stderrTask).ConfigureAwait(false);
            var stdout = stdoutTask.Result;
            var stderr = stderrTask.Result;
            await process.WaitForExitAsync().ConfigureAwait(false);
            if (process.ExitCode != 0)
            {
                _logger.LogWarning("[Changelog] 本地 git log 失败 branch={Branch} stderr={Stderr}", branch ?? "HEAD", stderr);
                return null;
            }

            var result = new List<GitHubLogEntry>();
            foreach (var rawRecord in stdout.Split('\u001e', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var parts = rawRecord.Split('\u001f');
                if (parts.Length < 4) continue;
                var sha = parts[0].Trim();
                var committedAtIso = parts[1].Trim();
                var authorName = parts[2].Trim();
                var message = parts[3].Trim();
                if (string.IsNullOrWhiteSpace(sha) || string.IsNullOrWhiteSpace(committedAtIso)) continue;
                if (!DateTime.TryParse(
                        committedAtIso,
                        CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                        out var committedAtUtc))
                {
                    continue;
                }
                if (committedAtUtc < since) continue;
                var resolvedAuthorName = string.IsNullOrWhiteSpace(authorName) ? "unknown" : authorName;
                var coAuthorNames = new List<string>();
                if (parts.Length > 4)
                {
                    foreach (var trailerValue in parts[4].Split('\u0002', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    {
                        var coName = GitHubAuthorMatcher.ExtractNameFromTrailerValue(trailerValue);
                        if (coName == null) continue;
                        if (GitHubAuthorMatcher.IsRawMatch(coName, resolvedAuthorName)) continue; // 与主作者同人不重复列
                        if (coAuthorNames.Exists(n => string.Equals(n, coName, StringComparison.OrdinalIgnoreCase))) continue;
                        coAuthorNames.Add(coName);
                    }
                }
                result.Add(new GitHubLogEntry
                {
                    Sha = sha,
                    ShortSha = sha.Length > 7 ? sha[..7] : sha,
                    Message = message,
                    AuthorName = resolvedAuthorName,
                    AuthorAvatarUrl = null,
                    CoAuthorNames = coAuthorNames,
                    CommitTimeUtc = committedAtUtc,
                    HtmlUrl = BuildCommitHtmlUrl(sha),
                });
            }
            return result.OrderByDescending(l => l.CommitTimeUtc).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Changelog] 读取本地 git log 异常 branch={Branch}", branch ?? "HEAD");
            return null;
        }
    }

    /// <summary>
    /// GitHub Contents API：列出 changelogs/ 目录，返回所有文件名。
    /// 1 次 API 请求即可获得整个目录列表。
    /// </summary>
    /// <summary>
    /// 列出 changelogs/ 目录下的 .md 文件名。
    /// 返回 null 表示「拉取失败」（API 错误/限速/异常）—— 调用方据此保留旧存量、不误判为空；
    /// 返回空列表表示「目录确实没有碎片」（碎片已被 assemble-changelog 合并进 CHANGELOG）。
    /// </summary>
    private async Task<List<string>?> ListChangelogFragmentsFromGitHubAsync(HttpClient client)
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
            var rateRemaining = resp.Headers.TryGetValues("X-RateLimit-Remaining", out var rl)
                ? rl.FirstOrDefault() : null;
            if (!resp.IsSuccessStatusCode)
            {
                // 403 + remaining=0 即匿名限速打爆（未配 Changelog:GitHubToken）。明确暴露，便于检测。
                _logger.LogWarning(
                    "[Changelog] GitHub Contents API 失败 {Url} status={Status} rateRemaining={RateRemaining}",
                    url, (int)resp.StatusCode, rateRemaining ?? "n/a");
                return null; // 拉取失败：调用方保留旧存量，不当作「空」
            }
            if (rateRemaining != null)
            {
                _logger.LogInformation("[Changelog] GitHub Contents API 配额剩余 rateRemaining={RateRemaining}", rateRemaining);
            }

            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
            {
                return null; // 非预期响应：当作失败，保留旧存量
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
            return null; // 异常：当作失败，保留旧存量
        }
    }

    private async Task<CurrentWeekView> BuildCurrentWeekViewFromGitHubAsync()
    {
        var dateRange = ComputeUnreleasedDateRange(null);
        var view = new CurrentWeekView
        {
            WeekStart = dateRange.start,
            WeekEnd = dateRange.end,
            Source = "github",
            FetchedAt = DateTime.UtcNow,
        };

        var client = CreateGitHubClient();

        var allNames = await ListChangelogFragmentsFromGitHubAsync(client).ConfigureAwait(false);
        if (allNames == null)
        {
            // 拉取失败（API 错误/限速）：标记不可用，保留旧存量、不误清空
            view.DataSourceAvailable = false;
            return view;
        }

        // 成功（即使目录为空）：数据源可用。空目录 = 碎片都已合并进 CHANGELOG，
        // 待发布列表应清空——返回「可用的空视图」，让其落库 + 推送「已清空」给客户端，
        // 否则生产实例会一直 hydrate 旧的非空快照，页面永远显示已发布内容（Codex P2）。
        view.DataSourceAvailable = true;

        var filtered = new List<(string name, DateOnly date)>();
        foreach (var name in allNames)
        {
            var date = ParseFragmentDate(name);
            if (date == null) continue;
            filtered.Add((name, date.Value));
        }

        // 「待发布」展示所有未合并进 CHANGELOG.md 的碎片，数量可能达数百个（已发布 0 / 待发布 768
        // 即没人跑 assemble-changelog 合并）。每个碎片走一次 raw 拉取，必须限并发（见 MaxGitHubFetchConcurrency），
        // 否则上百个并发连接会打爆连接池 / 触发限速，冷缓存首屏长时间转圈。
        var sw = Stopwatch.StartNew();
        var gate = new SemaphoreSlim(MaxGitHubFetchConcurrency, MaxGitHubFetchConcurrency);
        var failures = 0;
        var tasks = filtered.Select(async f =>
        {
            await gate.WaitAsync().ConfigureAwait(false);
            try
            {
                var content = await FetchRawFileAsync(client, $"changelogs/{f.name}").ConfigureAwait(false);
                if (string.IsNullOrEmpty(content))
                {
                    Interlocked.Increment(ref failures);
                    return null;
                }
                var entries = ParseTableRows(content);
                if (entries.Count == 0) return null;
                return new ChangelogFragment
                {
                    FileName = f.name,
                    Date = f.date,
                    Entries = entries,
                };
            }
            finally
            {
                gate.Release();
            }
        }).ToList();

        var results = await Task.WhenAll(tasks).ConfigureAwait(false);
        foreach (var fragment in results)
        {
            if (fragment != null) AddCurrentWeekEntries(view, fragment.FileName, fragment.Date, fragment.Entries);
        }
        sw.Stop();
        // 成功路径计时日志：以前只在失败时记日志，「慢但成功」零痕迹无法检测。此行让卡顿可见。
        _logger.LogInformation(
            "[Changelog] GitHub 待发布拉取完成 files={Files} failures={Failures} concurrency={Concurrency} elapsed={Elapsed}ms",
            filtered.Count, failures, MaxGitHubFetchConcurrency, sw.ElapsedMilliseconds);

        // 任一碎片 raw 拉取失败（全失败致空，或部分失败致列表不完整）都不落库：
        // 否则会用「不完整/假空的待发布列表」覆盖上一份完整快照并推给客户端，丢掉失败的碎片、
        // 在不完整↔完整之间抖动（Bugbot/Codex Medium）。保留旧存量（完整、仅稍旧），等下个
        // Worker 周期重试，直到一次完全成功才更新。failures==0 才是可信结果（含真清空），照常落库。
        // 注意：本地源路径读文件无 per-file 网络失败，不受此影响；这里只针对无本地源的 GitHub fallback。
        if (failures > 0)
        {
            _logger.LogWarning(
                "[Changelog] GitHub 待发布存在碎片拉取失败 files={Files} failures={Failures} parsed={Parsed}，保留旧存量、本周期不落库",
                filtered.Count, failures, view.Fragments.Count);
            view.DataSourceAvailable = false;
            return view;
        }

        view.Fragments = SortFragments(view.Fragments);
        ApplyUnreleasedDateRange(view);
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

        // 额外抓一次 CHANGELOG.md 的 commit 历史，为每个日期段落附上秒级提交时间。
        // CHANGELOG 的 ### YYYY-MM-DD 日期绝大多数不会和 commit 日期严格相等
        //（比如碎片合并是几天后才发生），所以用"首个 commit.cnDate >= 日期段"
        // 的近似匹配，认为那次 commit 就是把这些条目写进 CHANGELOG 的时刻。
        try
        {
            var commits = await FetchChangelogCommitTimesAsync(client).ConfigureAwait(false);
            if (commits.Count > 0)
            {
                // 升序：commitTime 越早的越前
                commits.Sort((a, b) => a.CommitTimeUtc.CompareTo(b.CommitTimeUtc));
                foreach (var release in view.Releases)
                foreach (var day in release.Days)
                {
                    foreach (var c in commits)
                    {
                        if (c.CnDate >= day.Date)
                        {
                            day.CommitTimeUtc = c.CommitTimeUtc;
                            break;
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Changelog] 拉取 CHANGELOG.md commit 历史失败（降级为纯日期展示）");
        }

        return view;
    }

    private async Task<GitHubLogsView> BuildGitHubLogsViewFromGitHubAsync(int limit)
    {
        var view = new GitHubLogsView
        {
            Source = "github",
            FetchedAt = DateTime.UtcNow,
        };

        var client = CreateGitHubClient();
        var owner = GetGitHubOwner();
        var repo = GetGitHubRepo();
        var branch = GetGitHubBranch();
        var apiBase = GetGitHubApiBase();
        var since = DateTime.UtcNow.AddDays(-7);
        var max = Math.Clamp(limit, 30, 1000);
        var page = 1;
        var reachedOlderThanWindow = false;

        while (!reachedOlderThanWindow && view.Logs.Count < max && page <= 10)
        {
            var sinceIso = Uri.EscapeDataString(since.ToString("o", CultureInfo.InvariantCulture));
            var url = $"{apiBase}/repos/{owner}/{repo}/commits?sha={branch}&since={sinceIso}&per_page=100&page={page}";

            using var req = CreateGitHubApiRequest(HttpMethod.Get, url);
            using var resp = await client.SendAsync(req).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("[Changelog] GitHub Commits API 失败 {Url} status={Status}", url, (int)resp.StatusCode);
                view.DataSourceAvailable = false;
                return view;
            }

            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
            {
                view.DataSourceAvailable = false;
                return view;
            }

            var pageItems = doc.RootElement.EnumerateArray().ToList();
            if (pageItems.Count == 0)
            {
                break;
            }

            foreach (var item in pageItems)
            {
                var entry = ParseGitHubCommitItem(item);
                if (entry == null) continue;
                if (entry.CommitTimeUtc < since)
                {
                    reachedOlderThanWindow = true;
                    continue;
                }

                view.Logs.Add(entry);
                if (view.Logs.Count >= max) break;
            }

            page++;
        }

        view.Logs = view.Logs
            .GroupBy(l => l.Sha, StringComparer.OrdinalIgnoreCase)
            .Select(g => g.First())
            .OrderByDescending(l => l.CommitTimeUtc)
            .ToList();
        view.DataSourceAvailable = true;
        view.RepoTotalCommitCount = await TryCountTotalCommitsFromGitHubAsync(client).ConfigureAwait(false);
        return view;
    }

    // Link header 形如 <https://api.github.com/...&page=24735>; rel="last"
    private static readonly Regex GitHubLinkLastPageRegex =
        new("[?&]page=(\\d+)[^>]*>;\\s*rel=\"last\"", RegexOptions.Compiled);

    /// <summary>
    /// 仓库全历史提交总数：请求 commits?per_page=1，用 Link header rel="last" 的页码反推
    /// （每页 1 条 → 末页页码 = 总提交数）。仅 1 次 API 调用，不翻页。失败返回 null。
    /// </summary>
    private async Task<int?> TryCountTotalCommitsFromGitHubAsync(HttpClient client)
    {
        var owner = GetGitHubOwner();
        var repo = GetGitHubRepo();
        var branch = GetGitHubBranch();
        var apiBase = GetGitHubApiBase();
        var url = $"{apiBase}/repos/{owner}/{repo}/commits?sha={branch}&per_page=1";
        try
        {
            using var req = CreateGitHubApiRequest(HttpMethod.Get, url);
            using var resp = await client.SendAsync(req).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("[Changelog] GitHub 总提交数统计失败 {Url} status={Status}", url, (int)resp.StatusCode);
                return null;
            }

            if (resp.Headers.TryGetValues("Link", out var linkValues))
            {
                var match = GitHubLinkLastPageRegex.Match(string.Join(",", linkValues));
                if (match.Success &&
                    int.TryParse(match.Groups[1].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var pages) &&
                    pages > 0)
                {
                    return pages;
                }
            }

            // 无 Link header = 只有一页（总提交数 0 或 1），直接数返回数组长度
            var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement.GetArrayLength() : null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[Changelog] GitHub 总提交数统计异常 {Url}", url);
            return null;
        }
    }

    private GitHubLogEntry? ParseGitHubCommitItem(JsonElement item)
    {
        var sha = item.TryGetProperty("sha", out var shaProp) ? shaProp.GetString() : null;
        var htmlUrl = item.TryGetProperty("html_url", out var htmlUrlProp) ? htmlUrlProp.GetString() : null;
        if (!item.TryGetProperty("commit", out var commitEl)) return null;
        var message = commitEl.TryGetProperty("message", out var messageProp) ? messageProp.GetString() : null;
        string? authorName = null;
        string? avatarUrl = null;
        JsonElement authorEl = default;
        var hasCommitAuthor = commitEl.TryGetProperty("author", out authorEl);
        if (hasCommitAuthor)
        {
            authorName = authorEl.TryGetProperty("name", out var nameProp) ? nameProp.GetString() : null;
        }

        if (item.TryGetProperty("author", out var githubAuthorEl) && githubAuthorEl.ValueKind == JsonValueKind.Object)
        {
            avatarUrl = githubAuthorEl.TryGetProperty("avatar_url", out var avatarProp) ? avatarProp.GetString() : null;
            authorName = githubAuthorEl.TryGetProperty("login", out var loginProp) && !string.IsNullOrWhiteSpace(loginProp.GetString())
                ? loginProp.GetString()
                : authorName;
        }

        authorName ??= commitEl.TryGetProperty("committer", out var committerEl) &&
                       committerEl.TryGetProperty("name", out var committerNameProp)
            ? committerNameProp.GetString()
            : null;
        string? committedAtIso = null;
        if (commitEl.TryGetProperty("committer", out var commitCommitterEl) &&
            commitCommitterEl.TryGetProperty("date", out var dateProp))
        {
            committedAtIso = dateProp.GetString();
        }
        committedAtIso ??= hasCommitAuthor && authorEl.TryGetProperty("date", out var authorDateProp)
            ? authorDateProp.GetString()
            : null;

        if (string.IsNullOrWhiteSpace(sha) || string.IsNullOrWhiteSpace(committedAtIso))
        {
            return null;
        }
        if (!DateTime.TryParse(
                committedAtIso,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var committedAtUtc))
        {
            return null;
        }

        var firstLine = (message ?? string.Empty)
            .Split('\n', 2, StringSplitOptions.TrimEntries)[0]
            .Trim();
        var resolvedAuthorName = string.IsNullOrWhiteSpace(authorName) ? "unknown" : authorName!;
        // 联合作者从完整 message 的 Co-authored-by trailer 解析（截断成首行之前）
        var coAuthorNames = GitHubAuthorMatcher.ParseCoAuthorNames(message)
            .Where(n => !GitHubAuthorMatcher.IsRawMatch(n, resolvedAuthorName))
            .ToList();
        return new GitHubLogEntry
        {
            Sha = sha,
            ShortSha = sha.Length > 7 ? sha[..7] : sha,
            Message = string.IsNullOrWhiteSpace(firstLine) ? "(no message)" : firstLine,
            AuthorName = resolvedAuthorName,
            AuthorAvatarUrl = string.IsNullOrWhiteSpace(avatarUrl) ? null : avatarUrl,
            CoAuthorNames = coAuthorNames,
            CommitTimeUtc = committedAtUtc,
            HtmlUrl = string.IsNullOrWhiteSpace(htmlUrl) ? BuildCommitHtmlUrl(sha) : htmlUrl!,
        };
    }

    /// <summary>commit 条目：UTC 时间 + 按 CN(UTC+8) 换算出的日期（用于匹配 CHANGELOG ### 日期段）</summary>
    private sealed record ChangelogCommit(DateOnly CnDate, DateTime CommitTimeUtc);

    /// <summary>
    /// 拉取 CHANGELOG.md 文件的 commit 历史。返回列表（caller 负责排序），
    /// 每条含 UTC 原始提交时间 + 按 CN(UTC+8) 时区换算的日期。
    /// 单次 API 调用（per_page=100），覆盖最近 ~100 个 PR 足够绝大多数场景。
    /// </summary>
    private async Task<List<ChangelogCommit>> FetchChangelogCommitTimesAsync(HttpClient client)
    {
        var result = new List<ChangelogCommit>();
        var owner = GetGitHubOwner();
        var repo = GetGitHubRepo();
        var branch = GetGitHubBranch();
        var apiBase = GetGitHubApiBase();
        var url = $"{apiBase}/repos/{owner}/{repo}/commits?path=CHANGELOG.md&sha={branch}&per_page=100";

        using var req = CreateGitHubApiRequest(HttpMethod.Get, url);
        using var resp = await client.SendAsync(req).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            _logger.LogWarning("[Changelog] GitHub Commits API 失败 {Url} status={Status}", url, (int)resp.StatusCode);
            return result;
        }

        var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Array) return result;

        var cnOffset = TimeSpan.FromHours(8);
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            if (!item.TryGetProperty("commit", out var commitEl)) continue;
            if (!commitEl.TryGetProperty("committer", out var committerEl)) continue;
            if (!committerEl.TryGetProperty("date", out var dateEl)) continue;
            var iso = dateEl.GetString();
            if (string.IsNullOrWhiteSpace(iso)) continue;
            if (!DateTime.TryParse(
                    iso, CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                    out var commitTimeUtc))
                continue;
            var cnDate = DateOnly.FromDateTime(commitTimeUtc + cnOffset);
            result.Add(new ChangelogCommit(cnDate, commitTimeUtc));
        }
        return result;
    }

    // ── 解析逻辑（local 与 github 共用） ──────────────────────────────

    private static DateOnly ComputeWeekStart()
    {
        var now = GetChinaNow();
        // 周一为周首（中国习惯）：Sunday=0, Monday=1, ..., Saturday=6
        var dayOfWeek = (int)now.DayOfWeek;
        var daysSinceMonday = (dayOfWeek + 6) % 7;
        return DateOnly.FromDateTime(now.AddDays(-daysSinceMonday));
    }

    private static DateTime GetChinaNow()
    {
        var utcNow = DateTimeOffset.UtcNow;
        try
        {
            var tz = TimeZoneInfo.FindSystemTimeZoneById("Asia/Shanghai");
            return TimeZoneInfo.ConvertTime(utcNow, tz).DateTime;
        }
        catch
        {
            return (utcNow + TimeSpan.FromHours(8)).DateTime;
        }
    }

    private static (DateOnly start, DateOnly end) ComputeUnreleasedDateRange(IEnumerable<ChangelogFragment>? fragments)
    {
        var dates = fragments?.Select(f => f.Date).ToList();
        if (dates is { Count: > 0 })
        {
            return (dates.Min(), dates.Max());
        }

        var today = DateOnly.FromDateTime(GetChinaNow());
        return (today, today);
    }

    private static void ApplyUnreleasedDateRange(CurrentWeekView view)
    {
        var range = ComputeUnreleasedDateRange(view.Fragments);
        view.WeekStart = range.start;
        view.WeekEnd = range.end;
    }

    private static void AddCurrentWeekEntries(
        CurrentWeekView view,
        string fileName,
        DateOnly date,
        IEnumerable<ChangelogEntry> entries)
    {
        var seen = new HashSet<string>(
            view.Fragments
                .Where(f => f.Date == date)
                .SelectMany(f => f.Entries)
                .Select(BuildEntryKey),
            StringComparer.Ordinal);

        var additions = new List<ChangelogEntry>();
        foreach (var entry in entries)
        {
            var key = BuildEntryKey(entry);
            if (seen.Add(key))
            {
                additions.Add(new ChangelogEntry
                {
                    Type = entry.Type,
                    Module = entry.Module,
                    Description = entry.Description,
                });
            }
        }

        if (additions.Count == 0) return;

        var target = view.Fragments.FirstOrDefault(f => f.FileName == fileName && f.Date == date);
        if (target == null)
        {
            target = new ChangelogFragment
            {
                FileName = fileName,
                Date = date,
                Entries = new List<ChangelogEntry>(),
            };
            view.Fragments.Add(target);
        }

        target.Entries.AddRange(additions);
    }

    private static string BuildEntryKey(ChangelogEntry entry) =>
        $"{entry.Type.Trim().ToLowerInvariant()}\u001f{entry.Module.Trim().ToLowerInvariant()}\u001f{entry.Description.Trim()}";

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
        // 跟踪 markdown 代码栅栏（``` 或 ~~~），代码块内的 ## [xxx] 是文档示例，
        // 不应当成真版本头解析。
        var inFencedCodeBlock = false;

        foreach (var rawLine in lines)
        {
            var line = rawLine.TrimEnd('\r');

            // 代码栅栏切换：以 ``` 或 ~~~ 开头（允许带语言标识，如 ```markdown）
            var trimmedStart = line.TrimStart();
            if (trimmedStart.StartsWith("```", StringComparison.Ordinal) ||
                trimmedStart.StartsWith("~~~", StringComparison.Ordinal))
            {
                inFencedCodeBlock = !inFencedCodeBlock;
                continue;
            }

            // 在代码块内：所有特殊语法（版本头/日期头/表格行/highlight bullet）都跳过
            if (inFencedCodeBlock) continue;

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
