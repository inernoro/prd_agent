using System.Text.RegularExpressions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 代码里定义的每一条索引，都必须在 DBA 可执行清单里有同名条目（Codex P2，2026-09-15）。
///
/// 本仓库禁止应用启动时自动建索引（no-auto-index），`CreateIndexes()` 从不执行、只当参考。
/// 于是「在那里加一条索引定义」这个动作本身不产生任何效果——真正生效的是
/// `scripts/mongodb-indexes.js`。两处一旦对不上，代码看着有索引、线上没有，症状是某个
/// 周期任务每轮整表扫描，而且不会红、不会报错（形状 8：把不成立的证据当成证据）。
///
/// 此前只有逐个功能各写一条「我这条索引在清单里」的断言，新增索引忘了写就没人管。
/// 这条守卫覆盖全部，落地时差集恰好为零。
/// </summary>
public sealed class MongoIndexCatalogCoverageTests
{
    [Fact]
    public void EveryIndexDefinedInCodeExistsInTheDbaCatalog()
    {
        var context = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs"));
        var catalog = File.ReadAllText(LocateRepoFile("scripts/mongodb-indexes.js"));

        var names = Regex.Matches(context, "Name\\s*=\\s*\"([A-Za-z0-9_]+)\"")
            .Select(match => match.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .ToList();

        // companion：正则确实扫到了索引名，否则下面那条会对着空集合判绿。
        Assert.True(names.Count > 100, $"只扫到 {names.Count} 个索引名，正则可能已经失效");
        Assert.Contains("idx_hosted_sites_owner_created", names);

        // 取清单里真正声明过的名字，而不是做子串包含：后者会让
        // idx_foo 被 idx_foo_extra 顶替着判绿，是同一类「判据比它该管的范围窄」的反面。
        var declared = Regex.Matches(catalog, "name:\\s*\"([A-Za-z0-9_]+)\"")
            .Select(match => match.Groups[1].Value)
            .ToHashSet(StringComparer.Ordinal);
        Assert.True(declared.Count > 100, $"清单里只解析到 {declared.Count} 个索引名，正则可能已经失效");

        var missing = names
            .Where(name => !declared.Contains(name))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        Assert.True(
            missing.Count == 0,
            "这些索引只在 MongoDbContext.CreateIndexes() 里定义过，而那段代码从不执行；"
            + "请把它们补进 scripts/mongodb-indexes.js，否则线上根本没有这些索引："
            + string.Join("、", missing));
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
}
