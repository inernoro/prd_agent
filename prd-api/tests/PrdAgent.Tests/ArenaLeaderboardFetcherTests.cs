using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using PrdAgent.Api.Services.ModelLeaderboard;
using PrdAgent.Core.Models;
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
    public async Task FetchAsync_源站拒绝时通过只读代理获取原始Html()
    {
        var handler = new RecordingHandler(RealFixture + RealFixture + RealFixture);
        var fetcher = new ArenaLeaderboardFetcher(new HttpClient(handler));

        var result = await fetcher.FetchAsync("agent", CancellationToken.None);

        Assert.Equal(6, result.Entries.Count);
        Assert.Equal(
            new[]
            {
                "https://arena.ai/leaderboard/agent",
                "https://r.jina.ai/https://arena.ai/leaderboard/agent",
            },
            handler.Requests.Select(x => x.Url));
        Assert.Null(handler.Requests[0].ReturnFormat);
        Assert.Equal("html", handler.Requests[1].ReturnFormat);
    }

    [Fact]
    public async Task FetchAsync_配置快照镜像时优先从远程Cds恢复并保留抓取时间()
    {
        var parsed = Padded(ArenaLeaderboardFetcher.Parse(RealFixture));
        var fetchedAt = new DateTime(2026, 9, 15, 8, 30, 0, DateTimeKind.Utc);
        var mirrorJson = JsonSerializer.Serialize(new
        {
            kind = parsed.Kind,
            fetchedAt,
            totalSessions = parsed.TotalSessions,
            totalVotes = parsed.TotalVotes,
            entries = parsed.Entries,
        });
        var handler = new RecordingHandler("unused", mirrorJson);
        var fetcher = new ArenaLeaderboardFetcher(
            new HttpClient(handler),
            "https://main-prd-agent.miduo.org/api/model-leaderboard/public-snapshot/");

        var result = await fetcher.FetchAsync("agent", CancellationToken.None);

        Assert.Equal(fetchedAt, result.SourceFetchedAt);
        Assert.Equal(ArenaLeaderboardFetcher.MinimumEntries, result.Entries.Count);
        Assert.Equal(
            "https://main-prd-agent.miduo.org/api/model-leaderboard/public-snapshot/agent",
            handler.Requests[1].Url);
        Assert.Equal(2, handler.Requests.Count);
    }

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
        Assert.Equal(-0.91, e.Steerability!.Value);      // 页面上是向下箭头0.91%
        Assert.Equal(11.07, e.BashRecovery!.Value);
        Assert.Equal(-0.37, e.ToolHallucination!.Value); // 页面上是向下箭头0.37%
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

    /// <summary>
    /// 名次必须取页面上写的那个，不能拿「这是第几个解析成功的行」顶替。
    ///
    /// fixture 的第二行在页面上是第 8 名（中间六名不在这段片段里）。按行序算会给出 2，
    /// 于是页面显示「02」、rankDelta 跟着一起错——而条目数、形状判定、六指标断言全都照样
    /// 通过，没有任何东西会红。并列名次、有意跳号、任何一行被拒绝，都是同一个错法。
    /// Codex 在 PR #1538 指出。
    /// </summary>
    [Fact]
    public void Parse_名次取页面上写的那个_不是第几行()
    {
        var r = ArenaLeaderboardFetcher.Parse(RealFixture);

        Assert.Equal(8, r.Entries[1].Rank);
    }

    [Fact]
    public void ParseScore_名次也取页面上写的那个()
    {
        var r = ArenaLeaderboardFetcher.Parse(ScoreFixture);

        // 两行在各自页面上都是第 1 名（分属不同的榜，片段拼在一起测列数混排）
        Assert.Equal(1, r.Entries[0].Rank);
        Assert.Equal(1, r.Entries[1].Rank);
    }

    /// <summary>
    /// 名次读不出来时整行拒绝，**不退回行序**。
    ///
    /// 上一条守的是「别拿行序当名次」，这条守的是那条退路本身：对方只要改掉名次格的写法，
    /// 每一行都会被「接受 + 编一个名次」，六指标、会话数、成本全都还对得上，条目数守卫
    /// 照样绿，而整份快照的名次是我们自己编的，还会覆盖掉昨天的好数据。
    /// 行序不是名次的降级近似，它是另一个量。Codex 在 PR #1538 第二轮指出。
    /// </summary>
    [Fact]
    public void Parse_名次读不出来时整行拒绝_不退回行序()
    {
        // 把两行的名次都改成读不出来的写法（>1< → >第1<），区间那两个数字原样保留。
        // 区间还在，正是这条守卫的要害：判据若扫整行就会顺到区间下界，照样给出一个名次。
        var broken = RealFixture
            .Replace("<td><span>1</span><span>1</span><span>4</span></td>",
                     "<td><span>第1</span><span>1</span><span>4</span></td>", StringComparison.Ordinal)
            .Replace("<td><span>8</span><span>6</span><span>13</span></td>",
                     "<td><span>第8</span><span>6</span><span>13</span></td>", StringComparison.Ordinal);
        Assert.NotEqual(RealFixture, broken);   // 替换真的命中了，不是一条空跑的绿灯

        var r = ArenaLeaderboardFetcher.Parse(broken);

        Assert.Empty(r.Entries);
    }

    [Fact]
    public void ParseScore_名次读不出来时整行拒绝()
    {
        // 分数榜的名次是单独一格：<td><div><span>1</span></div></td>
        var broken = ScoreFixture.Replace(
            "<td><div><span>1</span></div></td>",
            "<td><div><span>第一</span></div></td>",
            StringComparison.Ordinal);
        Assert.NotEqual(ScoreFixture, broken);

        var r = ArenaLeaderboardFetcher.Parse(broken);

        Assert.Empty(r.Entries);
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
        // 六个指标齐全（整行的准入条件），但第一个没有 ± 那一格
        const string noMargin = """
<table><tbody>
<tr><td><span>1</span><span>1</span><span>1</span></td><td><span title="Some Model">Some Model</span><span class="text-text-secondary truncate text-xs">Acme · Proprietary</span></td><td><span><svg role="img" aria-label="Up"></svg>1.23<!-- -->%</span></td><td><span><svg role="img" aria-label="Up"></svg>2.00<!-- -->%</span><span class="text-text-muted text-xs">±0.20%</span></td><td><span><svg role="img" aria-label="Up"></svg>3.00<!-- -->%</span><span class="text-text-muted text-xs">±0.30%</span></td><td><span><svg role="img" aria-label="Up"></svg>4.00<!-- -->%</span><span class="text-text-muted text-xs">±0.40%</span></td><td><span><svg role="img" aria-label="Up"></svg>5.00<!-- -->%</span><span class="text-text-muted text-xs">±0.50%</span></td><td><span><svg role="img" aria-label="Up"></svg>6.00<!-- -->%</span><span class="text-text-muted text-xs">±0.60%</span></td></tr>
</tbody></table>
""";

        var r = ArenaLeaderboardFetcher.Parse(noMargin);

        Assert.Single(r.Entries);
        Assert.Equal(1.23, r.Entries[0].NetImprovement!.Value);
        Assert.Null(r.Entries[0].NetImprovement!.Margin);
        // 后面五个的误差要各归各位，不能因为第一个缺了就整体错位
        Assert.Equal(0.20, r.Entries[0].ConfirmedSuccess!.Margin);
        Assert.Equal(0.60, r.Entries[0].ToolHallucination!.Margin);
    }

    /// <summary>
    /// 指标数量不足六个，整行拒绝——不是「缺的留 null」。
    ///
    /// 这条原先断言的是「已有的按顺序对位、缺的留 null」，那只在**尾部**缺列时才安全。
    /// 对方把中间某一格换个写法（Codex 在 PR #1538 指出），解析出五个值会整体前移一位：
    /// 「好评比」的数字挂到「可操控性」名下，而条目数与形状判定照样通过，
    /// 于是一份每个字段都挂错名字、看起来却完全正常的快照会覆盖掉好数据。
    /// 所以判据改成「恰好六个，否则拒绝整行」。
    /// </summary>
    [Fact]
    public void Parse_指标不足六个时整行拒绝_不拿错位的值冒充()
    {
        const string partial = """
<table><tbody>
<tr><td><span>1</span><span>1</span><span>1</span></td><td><span title="Some Model">Some Model</span><span class="text-text-secondary truncate text-xs">Acme · Proprietary</span></td><td><span><svg role="img" aria-label="Up"></svg>1.23<!-- -->%</span><span class="text-text-muted text-xs">±0.10%</span></td><td><span><svg role="img" aria-label="Up"></svg>4.56<!-- -->%</span><span class="text-text-muted text-xs">±0.20%</span></td></tr>
</tbody></table>
""";

        var r = ArenaLeaderboardFetcher.Parse(partial);

        // 拒绝后条目数会掉到 MinimumEntries 以下，FetchAsync 据此抛异常、保留旧快照
        Assert.Empty(r.Entries);
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

    }

    /// <summary>
    /// Worker 的 Boards 必须是目录的转发，不能自己再写一份数组。
    ///
    /// 用源码扫描而不是 <c>Assert.Equal(Catalog.Keys, Worker.Boards)</c>：Worker 拖着
    /// BackgroundService 与 Mongo，link 不进这个测试项目（见 PrdAgent.Tests.csproj 的
    /// Compile Include 那一段）。判据换了形式，要防的事没变——两份清单各自漂移。
    /// </summary>
    [Fact]
    public void Worker的分榜清单必须转发目录_不许自己再写一份()
    {
        var worker = Path.Combine(
            LocateRepoRoot(),
            "prd-api", "src", "PrdAgent.Api", "Services", "ModelLeaderboard",
            "ModelLeaderboardSyncWorker.cs");

        Assert.True(File.Exists(worker), $"找不到 {worker}——本守卫的前提不成立，请核对路径");

        var source = File.ReadAllText(worker);
        Assert.Contains("public static string[] Boards => ModelLeaderboardCatalog.Keys;", source);
    }

    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "doc"))
                && Directory.Exists(Path.Combine(dir.FullName, "prd-api")))
                return dir.FullName;
            dir = dir.Parent;
        }
        return AppContext.BaseDirectory;
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

    // ── 写库前的三条判据（EnsureUsable）────────────────────────────────────
    //
    // 这三条原来埋在 FetchAsync 里，只有联网才走得到，等于三条从没被验过的判据。
    // 抽出来之后每条都有守卫：把判据删掉，下面对应那条会红。

    /// <summary>
    /// 厂商几乎全空 = 模型格里那串类名变了。条目数与形状判定都照样通过，只有这条能拦住：
    /// 页面上所有模型的厂商栏空着，「仅开源」筛选被静默清空（Codex 在 PR #1538 指出）。
    /// </summary>
    [Fact]
    public void EnsureUsable_厂商几乎全空时拒绝整份()
    {
        // 只改类名，表格数据一个字不动——正是对方重排类名时会发生的事
        var renamed = RealFixture.Replace(
            "text-text-secondary truncate text-xs",
            "text-text-secondary truncate text-xs-v2", StringComparison.Ordinal);
        Assert.NotEqual(RealFixture, renamed);

        var parsed = ArenaLeaderboardFetcher.Parse(renamed);
        Assert.Equal(2, parsed.Entries.Count);                       // 行还在，数据还在
        Assert.All(parsed.Entries, e => Assert.Null(e.Organization)); // 厂商没了

        var padded = Padded(parsed);
        var ex = Assert.Throws<InvalidOperationException>(
            () => ArenaLeaderboardFetcher.EnsureUsable("u", "agent", padded));
        Assert.Contains("带厂商", ex.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// 授权几乎全空 = 厂商那段的分隔符或授权写法变了。厂商仍解得出来、它那条覆盖率仍是
    /// 100%，所以必须单独判这一项（Codex 在 PR #1538 指出）：授权是「仅开源」筛选的唯一
    /// 判据，isOpenSource(null) 一律判闭源，缺了它那个筛选会静默清空。
    ///
    /// 阈值取一半而非 100%：实测四个榜的授权覆盖率是 87.5%–98.6%（有些行只有厂商一段），
    /// 要求全覆盖会把每个榜都拒掉。
    /// </summary>
    [Fact]
    public void EnsureUsable_授权几乎全空时拒绝整份()
    {
        // 只去掉分隔符，厂商那段照样在——正是对方改写法时会发生的事
        var noLicense = RealFixture.Replace(" · ", " ", StringComparison.Ordinal);
        Assert.NotEqual(RealFixture, noLicense);

        var parsed = ArenaLeaderboardFetcher.Parse(noLicense);
        Assert.Equal(2, parsed.Entries.Count);                        // 行还在
        Assert.All(parsed.Entries, e => Assert.NotNull(e.Organization)); // 厂商还在
        Assert.All(parsed.Entries, e => Assert.Null(e.License));       // 授权没了

        var ex = Assert.Throws<InvalidOperationException>(
            () => ArenaLeaderboardFetcher.EnsureUsable("u", "agent", Padded(parsed)));
        Assert.Contains("带授权", ex.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// 分数榜的票数读不出来就整行拒绝。对方只改票数格的写法时，分数已经解析成功、行的形状
    /// 也已判定，原来会「留 null 照样接受」——整列票数在页面上变成横线，而 FetchedAt 是新的、
    /// 陈旧度那条 check 判绿（Codex 在 PR #1538 指出）。
    /// 票数是判断「这个分可不可信」的唯一依据，3149 票与 23 万票天差地别。
    /// </summary>
    [Fact]
    public void ParseScore_票数读不出来时整行拒绝()
    {
        // 把票数那格的千分位数字换成带单位的写法
        var broken = ScoreFixture
            .Replace('"' + "body-sm" + '"' + ">3,149<", '"' + "body-sm" + '"' + ">3.1k<", StringComparison.Ordinal)
            .Replace('"' + "body-sm" + '"' + ">2,281<", '"' + "body-sm" + '"' + ">2.3k<", StringComparison.Ordinal);
        Assert.NotEqual(ScoreFixture, broken);

        var r = ArenaLeaderboardFetcher.Parse(broken);

        Assert.Empty(r.Entries);
    }

    [Fact]
    public void EnsureUsable_条目太少时拒绝整份()
    {
        var parsed = ArenaLeaderboardFetcher.Parse(RealFixture);   // 2 条，低于下限 5

        var ex = Assert.Throws<InvalidOperationException>(
            () => ArenaLeaderboardFetcher.EnsureUsable("u", "agent", parsed));
        Assert.Contains("下限", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EnsureUsable_形状与目录声明不符时拒绝整份()
    {
        // agent 榜解出来却是分数形状 = 对方把这个榜换了结构
        var parsed = Padded(ArenaLeaderboardFetcher.Parse(ScoreFixture));

        var ex = Assert.Throws<InvalidOperationException>(
            () => ArenaLeaderboardFetcher.EnsureUsable("u", "agent", parsed));
        Assert.Contains("形状", ex.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// agent 榜的会话数几乎全空 = 对方改了那一格的写法。指标格解析成功、行数与形状判定
    /// 照样通过，所以原来这一份会被接受、覆盖掉昨天的好数据——页面上那一列变成横线，
    /// 而 FetchedAt 是新的、陈旧度那条 check 判绿（Codex 在 PR #1538 指出；
    /// 上一轮把分数榜的票数改成必填，agent 榜这半边是同一个洞，当时没跟着补）。
    ///
    /// 会话数是 agent 榜唯一的样本量：「这个净改进是 43 次会话还是 4 万次会话里测出来的」。
    /// </summary>
    [Fact]
    public void EnsureUsable_agent榜会话数几乎全空时拒绝整份()
    {
        // 只去掉千分位（SessionsRegex 要的正是带千分位的数字），其余一个字不动——
        // 正是对方把那一格换个写法时会发生的事
        var noSessions = RealFixture
            .Replace(">12,416<", ">12416<", StringComparison.Ordinal)
            .Replace(">14,853<", ">14853<", StringComparison.Ordinal);
        Assert.NotEqual(RealFixture, noSessions);

        var parsed = ArenaLeaderboardFetcher.Parse(noSessions);
        Assert.Equal(2, parsed.Entries.Count);                           // 行还在
        Assert.All(parsed.Entries, e => Assert.NotNull(e.Organization));  // 厂商还在
        Assert.All(parsed.Entries, e => Assert.NotNull(e.License));       // 授权还在
        Assert.All(parsed.Entries, e => Assert.Null(e.Sessions));         // 会话数没了

        var ex = Assert.Throws<InvalidOperationException>(
            () => ArenaLeaderboardFetcher.EnsureUsable("u", "agent", Padded(parsed)));
        Assert.Contains("带会话数", ex.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// 分数榜压根没有会话数这一列，不能被上面那条判据顺手拒掉——十个分数榜会全军覆没。
    /// 这条钉住「只对 agent 榜判」，去掉那个 Kind 判断它就会变红。
    /// </summary>
    [Fact]
    public void EnsureUsable_分数榜没有会话数也放行()
    {
        var parsed = Padded(ArenaLeaderboardFetcher.Parse(ScoreFixture));
        Assert.All(parsed.Entries, e => Assert.Null(e.Sessions));   // 它本来就没有这一列

        ArenaLeaderboardFetcher.EnsureUsable("u", "text", parsed);   // 不抛即通过
    }

    /// <summary>
    /// 会话数不足 1000 的模型天生读不出来（SessionsRegex 要带千分位），所以这一项用
    /// 覆盖率而不是像票数那样整行拒绝——个别新上榜的小样本模型是合法的，不该被丢掉。
    /// </summary>
    [Fact]
    public void EnsureUsable_个别行缺会话数仍放行()
    {
        // 直接搭条目而不是改 fixture 再走 Padded：Padded 是**循环复用同一批引用**把条目
        // 补到下限的，两行的 fixture 里改掉一行，补完是「五条里三条缺」——反而越过了阈值，
        // 这条用例就会因为阈值以外的原因变红，测不到它要测的东西。
        var entries = Enumerable.Range(0, ArenaLeaderboardFetcher.MinimumEntries)
            .Select(i => new ModelLeaderboardEntry
            {
                Rank = i + 1,
                Name = $"model-{i}",
                Organization = "Anthropic",
                License = "Proprietary",
                // 只有一行缺：会话数不足 1000 的模型天生读不出来，那是合法的新上榜模型
                Sessions = i == 0 ? null : 12_000 + i,
            })
            .ToList();

        var parsed = new ArenaLeaderboardFetcher.ParseResult(BoardKind.Agent, entries, null, null);

        ArenaLeaderboardFetcher.EnsureUsable("u", "agent", parsed);   // 不抛即通过
    }

    [Fact]
    public void EnsureUsable_正常的一份放行()
    {
        var parsed = Padded(ArenaLeaderboardFetcher.Parse(RealFixture));

        ArenaLeaderboardFetcher.EnsureUsable("u", "agent", parsed);   // 不抛即通过
    }

    /// <summary>
    /// 严重缩水必须拒绝。text 榜实测 402 行，对方只改一部分版式、只剩五行能解析时，
    /// 全局下限（5）通过、覆盖率那几条判据算比例也通过——于是一份少了 397 个模型的快照
    /// 被接受、FetchedAt 还是新的、陈旧度判绿（Codex 在 PR #1538 指出）。
    /// </summary>
    [Fact]
    public void EnsureNotTruncated_只剩零头时拒绝()
    {
        var ex = Assert.Throws<InvalidOperationException>(
            () => ArenaLeaderboardFetcher.EnsureNotTruncated("text", newCount: 5, previousCount: 402));
        Assert.Contains("只解析出 5 个条目", ex.Message, StringComparison.Ordinal);
        Assert.Contains("402", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EnsureNotTruncated_首次同步没有参照时不判()
    {
        // 上一份不存在（previousCount=0）时只能靠全局下限，这里不许拦
        ArenaLeaderboardFetcher.EnsureNotTruncated("text", newCount: 5, previousCount: 0);
    }

    [Theory]
    [InlineData(402, 402)]   // 没变
    [InlineData(402, 410)]   // 涨了
    [InlineData(402, 201)]   // 正好一半，放行（判据是「不足一半」才拒）
    [InlineData(43, 40)]     // agent 榜日常小幅波动
    public void EnsureNotTruncated_正常波动放行(int previousCount, int newCount)
    {
        ArenaLeaderboardFetcher.EnsureNotTruncated("text", newCount, previousCount);
    }

    [Fact]
    public void EnsureNotTruncated_判据是比例不是写死的每榜下限()
    {
        // 同一个绝对值在不同榜上结论不同：50 条对 43 行的 agent 榜是涨，
        // 对 402 行的 text 榜是崩。写死每榜下限的表会漂，比例不会。
        ArenaLeaderboardFetcher.EnsureNotTruncated("agent", newCount: 50, previousCount: 43);
        Assert.Throws<InvalidOperationException>(
            () => ArenaLeaderboardFetcher.EnsureNotTruncated("text", newCount: 50, previousCount: 402));
    }

    /// <summary>
    /// 把条目补到下限以上，好让「条目太少」这条不抢在被测判据前面抛。
    /// 补的是解析出来的真条目的副本，厂商等字段跟着一起复制。
    /// </summary>
    private static ArenaLeaderboardFetcher.ParseResult Padded(ArenaLeaderboardFetcher.ParseResult r)
    {
        var entries = new List<ModelLeaderboardEntry>(r.Entries);
        while (entries.Count < ArenaLeaderboardFetcher.MinimumEntries)
            entries.Add(entries[entries.Count % r.Entries.Count]);
        return r with { Entries = entries };
    }

    private sealed class RecordingHandler(string fallbackHtml, string? mirrorJson = null) : HttpMessageHandler
    {
        public List<(string Url, string? ReturnFormat)> Requests { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var returnFormat = request.Headers.TryGetValues("X-Return-Format", out var values)
                ? values.Single()
                : null;
            Requests.Add((request.RequestUri!.ToString(), returnFormat));

            if (Requests.Count == 1)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));

            var content = mirrorJson is not null && request.RequestUri!.Host == "main-prd-agent.miduo.org"
                ? mirrorJson
                : fallbackHtml;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(content),
            });
        }
    }
}
