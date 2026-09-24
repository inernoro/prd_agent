using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 启动索引巡检（只查不建）的两条守卫：
/// 1. 巡检表里每个索引名都必须在 DBA 可执行清单里、且挂在同一个集合下——否则巡检会对着一个
///    脚本根本不建的名字永远报「缺失」，或者脚本改了名而巡检还在查旧名（判据分裂后各自漂移）。
/// 2. 巡检的判定：缺的报缺、列不出来的报未知，都不抛，也不会把「列不出来」误报成「已存在」。
/// </summary>
public sealed class MongoIndexAdvisoryCatalogTests
{
    // 清单里建索引的三种写法：db.<集合>.createIndex( / ensureTightenedUniqueIndex("<集合>" / ensureCatalogIndex("<集合>"。
    // 每个 name: "..." 归属于它前面最近的那一处调用。
    private static readonly Regex CallSite = new(
        "db\\.(?<coll>[A-Za-z0-9_]+)\\.createIndex\\(|ensure[A-Za-z]*Index\\(\\s*\"(?<coll>[A-Za-z0-9_]+)\"",
        RegexOptions.Compiled);

    private static readonly Regex NameDeclaration = new(
        "name:\\s*\"(?<name>[A-Za-z0-9_]+)\"",
        RegexOptions.Compiled);

    [Fact]
    public void EveryAdvisedIndexIsDeclaredInTheDbaScriptUnderTheSameCollection()
    {
        var script = File.ReadAllText(LocateRepoFile(RequiredMongoIndexCatalog.ScriptPath));
        var declared = ParseDeclaredIndexes(script);

        // companion：解析确实拿到了东西，否则下面的断言会对着空表判绿。
        Assert.True(declared.Count > 100, $"清单里只解析到 {declared.Count} 个索引名，正则可能已经失效");

        var problems = new List<string>();
        foreach (var index in RequiredMongoIndexCatalog.All)
        {
            if (!declared.TryGetValue(index.Name, out var collections))
            {
                problems.Add($"{index.QualifiedName}：scripts/mongodb-indexes.js 里没有这个索引名");
                continue;
            }

            if (!collections.Contains(index.Collection))
            {
                problems.Add(
                    $"{index.QualifiedName}：脚本里这个名字挂在 {string.Join("、", collections)} 下，与巡检表的集合不一致");
            }
        }

        Assert.True(
            problems.Count == 0,
            "启动索引巡检表与 DBA 清单对不上，巡检会报出永远补不上的缺失或漏查真正的缺失：\n"
            + string.Join("\n", problems));
    }

    [Fact]
    public void AdvisoryCatalogHasNoDuplicatesAndEveryEntrySaysWhatDegrades()
    {
        var all = RequiredMongoIndexCatalog.All;
        Assert.NotEmpty(all);
        Assert.Equal(all.Count, all.Select(index => index.QualifiedName).Distinct(StringComparer.Ordinal).Count());
        Assert.All(all, index => Assert.False(string.IsNullOrWhiteSpace(index.Consequence)));
    }

    [Fact]
    public async Task MissingIndexIsReportedWithConsequenceFirstAndNothingThrows()
    {
        var logger = new ListLogger();
        var advisory = new MongoIndexAdvisory();
        var required = new[]
        {
            new RequiredMongoIndex("c1", "idx_present", "不会出现"),
            new RequiredMongoIndex("c1", "idx_absent", "清理任务会整表扫描 c1"),
        };

        var report = await advisory.CheckAsync(
            required,
            (_, _) => Task.FromResult(Observed("_id_", "idx_present")),
            logger,
            new DateTime(2026, 9, 24, 0, 0, 0, DateTimeKind.Utc));

        Assert.Equal(new[] { "c1.idx_absent" }, report.Missing);
        Assert.Empty(report.Unverified);
        Assert.Same(report, advisory.LastReport);

        var warning = Assert.Single(logger.Entries, entry => entry.Level == LogLevel.Warning);
        // 第一句是后果，不是「索引缺失」这种内因。
        var firstSentence = warning.Message.Split('。')[0];
        Assert.Contains("清理任务会整表扫描 c1", firstSentence);
        Assert.Contains(RequiredMongoIndexCatalog.GuidePath, warning.Message);
    }

