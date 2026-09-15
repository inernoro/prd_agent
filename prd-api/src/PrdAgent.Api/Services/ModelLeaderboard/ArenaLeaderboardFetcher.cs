using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.ModelLeaderboard;

/// <summary>
/// 从 arena.ai 的公开榜单页抓取并解析一个榜单。
///
/// ## 为什么解析 HTML
///
/// arena.ai（即 LMArena，两个域名同一套部署）没有开放榜单 API：实测
/// <c>GET /api/leaderboard</c> 返回 403 "Route not allowed"。榜单分数是服务端渲染进
/// HTML 的，所以只能解析页面——但好处是不需要跑无头浏览器，一次 HTTP 请求就够。
///
/// ## 解析锚点选的是语义属性，不是 class
///
/// 方向与数值取自无障碍标签（<c>aria-label="Up"</c> / <c>"Down"</c> 后跟的数字），
/// 模型名取自 <c>title="..."</c>。这两个是给读屏软件用的属性，比 Tailwind 那串
/// <c>text-text-secondary truncate text-xs</c> 稳得多——后者是构建产物，换个主题或
/// 升级一次依赖就会变。
///
/// ## 两种表格形状
///
/// arena.ai 的分榜不是一个模子出来的（见 <see cref="ModelLeaderboardCatalog"/>）：
/// agent 榜是六个百分比指标，其余十个榜是「Elo 分数 ± 区间 + 票数」。
/// <see cref="Parse"/> **逐行**尝试两种形状并按命中多的那种定 Kind——刻意不按表头文字判，
/// 因为表头是我们唯一拿不到机读关联的东西，而行内的形状特征（▲▼ 的 aria-label vs
/// 分数格的「数字 + ±区间」）互斥且稳定。
///
/// 每行六个指标按页面里的**出现顺序**对应表头
/// （净改进 / 任务完成 / 好评比 / 可操控性 / 命令恢复 / 工具幻觉）。刻意不按列名去认：
/// 那些中文名是我们自己起的，页面上只有英文表头，而表头与单元格之间没有任何机读关联。
///
/// ## 解析不出东西 = 失败，不是空榜
///
/// 页面改版时，正则会安静地匹配到 0 行。若把这种情况当成「今天榜单是空的」写进库，
/// 就会用一份空快照覆盖掉昨天的好数据，页面变成空白且没人知道为什么。
/// 所以条目数低于 <see cref="MinimumEntries"/> 一律抛异常，交给调用方保留旧快照并告警
/// （见 .claude/rules/degradation-must-alarm.md：降级必须响铃）。
/// </summary>
public class ArenaLeaderboardFetcher
{
    /// <summary>榜单根地址。分榜路径拼在它后面。</summary>
    public const string BaseUrl = "https://arena.ai/leaderboard";

    /// <summary>
    /// 一份可信快照的最少条目数。
    ///
    /// 取 5 是因为：agent 榜实测 43 行，正常情况远超这个数；而页面改版导致解析失效时
    /// 拿到的是 0 到 1 行。5 足够把「改版」和「榜单真的很短」分开，又不会因为某个冷门
    /// 分榜只有十来个模型就误判。
    /// </summary>
    public const int MinimumEntries = 5;

    /// <summary>每行应有的指标数。少于这个数说明页面加了列或改了结构，该行按残缺处理。</summary>
    private const int MetricCount = 6;

    private static readonly Regex RowRegex = new(
        @"<tr[^>]*>(.*?)</tr>", RegexOptions.Singleline | RegexOptions.Compiled);

    /// <summary>模型名。title 属性上的是完整名，标签文本会被 truncate 截断，所以取属性。</summary>
    private static readonly Regex NameRegex = new(
        @"title=""([^""]+)""", RegexOptions.Compiled);

    /// <summary>
    /// 指标的方向与数值。页面把 ▲/▼ 画成一个带 aria-label 的 svg，紧跟着是数字。
    /// 中间那段 <c>&lt;!-- --&gt;</c> 是 React 的注释标记，必须容忍。
    /// </summary>
    private static readonly Regex DirectionValueRegex = new(
        @"aria-label=""(Up|Down)""[^>]*>.*?</svg>\s*([\d.]+)<!-- -->%",
        RegexOptions.Singleline | RegexOptions.Compiled);

