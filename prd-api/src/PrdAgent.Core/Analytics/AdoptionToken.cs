namespace PrdAgent.Core.Analytics;

/// <summary>
/// 周报能力条目上的「用量口径」标签。
///
/// 它存在的理由：周报说「本周上线了 X」，而「X 有没有人用」的答案在产品里。
/// 两边之间必须有一个机器可读的连接键，否则只能靠人肉猜，猜出来的采用率没人敢信。
/// 语法刻意做成人也读得懂的一行（<c>llm:visual-agent</c>），而不是隐藏注释——
/// 不可见的标签一旦漂移没人会发现。
/// </summary>
public sealed record AdoptionToken(string Raw, string Kind, string Key)
{
    /// <summary>允许的四种前缀。含义互不重叠，缺一种就会有能力无处安放。</summary>
    public static readonly IReadOnlyList<string> KnownKinds = new[] { "llm", "route", "dim", "none" };

    /// <summary>dim: 允许的维度 key —— 每个都对应一条真实可数的业务集合。</summary>
    public static readonly IReadOnlySet<string> KnownDimensions =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { "docs", "sites", "reports", "image-gen", "workflows", "defects" };

    /// <summary>
    /// none: 允许的三个原因。限枚举是为了让「没有用量信号」这件事本身可被统计——
    /// 自由文本会让平台类工作在采用率报告里静默消失。
    /// </summary>
    public static readonly IReadOnlySet<string> KnownNoSignalReasons =
        new HashSet<string>(StringComparer.Ordinal)
        { "平台能力", "研发流程", "基础设施" };

    /// <summary>
    /// 解析逗号分隔的 token 串。无法识别前缀的原样保留（Kind 置为原前缀），
    /// 由调用方报 unknown-key —— 静默丢弃会让写错的标签变成「查无此项」。
    /// </summary>
    public static List<AdoptionToken> ParseList(string? raw)
    {
        var result = new List<AdoptionToken>();
        if (string.IsNullOrWhiteSpace(raw)) return result;
        foreach (var piece in raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var text = piece.Trim().Trim('`');
            if (text.Length == 0) continue;
            var idx = text.IndexOf(':');
            if (idx <= 0 || idx == text.Length - 1)
            {
                result.Add(new AdoptionToken(text, "malformed", text));
                continue;
            }
            result.Add(new AdoptionToken(text, text[..idx].ToLowerInvariant(), text[(idx + 1)..]));
        }
        return result;
    }
}

/// <summary>单条能力的采用度判定结果。</summary>
/// <param name="Status">
/// measured = 有用量；zero = 口径合法但本窗为 0；no-signal = 作者声明本就没有信号；
/// unknown-key = 标签写错了；not-collected = 该信号源在本窗还没开始采集，报 0 会是撒谎。
/// </param>
public sealed record AdoptionResult(
    string Token, string Kind, string Key, string Status,
    int? Value, int? Users, string Note);
