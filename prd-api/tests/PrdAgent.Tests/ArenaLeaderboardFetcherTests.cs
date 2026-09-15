using System.Linq;
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

    [Fact]
    public void Parse_Agent榜判成Agent形状()
    {
        Assert.Equal(BoardKind.Agent, ArenaLeaderboardFetcher.Parse(RealFixture).Kind);
    }

    // ───────────────────────── 分数榜（其余十个榜） ─────────────────────────

    /// <summary>
    /// 真实页面片段：表头 + text-to-image 榜首（5 列、±区间、带 Preliminary 标）
    /// + code 榜首（7 列、非对称的「+16/-16」、带单价与上下文）。
    ///
    /// 两行列数不同是**故意的**：分数榜里图像视频类只有 5 列，文本类有 7 列。
    /// 解析器按单元格位置取值，列数不同也不能错位。
    /// </summary>
    private const string ScoreFixture = """
<table><thead><tr><th>Rank</th><th>Rank Spread</th><th>Model</th><th>Score</th><th>Votes</th></tr></thead><tbody>
<tr><td><div><span>1</span></div></td><td><div><span>1</span><svg width="16" viewBox="0 0 24 24"><path/></svg><span>2</span></div></td><td><div><div class="shrink-0"><svg viewBox="0 0 16 16"><path/></svg></div><div class="flex min-w-0 flex-1 flex-col"><a target="_blank" href="https://openai.com/index/introducing-chatgpt-images-2-5/" class="text-interactive-active inline-flex min-w-0 items-center font-mono text-sm"><span class="max-w-full truncate" title="gpt-image-2.5-sunburst">gpt-image-2.5-sunburst</span></a><span class="text-text-secondary truncate text-xs">OpenAI · Proprietary</span></div></div></td><td><div><span class="body-sm">1421</span><span class="text-text-tertiary body-xs">±13</span><button><span><svg class="lucide lucide-info"><path/></svg><span>Preliminary</span></span></button></div></td><td><span class="body-sm">3,149</span></td></tr>
<tr><td><div><span>1</span></div></td><td><div><span>1</span><svg width="16" viewBox="0 0 24 24"><path/></svg><span>1</span></div></td><td><div><div class="shrink-0"><svg viewBox="0 0 16 16"><path/></svg></div><div class="flex min-w-0 flex-1 flex-col"><a target="_blank" href="https://openai.com/index/gpt-6-astra/" class="text-interactive-active inline-flex min-w-0 items-center font-mono text-sm"><span class="max-w-full truncate" title="gpt-6-astra-max">gpt-6-astra-max</span></a><span class="text-text-secondary truncate text-xs">OpenAI · Proprietary</span></div></div></td><td><div><span class="body-sm">1800</span><span class="text-text-tertiary body-xs">+16/-16</span></div></td><td><span class="body-sm">2,281</span></td><td><span class="text-sm">$10<!-- --> / <!-- -->$50</span></td><td><span class="text-sm">1.1M</span></td></tr>
</tbody></table>
<span>8,146,274<!-- --> <!-- -->votes</span>
""";

    [Fact]
    public void ParseScore_判成分数形状并取到两行()
    {
        var r = ArenaLeaderboardFetcher.Parse(ScoreFixture);

        Assert.Equal(BoardKind.Score, r.Kind);
        Assert.Equal(2, r.Entries.Count);
    }

    [Fact]
    public void ParseScore_对战分与对称区间()
    {
        var e = ArenaLeaderboardFetcher.Parse(ScoreFixture).Entries[0];

        Assert.Equal(1421, e.Score);
        Assert.Equal(13, e.ScoreMarginUp);
        Assert.Equal(13, e.ScoreMarginDown);
        Assert.Equal(3149, e.Votes);
        Assert.Equal("gpt-image-2.5-sunburst", e.Name);
        Assert.Equal("OpenAI", e.Organization);
    }

    /// <summary>
    /// 非对称区间必须原样保留两个数。
    ///
    /// 压成一个对称半宽看着无害（这两个数恰好相等），但真遇到「+20/-5」时，
    /// 误差须会画错方向——而那正是最需要看清楚的那种行。
    /// </summary>
    [Fact]
    public void ParseScore_非对称区间不压成对称()
    {
        var e = ArenaLeaderboardFetcher.Parse(ScoreFixture).Entries[1];

        Assert.Equal(1800, e.Score);
        Assert.Equal(16, e.ScoreMarginUp);
        Assert.Equal(16, e.ScoreMarginDown);
    }

    /// <summary>
    /// 列数不同的两行不能互相错位：5 列那行没有单价与上下文，7 列那行有。
    /// 靠「整行里第几个匹配」取值的写法在这里一定会翻车。
    /// </summary>
    [Fact]
    public void ParseScore_五列与七列混排时不错位()
    {
        var r = ArenaLeaderboardFetcher.Parse(ScoreFixture);

        // 图像榜只有五列：没有单价、没有上下文
        Assert.Null(r.Entries[0].PriceInput);
        Assert.Null(r.Entries[0].ContextWindow);

        // 代码榜七列：单价与上下文都在
        Assert.Equal(10, r.Entries[1].PriceInput);
        Assert.Equal(50, r.Entries[1].PriceOutput);
        Assert.Equal("1.1M", r.Entries[1].ContextWindow);
        Assert.Equal(2281, r.Entries[1].Votes);
    }

    [Fact]
    public void ParseScore_名次区间取自它自己那一格()
    {
        var r = ArenaLeaderboardFetcher.Parse(ScoreFixture);

        // 分数（1421 / 1800）也是裸数字，按整行顺序数会把它当成名次上界
        Assert.Equal(1, r.Entries[0].RankLow);
        Assert.Equal(2, r.Entries[0].RankHigh);
        Assert.Equal(1, r.Entries[1].RankLow);
        Assert.Equal(1, r.Entries[1].RankHigh);
    }

    [Fact]
    public void ParseScore_保留榜单的初步标注()
    {
        var r = ArenaLeaderboardFetcher.Parse(ScoreFixture);

        // 3149 票的初步分和 23 万票的稳定分摆在一起，不标注就是在误导读者
        Assert.True(r.Entries[0].Preliminary);
        Assert.False(r.Entries[1].Preliminary);
    }

    [Fact]
    public void ParseScore_取到页面头部的总投票数()
    {
        var r = ArenaLeaderboardFetcher.Parse(ScoreFixture);

        Assert.Equal(8_146_274, r.TotalVotes);
        // 分数榜没有「会话」这个口径，不许拿投票数冒充
        Assert.Null(r.TotalSessions);
    }

    // ───────────────────────── 分榜目录 ─────────────────────────

    /// <summary>
    /// 锁住这份实测出来的分榜清单。
    ///
    /// 第一版这里只有 agent 一个，注释写着「其余榜是客户端懒加载」——那是错的：当时试的是
    /// <c>/leaderboard/image</c> 这类**猜出来的路径**，它们在 arena.ai 上不存在，
    /// 返回的 404 兜底页里有一句「Loading leaderboard」，于是被当成了「骨架没加载完」。
    /// 下面十一个是从站内链接抠出来的真实路径，2026-09-15 逐个抓过，行数分别是
    /// 43 / 128 / 402 / 152 / 34 / 44 / 78 / 55 / 48 / 48 / 10。
    ///
    /// 这条守卫不反对增删榜，它要求改这份清单的人**先真抓一次数一数行数**
    /// （.claude/rules/predicate-and-wiring-discipline.md 形状 8：不许拿不成立的证据当证明）。
    /// </summary>
    [Fact]
    public void Catalog_十一个实测存在的分榜()
    {
        Assert.Equal(
            new[]
            {
                "agent", "code",
                "text", "vision", "search", "document",
                "text-to-image", "image-edit",
                "text-to-video", "image-to-video", "video-edit",
            },
            ModelLeaderboardCatalog.Keys);

        Assert.Equal(ModelLeaderboardCatalog.Keys, ModelLeaderboardSyncWorker.Boards);
    }

    [Fact]
    public void Catalog_每个榜都有中文名分组与说明()
    {
        foreach (var b in ModelLeaderboardCatalog.Boards)
        {
            Assert.False(string.IsNullOrWhiteSpace(b.Label), $"{b.Key} 缺中文名");
            Assert.False(string.IsNullOrWhiteSpace(b.Group), $"{b.Key} 缺分组");
            Assert.False(string.IsNullOrWhiteSpace(b.Hint), $"{b.Key} 缺说明");
            Assert.Contains(b.Kind, new[] { BoardKind.Agent, BoardKind.Score });
        }
    }

    [Fact]
    public void Catalog_只有Agent榜是Agent形状()
    {
        // 十一个榜里只有 agent 是六指标那套；这条如果变了，页面的两套列也得跟着改
        Assert.Equal(
            new[] { "agent" },
            ModelLeaderboardCatalog.Boards.Where(b => b.Kind == BoardKind.Agent).Select(b => b.Key));
    }

    [Fact]
    public void Catalog_默认榜在清单里()
    {
        Assert.True(ModelLeaderboardCatalog.Contains(ModelLeaderboardCatalog.DefaultBoard));
    }

    [Fact]
    public void Catalog_没有重复的榜()
    {
        Assert.Equal(
            ModelLeaderboardCatalog.Keys.Length,
            ModelLeaderboardCatalog.Keys.Distinct(StringComparer.OrdinalIgnoreCase).Count());
    }
}