    /// <summary>
    /// 置信区间半宽。同时认字面 ± 和 HTML 实体 &amp;plusmn;：抓到的那一版页面用的是
    /// 字面字符，但这是别人家的页面，同一个符号换种写法是随时可能发生的事。
    /// </summary>
    private static readonly Regex MarginRegex = new(
        @"(?:±|&plusmn;)\s*([\d.]+)%", RegexOptions.Compiled);

    /// <summary>厂商与授权，页面里是「Anthropic · Proprietary」这种一段式文本。</summary>
    private static readonly Regex OrgRegex = new(
        @"text-text-secondary truncate text-xs"">([^<]+)<", RegexOptions.Compiled);

    /// <summary>行首那三个裸数字：名次、名次区间下界、上界。</summary>
    private static readonly Regex BareNumberRegex = new(@">(\d+)<", RegexOptions.Compiled);

    /// <summary>会话数（带千分位）。</summary>
    private static readonly Regex SessionsRegex = new(@">(\d{1,3}(?:,\d{3})+)<", RegexOptions.Compiled);

    /// <summary>美元金额，按出现顺序是「单任务成本、输入单价、输出单价」。</summary>
    private static readonly Regex DollarRegex = new(@">\$([\d.]+)<", RegexOptions.Compiled);

    /// <summary>输出 token（如 55.2K），原样保留页面写法。</summary>
    private static readonly Regex TokensRegex = new(@">([\d.]+K)<", RegexOptions.Compiled);

    /// <summary>页面头部的会话总数，如「1,587,202 sessions」。</summary>
    private static readonly Regex TotalSessionsRegex = new(
        @"(\d{1,3}(?:,\d{3})+)<!-- --> <!-- -->sessions", RegexOptions.Compiled);

    /// <summary>分数榜页面头部的总投票数，如「8,146,274 votes」。</summary>
    private static readonly Regex TotalVotesRegex = new(
        @"(\d{1,3}(?:,\d{3})+)<!-- --> <!-- -->votes", RegexOptions.Compiled);

    /// <summary>把一行切成单元格。分数榜的列位置是固定的，按格取值比在整行里数第几个匹配稳。</summary>
    private static readonly Regex CellRegex = new(
        @"<td[^>]*>(.*?)</td>", RegexOptions.Singleline | RegexOptions.Compiled);

    /// <summary>
    /// 分数格：分数 + 置信区间。两种写法都要认——多数榜是「±13」，code 榜是「+16/-16」。
    /// 不依赖 class 名（那是构建产物），只认「一个数字 span 紧跟一个区间 span」这个结构。
    /// </summary>
    private static readonly Regex ScoreRegex = new(
        @">([\d,]+(?:\.\d+)?)</span><span[^>]*>(?:±|&plusmn;)([\d.]+)</span>"
        + @"|>([\d,]+(?:\.\d+)?)</span><span[^>]*>\+([\d.]+)/-([\d.]+)</span>",
        RegexOptions.Compiled);

    /// <summary>票数格里的整数（可能带千分位，也可能只有三位数）。</summary>
    private static readonly Regex PlainNumberRegex = new(@">(\d{1,3}(?:,\d{3})*)<", RegexOptions.Compiled);

    /// <summary>上下文窗口，如 1M / 200K。</summary>
    private static readonly Regex ContextRegex = new(@">([\d.]+[KM])<", RegexOptions.Compiled);

    private readonly HttpClient _http;

    public ArenaLeaderboardFetcher(HttpClient http)
    {
        _http = http;
    }

    /// <summary>拼出某个分榜的地址。</summary>
    public static string BuildUrl(string board) => $"{BaseUrl}/{board}";

    /// <summary>解析结果：条目 + 页面级元信息。<paramref name="Kind"/> 见 <see cref="BoardKind"/>。</summary>
    public record ParseResult(
        string Kind,
        List<ModelLeaderboardEntry> Entries,
        long? TotalSessions,
        long? TotalVotes);

