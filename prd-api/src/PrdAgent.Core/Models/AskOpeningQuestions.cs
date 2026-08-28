using System;
using System.Text.Json;

namespace PrdAgent.Core.Models;

/// <summary>
/// 开场问题的**唯一判定源**。
///
/// 「分享链接自选」与「站点题库」两层的取舍只允许在这里发生一次。抽成 SSOT 是因为
/// 这个判断天然会被抄三份（分享页读取、站内预览读取、owner 配置面板回显），
/// 抄散了就会各自漂移——本仓库 predicate-and-wiring-discipline 形状 3 记着同类事故。
///
/// 纯函数、不碰 Mongo，可直接单测。
/// </summary>
public static class AskOpeningQuestions
{
    /// <summary>系统读正文生成的。</summary>
    public const string SourceAuto = "auto";

    /// <summary>owner 自己写的，自动生成永不覆盖。</summary>
    public const string SourceManual = "manual";

    /// <summary>
    /// 这批题到底是谁写的——**唯一**判定源。
    ///
    /// 判据本身只有一句「有题但没有 source 就是存量手写」，麻烦在于它有三个消费方：
    /// 决定要不要生成（NeedsGeneration）、读配置端点回给面板的标签、重新生成端点回的标签。
    /// 三处各写一遍的后果不是不一致那么轻——写那一侧判成 manual（不覆盖，对的），
    /// 读那一侧兜底成 auto，于是面板把 owner 精心写的题标成「系统读正文生成」，还配一句
    /// 「你改过之后就不再被自动覆盖」的解释，等于**主动劝他点重新生成**把自己那份冲掉。
    /// 保护写入却在读出时劝人自毁，比两边都不保护更糟。
    /// </summary>
    public static string ResolveSource(HostedSite site)
    {
        if (string.Equals(site.AskQuestionsSource, SourceManual, StringComparison.OrdinalIgnoreCase))
            return SourceManual;
        // AskQuestionsSource 是自动生成这个功能才引入的字段。在它之前建的站点里根本不存在，
        // 而那时候题库里的每一条都只可能是 owner 自己填的。
        if (string.IsNullOrEmpty(site.AskQuestionsSource)
            && (site.AskSuggestedQuestions?.Count ?? 0) > 0)
            return SourceManual;
        return SourceAuto;
    }

    /// <summary>面板最多展示几条（多了会把提问框挤出首屏）。这是**展示**上限，不是存储上限。</summary>
    public const int MaxDisplay = 4;

    /// <summary>
    /// 站点题库最多存几条。
    ///
    /// 必须大于 MaxDisplay：题库是**候选池**，分享时从里面挑几条，不同链接挑不同的子集——
    /// 这正是「分享时自选开场问题」这个功能的前提。拿展示上限去卡存储，题库就永远只有 4 条、
    /// 挑无可挑，而且 owner 存第 5 条时会**静默消失**（存进去了、回显没了）。
    /// </summary>
    public const int MaxLibrary = 12;

    /// <summary>单条问题最大长度（超出截断；开场问题是"一点即问"的引子，不是需求描述）</summary>
    public const int MaxLength = 60;

    /// <summary>
    /// 算出一条分享链接实际该显示的开场问题。
    ///
    /// 三态在这里收敛（与 WebPageShareLink.AskSuggestedQuestions 的注释是同一份契约）：
    ///   shareSelected == null → 该链接没表过态，继承站点题库
    ///   shareSelected == []   → 该链接明确不要开场问题，**不许**回退到站点题库
    ///   shareSelected 非空    → 只用它自己的
    ///
    /// 注意 `??` 不能写成 `shareSelected?.Count > 0 ? ... : siteLibrary`——后者会把
    /// 「选了空」误判成「没选过」，正是这个函数存在的理由。
    /// </summary>
    public static List<string> Resolve(List<string>? shareSelected, List<string>? siteLibrary)
        => Normalize(shareSelected ?? siteLibrary, MaxDisplay);

    /// <summary>
    /// 清洗一组问题：去空白、丢空串、超长截断、去重、限量。入库与出参都走它，避免两端标准不一。
    ///
    /// limit 默认是**存储上限** MaxLibrary，不是展示上限——用错会让 owner 存进去的题
    /// 悄悄消失。只有 Resolve（算面板真正显示哪几条）才传 MaxDisplay。
    /// </summary>
    public static List<string> Normalize(IEnumerable<string>? raw, int? limit = null)
    {
        var cap = limit ?? MaxLibrary;
        if (raw == null) return new List<string>();

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<string>();
        foreach (var item in raw)
        {
            var q = (item ?? string.Empty).Trim();
            if (q.Length == 0) continue;
            if (q.Length > MaxLength) q = q[..MaxLength];
            if (!seen.Add(q)) continue;
            result.Add(q);
            if (result.Count >= cap) break;
        }
        return result;
    }

    /// <summary>
    /// 自动生成时一次写几条。比 MaxDisplay 多，是因为分享链接要从中挑子集；
    /// 也比 MaxLibrary 少——一次生成就把题库塞满，owner 想自己加就加不进去了。
    /// </summary>
    public const int GeneratedCount = 5;

    /// <summary>
    /// 把模型吐出来的那坨东西解析成一组问题。
    ///
    /// 模型不会老老实实只回一个 JSON 数组：前后可能裹 ```json 围栏、可能先寒暄一句、
    /// 也可能把每条包成对象。解析必须容忍这些，但**不容忍编造**——认不出来就返回空，
    /// 由调用方据此「这一栏整块不出现」，而不是硬凑几句放到任何页面都成立的空话
    /// （no-rootless-tree）。
    ///
    /// 纯函数，可直接单测：这类「解析模型自由文本」的判据是最容易悄悄退化的一处。
    /// </summary>
    public static List<string> ParseGenerated(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return new List<string>();

        // 取最外层的 [...]：围栏、前言、结尾的「以上」都被这一刀切掉
        var start = raw.IndexOf('[');
        var end = raw.LastIndexOf(']');
        if (start < 0 || end <= start) return new List<string>();

        var slice = raw[start..(end + 1)];
        JsonElement root;
        try
        {
            root = JsonDocument.Parse(slice).RootElement;
        }
        catch (JsonException)
        {
            return new List<string>();
        }
        if (root.ValueKind != JsonValueKind.Array) return new List<string>();

        var picked = new List<string>();
        foreach (var item in root.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String)
            {
                picked.Add(item.GetString() ?? string.Empty);
                continue;
            }
            // 有的模型会自作主张包成 {"question":"..."} / {"text":"..."}；
            // 认这一层比让整批作废划算，反正下面还要过 Normalize。
            if (item.ValueKind != JsonValueKind.Object) continue;
            foreach (var prop in item.EnumerateObject())
            {
                if (prop.Value.ValueKind != JsonValueKind.String) continue;
                picked.Add(prop.Value.GetString() ?? string.Empty);
                break;
            }
        }

        return Normalize(picked, GeneratedCount);
    }
}