    [Fact]
    public async Task ListFailureIsReportedAsUnknownNotAsPresentAndDoesNotThrow()
    {
        var logger = new ListLogger();
        var advisory = new MongoIndexAdvisory();
        var required = new[]
        {
            new RequiredMongoIndex("denied", "idx_a", "后果 A"),
            new RequiredMongoIndex("ok", "idx_b", "后果 B"),
        };

        var report = await advisory.CheckAsync(
            required,
            (collection, _) => collection == "denied"
                ? throw new InvalidOperationException("not authorized on prdagent to execute command listIndexes")
                : Task.FromResult(Observed("idx_b")),
            logger,
            DateTime.UtcNow);

        Assert.Empty(report.Missing);
        Assert.Equal(new[] { "denied.idx_a" }, report.Unverified);
        var warning = Assert.Single(logger.Entries, entry => entry.Level == LogLevel.Warning);
        Assert.Contains("后果 A", warning.Message);
        Assert.Contains("listIndexes", warning.Message);
    }

    [Fact]
    public async Task TimeoutLeavesUncheckedIndexesAsUnverifiedInsteadOfNoReport()
    {
        var logger = new ListLogger();
        var advisory = new MongoIndexAdvisory();
        var required = new[]
        {
            new RequiredMongoIndex("fast", "idx_fast", "后果 fast"),
            new RequiredMongoIndex("slow", "idx_slow", "后果 slow"),
            new RequiredMongoIndex("later", "idx_later", "后果 later"),
        };
        using var cts = new CancellationTokenSource();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => advisory.CheckAsync(
            required,
            async (collection, ct) =>
            {
                if (collection == "fast") return Observed("idx_fast");
                cts.Cancel();
                await Task.Delay(Timeout.Infinite, ct);
                return Array.Empty<ObservedMongoIndex>();
            },
            logger,
            DateTime.UtcNow,
            cts.Token));