    /// <summary>
    /// 抓取并解析一个分榜。
    /// </summary>
    /// <exception cref="InvalidOperationException">解析到的条目少于 <see cref="MinimumEntries"/>，视为页面改版。</exception>
    public async Task<ParseResult> FetchAsync(string board, CancellationToken ct)
    {
        var url = BuildUrl(board);
        using var response = await _http.GetAsync(url, ct);
        response.EnsureSuccessStatusCode();
        var html = await response.Content.ReadAsStringAsync(ct);

        var result = Parse(html);
        if (result.Entries.Count < MinimumEntries)
        {
            throw new InvalidOperationException(
                $"解析 {url} 只得到 {result.Entries.Count} 个条目（下限 {MinimumEntries}），" +
                "多半是页面结构变了；本次不写库，保留上一份快照。");
        }

        // 形状与目录声明的不符 = 对方把这个榜换了结构。宁可让数据变旧，也不要写进一批
        // 按错误形状解出来的值——那种错误在页面上看起来完全正常，没人会发现
        // （.claude/rules/degradation-must-alarm.md：降级必须响铃）。
        var expected = ModelLeaderboardCatalog.Find(board)?.Kind;
        if (expected is not null && result.Kind != expected)
        {
            throw new InvalidOperationException(
                $"{url} 解析出的表格形状是 {result.Kind}，目录里声明的是 {expected}；" +
                "对方多半改了这个榜的结构，本次不写库，保留上一份快照。");
        }

        return result;
    }

    /// <summary>
    /// 从页面 HTML 解析条目。抽成公开静态方法，测试可以直接喂一段存档 HTML 断言解析结果，
    /// 不必联网。
    /// </summary>
    public static ParseResult Parse(string html)
    {
        // 两种形状各攒一份，最后按命中多的那种定 Kind。逐行判、不看表头的理由见类注释。
        var agentEntries = new List<ModelLeaderboardEntry>();
        var scoreEntries = new List<ModelLeaderboardEntry>();

        foreach (Match row in RowRegex.Matches(html))
        {
            var block = row.Groups[1].Value;

            var nameMatch = NameRegex.Match(block);
            if (!nameMatch.Success) continue;   // 表头行与筛选行就是这么被跳过的

            var name = WebUtility.HtmlDecode(nameMatch.Groups[1].Value);
            var (organization, license) = ParseOrgLicense(block);

            var agent = TryParseAgentRow(block, name, organization, license, agentEntries.Count + 1);
            if (agent is not null)
            {
                agentEntries.Add(agent);
                continue;
            }

            var score = TryParseScoreRow(block, name, organization, license, scoreEntries.Count + 1);
            if (score is not null) scoreEntries.Add(score);
        }

        long? totalSessions = ParseGroupedNumber(TotalSessionsRegex, html);
        long? totalVotes = ParseGroupedNumber(TotalVotesRegex, html);

        return scoreEntries.Count > agentEntries.Count
            ? new ParseResult(BoardKind.Score, scoreEntries, totalSessions, totalVotes)
            : new ParseResult(BoardKind.Agent, agentEntries, totalSessions, totalVotes);
    }

