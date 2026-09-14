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
/// 分数取自 <c>aria-label="Net improvement 13.85%"</c>，模型名取自 <c>title="..."</c>。
/// 这两个是给读屏软件用的无障碍属性，比 Tailwind 那串 <c>text-text-secondary truncate text-xs</c>
/// 稳得多——后者是构建产物，换个主题或升级一次依赖就会变。
/// 名次直接用条目在页面里的顺序（页面已排好序），不去解析名次单元格：
/// 那一格里既有数字也有升降箭头 SVG，解析它只会更脆。
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
    /// 取 5 是因为：agent 榜实测 43 行、text 榜数百行，正常情况远超这个数；
    /// 而页面改版导致解析失效时拿到的是 0 到 1 行。5 足够把「改版」和「榜单真的很短」分开，
    /// 又不会因为某个冷门分榜只有十来个模型就误判。
    /// </summary>
    public const int MinimumEntries = 5;

    /// <summary>按 tr 切行。页面是标准表格，每个模型一行。</summary>
    private static readonly Regex RowRegex = new(
        @"<tr[^>]*>(.*?)</tr>", RegexOptions.Singleline | RegexOptions.Compiled);

    /// <summary>模型名。title 属性上的是完整名，标签文本会被 truncate 截断，所以取属性。</summary>
    private static readonly Regex NameRegex = new(
        @"title=""([^""]+)""", RegexOptions.Compiled);

    /// <summary>主分数。无障碍标签，比 class 稳。</summary>
    private static readonly Regex ScoreRegex = new(
        @"aria-label=""Net improvement (-?[\d.]+)%""", RegexOptions.Compiled);

    /// <summary>
    /// ± 误差范围。
    ///
    /// 同时认字面 ± 和 HTML 实体 &amp;plusmn;：抓到的那一版页面用的是字面字符，但这是
    /// 别人家的页面，同一个符号换种写法是随时可能发生的事，而判据一窄就会静默漏掉误差范围。
    /// </summary>
    private static readonly Regex MarginRegex = new(
        @"(?:±|&plusmn;)\s*([\d.]+)%", RegexOptions.Compiled);

    /// <summary>厂商与授权，页面里是「Anthropic · Proprietary」这种一段式文本。</summary>
    private static readonly Regex OrgRegex = new(
        @"text-text-secondary truncate text-xs"">([^<]+)<", RegexOptions.Compiled);

    private readonly HttpClient _http;

    public ArenaLeaderboardFetcher(HttpClient http)
    {
        _http = http;
    }

    /// <summary>拼出某个分榜的地址。</summary>
    public static string BuildUrl(string board) => $"{BaseUrl}/{board}";

    /// <summary>
    /// 抓取并解析一个分榜。
    /// </summary>
    /// <exception cref="InvalidOperationException">解析到的条目少于 <see cref="MinimumEntries"/>，视为页面改版。</exception>
    public async Task<List<ModelLeaderboardEntry>> FetchAsync(string board, CancellationToken ct)
    {
        var url = BuildUrl(board);
        using var response = await _http.GetAsync(url, ct);
        response.EnsureSuccessStatusCode();
        var html = await response.Content.ReadAsStringAsync(ct);

        var entries = Parse(html);
        if (entries.Count < MinimumEntries)
        {
            throw new InvalidOperationException(
                $"解析 {url} 只得到 {entries.Count} 个条目（下限 {MinimumEntries}），" +
                "多半是页面结构变了；本次不写库，保留上一份快照。");
        }

        return entries;
    }

    /// <summary>
    /// 从页面 HTML 解析条目。抽成公开静态方法，测试可以直接喂一段存档 HTML 断言解析结果，
    /// 不必联网。
    /// </summary>
    public static List<ModelLeaderboardEntry> Parse(string html)
    {
        var entries = new List<ModelLeaderboardEntry>();

        foreach (Match row in RowRegex.Matches(html))
        {
            var block = row.Groups[1].Value;

            var nameMatch = NameRegex.Match(block);
            var scoreMatch = ScoreRegex.Match(block);
            // 两者缺一即不是模型行（表头行就是这么被跳过的）
            if (!nameMatch.Success || !scoreMatch.Success) continue;

            if (!double.TryParse(scoreMatch.Groups[1].Value, NumberStyles.Float,
                    CultureInfo.InvariantCulture, out var score))
                continue;

            double? margin = null;
            var marginMatch = MarginRegex.Match(block);
            if (marginMatch.Success && double.TryParse(marginMatch.Groups[1].Value, NumberStyles.Float,
                    CultureInfo.InvariantCulture, out var parsedMargin))
                margin = parsedMargin;

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

            entries.Add(new ModelLeaderboardEntry
            {
                Rank = entries.Count + 1,
                Name = WebUtility.HtmlDecode(nameMatch.Groups[1].Value),
                Organization = organization,
                License = license,
                Score = score,
                Margin = margin,
            });
        }

        return entries;
    }
}
