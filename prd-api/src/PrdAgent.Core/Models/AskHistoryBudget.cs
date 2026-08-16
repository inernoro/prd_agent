namespace PrdAgent.Core.Models;

/// <summary>
/// 对话历史的预算闸。
///
/// 为什么必须有：分享页的提问端点是**匿名可达**的。历史由客户端提交，真实浏览器只会回传
/// 几轮短对话，但直接打端点的人可以塞 8 条几 MB 的字符串。配额闸数的是「请求次数」，
/// 拦不住「单次请求超大」——一次就能把站点主的 token 额度啃掉一大块，或反复把超大请求打给上游。
///
/// 所以问题正文限长之外，历史也必须限：**单条限长 + 总量限长 + 条数限量**，三者缺一不可。
/// 只限条数不限长度等于没限。
/// </summary>
public static class AskHistoryBudget
{
    /// <summary>带进上下文的最大条数（一问一答算两条）。</summary>
    public const int MaxMessages = 8;

    /// <summary>单条历史最大字符数。超出截断而不是整条丢弃——留个开头比什么都没有强。</summary>
    public const int MaxCharsPerMessage = 2000;

    /// <summary>历史总字符预算。从最近一条往前收，先保住离当前问题最近的上下文。</summary>
    public const int MaxTotalChars = 6000;

    /// <summary>
    /// 裁剪历史：丢空条 → 只留最近 MaxMessages 条 → 单条截断 → 从后往前累加到总预算为止。
    ///
    /// 从后往前是有意的：最近几轮才是理解当前问题所必需的，远端的历史价值低。
    /// 返回结果保持原有的时间先后顺序（调用方直接按序拼进 messages）。
    /// </summary>
    public static List<(string Role, string Content)> Trim(IEnumerable<(string? Role, string? Content)>? history)
    {
        if (history == null) return new List<(string, string)>();

        var recent = history
            .Where(h => !string.IsNullOrWhiteSpace(h.Content))
            .Select(h => (
                Role: string.Equals(h.Role, "assistant", StringComparison.OrdinalIgnoreCase) ? "assistant" : "user",
                Content: Truncate(h.Content!.Trim(), MaxCharsPerMessage)))
            .ToList();

        if (recent.Count > MaxMessages)
            recent = recent.Skip(recent.Count - MaxMessages).ToList();

        var kept = new List<(string Role, string Content)>();
        var used = 0;
        for (var i = recent.Count - 1; i >= 0; i--)
        {
            var len = recent[i].Content.Length;
            if (used + len > MaxTotalChars) break;
            used += len;
            kept.Insert(0, recent[i]);
        }
        return kept;
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
