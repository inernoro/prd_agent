using PrdAgent.Api.Services.ModelLeaderboard;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// arena.ai 榜单解析器的守卫。
///
/// 这个解析器读的是别人家的页面，没有契约保护——对方改一次版式我们就得跟着改。
/// 所以判据必须钉死在「真实页面长什么样」上：下面的 fixture 是 2026-09-14 从
/// arena.ai/leaderboard/agent 抓下来的**真实片段**（只删掉了与解析无关的 SVG 路径数据），
/// 不是照着解析器反推出来的理想输入——那样测的就只是「正则能匹配自己」。
/// </summary>
public class ArenaLeaderboardFetcherTests
{
    /// <summary>
    /// 真实页面片段：表头一行 + 模型两行。
    ///
    /// 保留了三个真实的坑：
    /// 1. 表头行也是 &lt;tr&gt;，但没有 title/aria-label，必须被跳过而不是算成一个模型；
    /// 2. 分数文本里夹着 React 的注释标记 <c>13.85&lt;!-- --&gt;%</c>，所以判据取的是
    ///    aria-label 而不是标签文本；
    /// 3. 厂商那一格是「Anthropic · Proprietary」这种一段式文本，开源模型还会有第三段
    ///    托管方（Z.ai · MIT · SiliconFlow）。
    /// </summary>
    private const string RealFixture = """
<table><tbody>
<tr><th>Rank</th><th>Model</th><th>Net improvement</th></tr>
<tr><td><div><a href="/leaderboard/agent?model=claude-fable-5-1-max"><span class="max-w-full truncate" title="Claude Fable 5.1 (Max)">Claude Fable 5.1 (Max)</span></a></div><span class="text-text-secondary truncate text-xs">Anthropic · Proprietary</span></td><td><div class="flex items-center gap-3"><div class="flex w-20 flex-none flex-col items-end tabular-nums"><span class="inline-flex items-center gap-0.5 tabular-nums text-interactive-positive text-sm"><svg role="img" aria-label="Up" class="size-3 shrink-0"></svg>13.85<!-- -->%</span><span class="text-text-muted text-xs">±1.92%</span></div><div class="min-w-0 flex-1"><svg viewBox="0 0 100 16" role="img" aria-label="Net improvement 13.85%"></svg></div></div></td></tr>
<tr><td><div><a href="/leaderboard/agent?model=glm-5-2-max"><span class="max-w-full truncate" title="GLM 5.2 (Max)">GLM 5.2 (Max)</span></a></div><span class="text-text-secondary truncate text-xs">Z.ai · MIT · SiliconFlow</span></td><td><div class="flex items-center gap-3"><div class="flex w-20 flex-none flex-col items-end tabular-nums"><span class="inline-flex items-center gap-0.5 tabular-nums text-interactive-positive text-sm"><svg role="img" aria-label="Up" class="size-3 shrink-0"></svg>4.56<!-- -->%</span><span class="text-text-muted text-xs">±0.74%</span></div><div class="min-w-0 flex-1"><svg viewBox="0 0 100 16" role="img" aria-label="Net improvement 4.56%"></svg></div></div></td></tr>
</tbody></table>
""";

    [Fact]
    public void Parse_真实页面片段_只认模型行不把表头算进去()
    {
        var entries = ArenaLeaderboardFetcher.Parse(RealFixture);

        // fixture 里有 3 个 tr，其中第一个是表头
        Assert.Equal(2, entries.Count);
    }

    [Fact]
    public void Parse_取到模型名分数与误差范围()
    {
        var entries = ArenaLeaderboardFetcher.Parse(RealFixture);
        var first = entries[0];

        Assert.Equal("Claude Fable 5.1 (Max)", first.Name);
        Assert.Equal(13.85, first.Score);
        Assert.Equal(1.92, first.Margin);
        Assert.Equal("Anthropic", first.Organization);
        Assert.Equal("Proprietary", first.License);
    }

    [Fact]
    public void Parse_名次按页面顺序从1递增()
    {
        var entries = ArenaLeaderboardFetcher.Parse(RealFixture);

        Assert.Equal(1, entries[0].Rank);
        Assert.Equal(2, entries[1].Rank);
    }

    [Fact]
    public void Parse_开源模型的授权取第二段_忽略托管方()
    {
        var entries = ArenaLeaderboardFetcher.Parse(RealFixture);
        var glm = entries[1];

        // 「Z.ai · MIT · SiliconFlow」：第一段厂商、第二段授权，第三段托管方不要
        Assert.Equal("Z.ai", glm.Organization);
        Assert.Equal("MIT", glm.License);
    }

    [Fact]
    public void Parse_页面结构变了就返回空_而不是编出条目()
    {
        // 对方改版后最可能的样子：还是表格，但类名与无障碍属性全变了
        const string changed = """
<table><tbody>
<tr><td><span data-model="Claude Fable 5.1">Claude Fable 5.1</span></td><td><span data-score="13.85">13.85%</span></td></tr>
</tbody></table>
""";

        var entries = ArenaLeaderboardFetcher.Parse(changed);

        // 关键：解析不出来必须是「空」，让上层判定为失败并保留旧快照，
        // 绝不能凑出一个半截条目当成今天的榜单写进库。
        Assert.Empty(entries);
    }

    [Fact]
    public void Parse_缺少误差范围时Margin为null_不拿0冒充()
    {
        const string noMargin = """
<table><tbody>
<tr><td><span title="Some Model">Some Model</span><span class="text-text-secondary truncate text-xs">Acme · Proprietary</span></td><td><svg role="img" aria-label="Net improvement 1.23%"></svg></td></tr>
</tbody></table>
""";

        var entries = ArenaLeaderboardFetcher.Parse(noMargin);

        Assert.Single(entries);
        Assert.Equal(1.23, entries[0].Score);
        Assert.Null(entries[0].Margin);
    }

    [Fact]
    public void Parse_负分也能解析_榜尾模型的净改进是负数()
    {
        const string negative = """
<table><tbody>
<tr><td><span title="Weak Model">Weak Model</span><span class="text-text-secondary truncate text-xs">Acme · Proprietary</span></td><td><svg role="img" aria-label="Net improvement -3.40%"></svg></td></tr>
</tbody></table>
""";

        var entries = ArenaLeaderboardFetcher.Parse(negative);

        Assert.Single(entries);
        Assert.Equal(-3.40, entries[0].Score);
    }

    [Fact]
    public void MinimumEntries_下限足够把改版与短榜分开()
    {
        // 改版时解析结果是 0-1 条，正常分榜是几十到几百条。
        // 下限卡在这两者之间，且不能高到把冷门短榜误判成改版。
        Assert.InRange(ArenaLeaderboardFetcher.MinimumEntries, 2, 10);
    }

    [Fact]
    public void BuildUrl_按分榜拼地址()
    {
        Assert.Equal("https://arena.ai/leaderboard/agent", ArenaLeaderboardFetcher.BuildUrl("agent"));
        Assert.Equal("https://arena.ai/leaderboard/code", ArenaLeaderboardFetcher.BuildUrl("code"));
    }
}