    /// <summary>
    /// 按 agent 榜的形状解析一行：六个「▲/▼ + 百分比 + ±误差」的指标。
    /// 认不出来返回 null（那多半是分数榜的行）。
    /// </summary>
    private static ModelLeaderboardEntry? TryParseAgentRow(
        string block, string name, string? organization, string? license, int rank)
    {
        // 指标：方向决定符号，误差按出现顺序一一对应
        var dirVals = DirectionValueRegex.Matches(block);
        if (dirVals.Count == 0) return null;

        var margins = MarginRegex.Matches(block);
        var metrics = new List<ModelLeaderboardMetric>();
        for (var i = 0; i < dirVals.Count; i++)
        {
            if (!double.TryParse(dirVals[i].Groups[2].Value, NumberStyles.Float,
                    CultureInfo.InvariantCulture, out var raw))
                continue;

            double? margin = null;
            if (i < margins.Count && double.TryParse(margins[i].Groups[1].Value, NumberStyles.Float,
                    CultureInfo.InvariantCulture, out var m))
                margin = m;

            metrics.Add(new ModelLeaderboardMetric
            {
                // 方向直接进符号：页面显示 ▼0.91% 就是 -0.91，前端不必再判方向
                Value = dirVals[i].Groups[1].Value == "Down" ? -raw : raw,
                Margin = margin,
            });
        }

        // 必须恰好六个。少一个就拒绝整行——不是保守，是因为 AssignMetrics 按位置对位：
        // 对方改了中间某一格的写法，解析出五个值会整体前移一位，「好评比」的数字挂到
        // 「可操控性」名下，而条目数与形状判定照样通过。那是一份看起来完全正常、
        // 实则每个字段都挂错名字的快照，会覆盖掉昨天的好数据，页面上没有任何异常可看。
        // 拒绝行会让条目数掉到 MinimumEntries 以下并抛异常，于是保留旧快照——这才是想要的。
        if (metrics.Count != MetricCount) return null;

        var (rankLow, rankHigh) = ParseRankSpread(BareNumberRegex.Matches(block), skip: 1);

        var entry = new ModelLeaderboardEntry
        {
            Rank = rank,
            RankLow = rankLow,
            RankHigh = rankHigh,
            Name = name,
            Organization = organization,
            License = license,
            Sessions = ParseSessions(block),
            OutputTokens = TokensRegex.Match(block) is { Success: true } t ? t.Groups[1].Value : null,
        };

        // 六个指标按页面出现顺序对位；页面加列或少列时只填得到的那几个，不错位
        AssignMetrics(entry, metrics);

        // 美元金额按顺序：单任务成本、输入单价、输出单价
        var dollars = DollarRegex.Matches(block);
        if (dollars.Count > 0 && TryDouble(dollars[0].Groups[1].Value, out var cost)) entry.CostPerTask = cost;
        if (dollars.Count > 1 && TryDouble(dollars[1].Groups[1].Value, out var pin)) entry.PriceInput = pin;
        if (dollars.Count > 2 && TryDouble(dollars[2].Groups[1].Value, out var pout)) entry.PriceOutput = pout;

        return entry;
    }

    /// <summary>
    /// 按分数榜的形状解析一行。列位置固定：
    /// 名次 / 名次区间 / 模型 / 分数±区间 / 票数 [/ 单价 / 上下文]。
    ///
    /// 按单元格取值而不是在整行里数「第几个匹配」：分数、票数、名次区间在整行里都是裸数字，
    /// 靠出现顺序去认，对方在某一格里多包一层 span 就会整排错位
    /// （.claude/rules/predicate-and-wiring-discipline.md 形状 1：判据要经得起等价写法）。
    /// </summary>
    private static ModelLeaderboardEntry? TryParseScoreRow(
        string block, string name, string? organization, string? license, int rank)
    {
        var cells = CellRegex.Matches(block);
        if (cells.Count < 5) return null;

        var scoreCell = cells[3].Groups[1].Value;
        var scoreMatch = ScoreRegex.Match(scoreCell);
        if (!scoreMatch.Success) return null;

        // 两个分支：对称的「±13」在 1-2 组，非对称的「+16/-16」在 3-5 组
        double score, up, down;
        if (scoreMatch.Groups[1].Success)
        {
            if (!TryDouble(scoreMatch.Groups[1].Value.Replace(",", ""), out score)) return null;
            if (!TryDouble(scoreMatch.Groups[2].Value, out up)) return null;
            down = up;
        }
        else
        {
            if (!TryDouble(scoreMatch.Groups[3].Value.Replace(",", ""), out score)) return null;
            if (!TryDouble(scoreMatch.Groups[4].Value, out up)) return null;
            if (!TryDouble(scoreMatch.Groups[5].Value, out down)) return null;
        }

        var (rankLow, rankHigh) = ParseRankSpread(BareNumberRegex.Matches(cells[1].Groups[1].Value), skip: 0);

        var entry = new ModelLeaderboardEntry
        {
            Rank = rank,
            RankLow = rankLow,
            RankHigh = rankHigh,
            Name = name,
            Organization = organization,
            License = license,
            Score = score,
            ScoreMarginUp = up,
            ScoreMarginDown = down,
            // 页面给样本不足的行打的标。不搬过来的话，3149 票的初步分和 23 万票的稳定分
            // 在我们页面上会长得一模一样。
            Preliminary = scoreCell.Contains(">Preliminary<", StringComparison.Ordinal),
        };

        var votes = PlainNumberRegex.Match(cells[4].Groups[1].Value);
        if (votes.Success && long.TryParse(votes.Groups[1].Value, NumberStyles.AllowThousands,
                CultureInfo.InvariantCulture, out var v))
            entry.Votes = v;

        // 单价与上下文只有文本类的几个榜有；图像视频榜就五列，到这里就结束了
        if (cells.Count > 5)
        {
            var dollars = DollarRegex.Matches(cells[5].Groups[1].Value);
            if (dollars.Count > 0 && TryDouble(dollars[0].Groups[1].Value, out var pin)) entry.PriceInput = pin;
            if (dollars.Count > 1 && TryDouble(dollars[1].Groups[1].Value, out var pout)) entry.PriceOutput = pout;
        }

        if (cells.Count > 6 && ContextRegex.Match(cells[6].Groups[1].Value) is { Success: true } ctx)
            entry.ContextWindow = ctx.Groups[1].Value;

        return entry;
    }

