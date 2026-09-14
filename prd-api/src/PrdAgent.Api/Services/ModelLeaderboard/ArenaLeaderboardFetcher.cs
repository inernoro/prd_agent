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

    private readonly HttpClient _http;

    public ArenaLeaderboardFetcher(HttpClient http)
    {
        _http = http;
    }

    /// <summary>拼出某个分榜的地址。</summary>
    public static string BuildUrl(string board) => $"{BaseUrl}/{board}";

    /// <summary>解析结果：条目 + 页面级元信息。</summary>
    public record ParseResult(List<ModelLeaderboardEntry> Entries, long? TotalSessions);

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

        return result;
    }

    /// <summary>
    /// 从页面 HTML 解析条目。抽成公开静态方法，测试可以直接喂一段存档 HTML 断言解析结果，
    /// 不必联网。
    /// </summary>
    public static ParseResult Parse(string html)
    {
        var entries = new List<ModelLeaderboardEntry>();

        foreach (Match row in RowRegex.Matches(html))
        {
            var block = row.Groups[1].Value;

            var nameMatch = NameRegex.Match(block);
            if (!nameMatch.Success) continue;

            // 指标：方向决定符号，误差按出现顺序一一对应
            var dirVals = DirectionValueRegex.Matches(block);
            if (dirVals.Count == 0) continue;   // 表头行与筛选行就是这么被跳过的

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

            if (metrics.Count == 0) continue;

            string? organization = null;
            string? license = null;
            var orgMatch = OrgRegex.Match(block);
            if (orgMatch.Success)
            {
                // 「Anthropic · Proprietary」，偶尔还有第三段（托管方），只取前两段
                var parts = WebUtility.HtmlDecode(orgMatch.Groups[1].Value)
                    .Split('·', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                if (parts.Length > 0) organization = parts[0];
                if (parts.Length > 1) license = parts[1];
            }

            // 行首三个裸数字：名次、区间下界、上界
            var bare = BareNumberRegex.Matches(block);
            int? rankLow = null, rankHigh = null;
            if (bare.Count >= 3
                && int.TryParse(bare[1].Groups[1].Value, out var lo)
                && int.TryParse(bare[2].Groups[1].Value, out var hi)
                && lo <= hi)
            {
                rankLow = lo;
                rankHigh = hi;
            }

            var entry = new ModelLeaderboardEntry
            {
                Rank = entries.Count + 1,
                RankLow = rankLow,
                RankHigh = rankHigh,
                Name = WebUtility.HtmlDecode(nameMatch.Groups[1].Value),
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

            entries.Add(entry);
        }

        long? totalSessions = null;
        var totalMatch = TotalSessionsRegex.Match(html);
        if (totalMatch.Success
            && long.TryParse(totalMatch.Groups[1].Value, NumberStyles.AllowThousands,
                CultureInfo.InvariantCulture, out var total))
            totalSessions = total;

        return new ParseResult(entries, totalSessions);
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
    /// </summary>
    private static void AssignMetrics(ModelLeaderboardEntry entry, List<ModelLeaderboardMetric> metrics)
    {
        if (metrics.Count > 0) entry.NetImprovement = metrics[0];
        if (metrics.Count > 1) entry.ConfirmedSuccess = metrics[1];
        if (metrics.Count > 2) entry.PraiseVsComplaint = metrics[2];
        if (metrics.Count > 3) entry.Steerability = metrics[3];
        if (metrics.Count > 4) entry.BashRecovery = metrics[4];
        if (metrics.Count > 5) entry.ToolHallucination = metrics[5];
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
