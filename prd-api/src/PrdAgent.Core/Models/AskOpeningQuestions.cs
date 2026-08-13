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
}
