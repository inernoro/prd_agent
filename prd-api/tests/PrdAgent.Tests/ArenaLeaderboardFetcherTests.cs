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
    /// 真实页面片段：表头一行 + 榜首一行（六个指标齐全）+ 一个开源模型行。
    ///
    /// 保留了这些真实的坑：
    /// 1. 表头行也是 &lt;tr&gt;，但没有 title/aria-label，必须被跳过；
    /// 2. 数字前夹着 React 的注释标记 <c>13.85&lt;!-- --&gt;%</c>；
    /// 3. 方向是一个带 aria-label="Up"/"Down" 的 svg，<b>Down 必须变成负值</b>；
    /// 4. 名次那格有三个裸数字：名次、区间下界、区间上界；
    /// 5. 厂商那格是「Anthropic · Proprietary」，开源模型还会有第三段托管方。
    /// </summary>
    private const string RealFixture = """
<table><tbody>
<tr><th>Rank</th><th>Model</th><th>Net Improvement</th><th>Confirmed Success</th><th>Praise vs Complaint</th><th>Steerability</th><th>Bash Recovery</th><th>Tool Hallucination</th><th>Sessions</th><th>Cost/Task (P50)</th><th>Output Tokens/Task (P50)</th><th>Price $/M</th></tr>
<tr><td><span>1</span><span>1</span><span>4</span></td><td><span class="max-w-full truncate" title="Claude Fable 5.1 (Max)">Claude Fable 5.1 (Max)</span><span class="text-text-secondary truncate text-xs">Anthropic · Proprietary</span></td><td><span><svg role="img" aria-label="Up"></svg>13.85<!-- -->%</span><span class="text-text-muted text-xs">±1.92%</span></td><td><span><svg role="img" aria-label="Up"></svg>22.39<!-- -->%</span><span class="text-text-muted text-xs">±3.04%</span></td><td><span><svg role="img" aria-label="Up"></svg>36.35<!-- -->%</span><span class="text-text-muted text-xs">±7.68%</span></td><td><span><svg role="img" aria-label="Down"></svg>0.91<!-- -->%</span><span class="text-text-muted text-xs">±3.86%</span></td><td><span><svg role="img" aria-label="Up"></svg>11.07<!-- -->%</span><span class="text-text-muted text-xs">±1.00%</span></td><td><span><svg role="img" aria-label="Down"></svg>0.37<!-- -->%</span><span class="text-text-muted text-xs">±0.04%</span></td><td><span>12,416</span></td><td><span>$4.52</span></td><td><span>55.2K</span></td><td><span>$10</span><span>/</span><span>$50</span></td></tr>
<tr><td><span>8</span><span>6</span><span>13</span></td><td><span class="max-w-full truncate" title="Kimi K3 (Max)">Kimi K3 (Max)</span><span class="text-text-secondary truncate text-xs">Moonshot · Kimi K3 license · SiliconFlow</span></td><td><span><svg role="img" aria-label="Up"></svg>6.46<!-- -->%</span><span class="text-text-muted text-xs">±0.70%</span></td><td><span><svg role="img" aria-label="Up"></svg>15.11<!-- -->%</span><span class="text-text-muted text-xs">±1.43%</span></td><td><span><svg role="img" aria-label="Up"></svg>12.49<!-- -->%</span><span class="text-text-muted text-xs">±2.43%</span></td><td><span><svg role="img" aria-label="Up"></svg>0.02<!-- -->%</span><span class="text-text-muted text-xs">±1.39%</span></td><td><span><svg role="img" aria-label="Up"></svg>9.42<!-- -->%</span><span class="text-text-muted text-xs">±1.12%</span></td><td><span><svg role="img" aria-label="Down"></svg>0.41<!-- -->%</span><span class="text-text-muted text-xs">±0.05%</span></td><td><span>14,853</span></td><td><span>$0.31</span></td><td><span>18.4K</span></td><td><span>$0.6</span><span>/</span><span>$2.5</span></td></tr>
</tbody></table>
<span>1,587,202<!-- --> <!-- -->sessions</span>
""";

    [Fact]
    public void Parse_只认模型行不把表头算进去()
    {
        var r = ArenaLeaderboardFetcher.Parse(RealFixture);
        Assert.Equal(2, r.Entries.Count);
    }

    /// <summary>
    /// 六个指标必须按页面顺序对位到具名字段。
    ///
    /// 这是整个解析器最容易静默出错的地方：对方调换列序，解析器照样给出六个看起来
    /// 正常的数字，只是每个都挂错了名字，页面上不会有任何异常。所以这里钉死真实的
    /// 六个值——错位立刻变红。
    /// </summary>
    [Fact]
    public void Parse_六个指标按页面顺序对位到具名字段()
    {
        var e = ArenaLeaderboardFetcher.Parse(RealFixture).Entries[0];

        Assert.Equal(13.85, e.NetImprovement!.Value);
        Assert.Equal(22.39, e.ConfirmedSuccess!.Value);
        Assert.Equal(36.35, e.PraiseVsComplaint!.Value);
        Assert.Equal(-0.91, e.Steerability!.Value);      // 页面上是 ▼0.91%
        Assert.Equal(11.07, e.BashRecovery!.Value);
        Assert.Equal(-0.37, e.ToolHallucination!.Value); // 页面上是 ▼0.37%
    }

    [Fact]
    public void Parse_向下的箭头必须变成负值_不是丢掉方向()
    {
        var e = ArenaLeaderboardFetcher.Parse(RealFixture).Entries[0];

        // 丢方向是最隐蔽的错法：−0.91 变成 +0.91，页面上就从「掉了」变成「涨了」
        Assert.True(e.Steerability!.Value < 0, "Down 方向必须体现为负值");
        Assert.True(e.ToolHallucination!.Value < 0, "Down 方向必须体现为负值");
    }

    [Fact]
    public void Parse_每个指标带上自己的置信区间半宽()
    {
        var e = ArenaLeaderboardFetcher.Parse(RealFixture).Entries[0];

        Assert.Equal(1.92, e.NetImprovement!.Margin);
        Assert.Equal(3.04, e.ConfirmedSuccess!.Margin);
        Assert.Equal(7.68, e.PraiseVsComplaint!.Margin);
        Assert.Equal(3.86, e.Steerability!.Margin);
        Assert.Equal(1.00, e.BashRecovery!.Margin);
        Assert.Equal(0.04, e.ToolHallucination!.Margin);
    }

    [Fact]
    public void Parse_名次带置信区间_页面上那个1到4()
    {
        var r = ArenaLeaderboardFetcher.Parse(RealFixture);

        Assert.Equal(1, r.Entries[0].Rank);
        Assert.Equal(1, r.Entries[0].RankLow);
        Assert.Equal(4, r.Entries[0].RankHigh);

        Assert.Equal(6, r.Entries[1].RankLow);
        Assert.Equal(13, r.Entries[1].RankHigh);
    }

    [Fact]
    public void Parse_取到会话数成本token与双向单价()
    {
        var e = ArenaLeaderboardFetcher.Parse(RealFixture).Entries[0];

        Assert.Equal(12416, e.Sessions);
        Assert.Equal(4.52, e.CostPerTask);
        Assert.Equal("55.2K", e.OutputTokens);
        Assert.Equal(10, e.PriceInput);
        Assert.Equal(50, e.PriceOutput);
    }

    [Fact]
    public void Parse_取到页面头部的会话总数()
    {
        var r = ArenaLeaderboardFetcher.Parse(RealFixture);
        Assert.Equal(1_587_202, r.TotalSessions);
    }

    [Fact]
    public void Parse_模型名厂商与授权_开源行的托管方不算授权()
    {
        var r = ArenaLeaderboardFetcher.Parse(RealFixture);

        Assert.Equal("Claude Fable 5.1 (Max)", r.Entries[0].Name);
        Assert.Equal("Anthropic", r.Entries[0].Organization);
        Assert.Equal("Proprietary", r.Entries[0].License);

        // 「Moonshot · Kimi K3 license · SiliconFlow」：第三段是托管方，不要
        Assert.Equal("Moonshot", r.Entries[1].Organization);
        Assert.Equal("Kimi K3 license", r.Entries[1].License);
    }

    [Fact]
    public void Parse_页面结构变了就返回空_而不是编出条目()
    {
        const string changed = """
<table><tbody>
<tr><td><span data-model="Claude Fable 5.1">Claude Fable 5.1</span></td><td><span data-score="13.85">13.85%</span></td></tr>
</tbody></table>
""";

        var r = ArenaLeaderboardFetcher.Parse(changed);

        // 解析不出来必须是「空」，让上层判定为失败并保留旧快照，
        // 绝不能凑出一个半截条目当成今天的榜单写进库。
        Assert.Empty(r.Entries);
    }

    [Fact]
    public void Parse_缺少误差范围时Margin为null_不拿0冒充()
    {
        const string noMargin = """
<table><tbody>
<tr><td><span title="Some Model">Some Model</span><span class="text-text-secondary truncate text-xs">Acme · Proprietary</span></td><td><span><svg role="img" aria-label="Up"></svg>1.23<!-- -->%</span></td></tr>
</tbody></table>
""";

        var r = ArenaLeaderboardFetcher.Parse(noMargin);

        Assert.Single(r.Entries);
        Assert.Equal(1.23, r.Entries[0].NetImprovement!.Value);
        Assert.Null(r.Entries[0].NetImprovement!.Margin);
    }

    [Fact]
    public void Parse_指标不足六个时不错位_缺的留null()
    {
        // 页面少给几列时，已有的仍按顺序对位，缺的是 null，不能把后面的值顶上来
        const string partial = """
<table><tbody>
<tr><td><span title="Some Model">Some Model</span><span class="text-text-secondary truncate text-xs">Acme · Proprietary</span></td><td><span><svg role="img" aria-label="Up"></svg>1.23<!-- -->%</span><span class="text-text-muted text-xs">±0.10%</span></td><td><span><svg role="img" aria-label="Up"></svg>4.56<!-- -->%</span><span class="text-text-muted text-xs">±0.20%</span></td></tr>
</tbody></table>
""";

        var e = ArenaLeaderboardFetcher.Parse(partial).Entries[0];

        Assert.Equal(1.23, e.NetImprovement!.Value);
        Assert.Equal(4.56, e.ConfirmedSuccess!.Value);
        Assert.Null(e.PraiseVsComplaint);
        Assert.Null(e.Steerability);
        Assert.Null(e.BashRecovery);
        Assert.Null(e.ToolHallucination);
    }

    [Fact]
    public void MinimumEntries_下限足够把改版与短榜分开()
    {
        Assert.InRange(ArenaLeaderboardFetcher.MinimumEntries, 2, 10);
    }

    [Fact]
    public void ExpectedMetricCount_与页面表头的指标列数一致()
    {
        Assert.Equal(6, ArenaLeaderboardFetcher.ExpectedMetricCount);
    }

    [Fact]
    public void BuildUrl_按分榜拼地址()
    {
        Assert.Equal("https://arena.ai/leaderboard/agent", ArenaLeaderboardFetcher.BuildUrl("agent"));
    }

    /// <summary>
    /// 锁住「只同步 agent 榜」这个实测结论。
    ///
    /// 第一版按站内路径一次放了五个分榜，部署后真跑一次才发现只有 agent 榜是服务端渲染
    /// 的，其余四个页面里只有「Loading leaderboard」骨架 + 一份未排名的模型目录。
    /// 这条守卫不是反对加榜，是要求加榜的人先证明数据拿得到。
    /// </summary>
    [Fact]
    public void Boards_只含服务端渲染的榜_加榜前须先证明数据拿得到()
    {
        Assert.Equal(new[] { "agent" }, ModelLeaderboardSyncWorker.Boards);
    }
}