        // 超时后就绪端点要能分清「还在跑」（null）和「没查完」（未核实）
        var report = Assert.IsType<MongoIndexAdvisoryReport>(advisory.LastReport);
        Assert.Empty(report.Missing);
        Assert.Equal(new[] { "slow.idx_slow", "later.idx_later" }, report.Unverified);
    }

    [Fact]
    public async Task ConcurrentStaleRefreshesShareOneScan()
    {
        var logger = new ListLogger();
        var advisory = new MongoIndexAdvisory();
        var required = new[] { new RequiredMongoIndex("c1", "idx_a", "后果 A") };
        var calls = 0;
        var release = new TaskCompletionSource();

        async Task<IReadOnlyCollection<ObservedMongoIndex>> Lister(string _, CancellationToken ct)
        {
            Interlocked.Increment(ref calls);
            await release.Task.WaitAsync(ct);
            return Observed("idx_a");
        }

        // 缓存过期时 8 个探测同时到达（CDS 并发上限），只允许发生一次扫描
        var refreshes = Enumerable.Range(0, 8)
            .Select(_ => advisory.RefreshIfStaleAsync(
                required, Lister, logger, TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(5), () => DateTime.UtcNow))
            .ToList();
        release.SetResult();
        var reports = await Task.WhenAll(refreshes);

        Assert.Equal(1, calls);
        Assert.All(reports, report => Assert.Same(reports[0], report));
        Assert.Empty(reports[0].Missing);

        // 快照新鲜时不再扫描
        await advisory.RefreshIfStaleAsync(
            required, Lister, logger, TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(5), () => DateTime.UtcNow);
        Assert.Equal(1, calls);
    }

    [Fact]
    public void DeepHealthPublishesRequiredIndexCheckForStandingMonitor()
    {
        // 接线守卫：缺失索引必须进 /api/healthz/deep 的 cds:monitor，CDS 常设探针才会响铃。
        // 只留在启动日志和 /health/ready 里等于没有铃（degradation-must-alarm）。
        var program = File.ReadAllText(LocateRepoFile("prd-api/src/PrdAgent.Api/Program.cs"));
        var start = program.IndexOf("static async Task<IResult> DeepHealth(", StringComparison.Ordinal);
        Assert.True(start >= 0, "找不到 DeepHealth");
        var body = program[start..];
        Assert.Contains("indexAdvisory.RefreshIfStaleAsync(", body);
        var check = body.IndexOf("[\"componentId\"] = \"mongo.required-indexes\"", StringComparison.Ordinal);
        Assert.True(check >= 0, "深度自检里没有 mongo.required-indexes 这条 check");
        var nextCheck = body.IndexOf("[\"componentId\"]", check + 1, StringComparison.Ordinal);
        var segment = nextCheck > 0 ? body[check..nextCheck] : body[check..];
        Assert.Contains("[\"cds:monitor\"]", segment);
        Assert.Contains("[\"observedValue\"] = requiredIndexIssues", segment);
    }

    [Fact]
    public async Task SameNameIndexWithoutUniqueIsReportedMissingForUniqueEntries()
    {
        var logger = new ListLogger();
        var advisory = new MongoIndexAdvisory();
        var required = new[]
        {
            new RequiredMongoIndex("c1", "uniq_loose", "并发写入会出现重复", Unique: true),
            new RequiredMongoIndex("c1", "uniq_ok", "不会出现", Unique: true),
            new RequiredMongoIndex("c1", "idx_plain", "不会出现"),
        };

        var report = await advisory.CheckAsync(
            required,
            (_, _) => Task.FromResult<IReadOnlyCollection<ObservedMongoIndex>>(new[]
            {
                new ObservedMongoIndex("uniq_loose", Unique: false),
                new ObservedMongoIndex("uniq_ok", Unique: true),
                new ObservedMongoIndex("idx_plain", Unique: false),
            }),
            logger,
            DateTime.UtcNow);

        Assert.Equal(new[] { "c1.uniq_loose" }, report.Missing);
        var warning = Assert.Single(logger.Entries, entry => entry.Level == LogLevel.Warning);
        Assert.Contains("没有启用唯一约束", warning.Message);
        Assert.Contains("并发写入会出现重复", warning.Message);
    }

    [Fact]
    public void UniqueCatalogEntriesAreTheUniqNamedOnes()
    {
        // 名字以 uniq_ 开头的条目价值在唯一约束上，必须声明 Unique，否则同名非唯一索引会被当成「在」
        Assert.All(
            RequiredMongoIndexCatalog.All.Where(index => index.Name.StartsWith("uniq_", StringComparison.Ordinal)),
            index => Assert.True(index.Unique, $"{index.QualifiedName} 没有声明 Unique"));
    }

    private static IReadOnlyCollection<ObservedMongoIndex> Observed(params string[] names)
        => names.Select(name => new ObservedMongoIndex(name, Unique: false)).ToList();

    private static Dictionary<string, HashSet<string>> ParseDeclaredIndexes(string script)
    {
        var sites = CallSite.Matches(script)
            .Select(match => (match.Index, Collection: match.Groups["coll"].Value))
            .ToList();
        var declared = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (Match match in NameDeclaration.Matches(script))
        {
            var owner = sites.LastOrDefault(site => site.Index < match.Index);
            if (owner.Collection is null) continue;
            var name = match.Groups["name"].Value;
            if (!declared.TryGetValue(name, out var collections))
            {
                collections = new HashSet<string>(StringComparer.Ordinal);
                declared[name] = collections;
            }
            collections.Add(owner.Collection);
        }
        return declared;
    }

    private static string LocateRepoFile(string relativePath)
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current != null)
        {
            var candidate = Path.Combine(current.FullName, relativePath.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(candidate)) return candidate;
            current = current.Parent;
        }

        throw new FileNotFoundException($"找不到仓库文件：{relativePath}");
    }

    private sealed class ListLogger : ILogger
    {
        public List<(LogLevel Level, string Message)> Entries { get; } = new();

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Entries.Add((logLevel, formatter(state, exception)));
    }
}