    /// <summary>
    /// 名次区间。agent 榜的三个裸数字是「名次、下界、上界」（skip=1 跳过名次），
    /// 分数榜是单独一格、只有两个数（skip=0）。
    /// </summary>
    private static (int?, int?) ParseRankSpread(MatchCollection numbers, int skip)
    {
        if (numbers.Count < skip + 2) return (null, null);
        if (!int.TryParse(numbers[skip].Groups[1].Value, out var lo)) return (null, null);
        if (!int.TryParse(numbers[skip + 1].Groups[1].Value, out var hi)) return (null, null);
        return lo <= hi ? (lo, hi) : (null, null);
    }

    /// <summary>厂商与授权，页面里是「Anthropic · Proprietary」这种一段式文本。</summary>
    private static (string?, string?) ParseOrgLicense(string block)
    {
        var m = OrgRegex.Match(block);
        if (!m.Success) return (null, null);

        // 偶尔还有第三段（托管方，如「Moonshot · Kimi K3 license · SiliconFlow」），只取前两段
        var parts = WebUtility.HtmlDecode(m.Groups[1].Value)
            .Split('·', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return (parts.Length > 0 ? parts[0] : null, parts.Length > 1 ? parts[1] : null);
    }

    private static long? ParseGroupedNumber(Regex regex, string html)
    {
        var m = regex.Match(html);
        return m.Success && long.TryParse(m.Groups[1].Value, NumberStyles.AllowThousands,
            CultureInfo.InvariantCulture, out var v) ? v : null;
    }

    /// <summary>
    /// 按页面里的出现顺序把六个指标对位到具名字段。
    ///
    /// 顺序来自 2026-09-14 的页面表头：
    /// Net Improvement / Confirmed Success / Praise vs Complaint / Steerability /
    /// Bash Recovery / Tool Hallucination。
    /// 对方调换列序时这里会错位——但那种改动同样会让任何按列名的方案失效
    /// （表头与单元格之间没有机读关联），且解析器会继续给出看似正常的数字，
    /// 所以守卫测试里钉了一行真实数据的六个值，错位会立刻变红。
    ///
    /// 数量不足的情形进不到这里：调用方已经要求恰好 <see cref="MetricCount"/> 个，
    /// 少一个就整行拒绝（见 TryParseAgentRow）。
    /// </summary>
    private static void AssignMetrics(ModelLeaderboardEntry entry, List<ModelLeaderboardMetric> metrics)
    {
        entry.NetImprovement = metrics[0];
        entry.ConfirmedSuccess = metrics[1];
        entry.PraiseVsComplaint = metrics[2];
        entry.Steerability = metrics[3];
        entry.BashRecovery = metrics[4];
        entry.ToolHallucination = metrics[5];
    }

    private static long? ParseSessions(string block)
    {
        var m = SessionsRegex.Match(block);
        return m.Success && long.TryParse(m.Groups[1].Value, NumberStyles.AllowThousands,
            CultureInfo.InvariantCulture, out var v) ? v : null;
    }

    private static bool TryDouble(string s, out double v)
        => double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v);

    /// <summary>供守卫测试断言「每行应有几个指标」的口径。</summary>
    public static int ExpectedMetricCount => MetricCount;
}
