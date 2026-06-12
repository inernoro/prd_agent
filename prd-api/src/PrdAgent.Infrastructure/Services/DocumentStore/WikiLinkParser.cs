using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.Services.DocumentStore;

/// <summary>解析到的一处 wiki 链接。</summary>
/// <param name="AnchorText">用户看到的字面（[[标题]] 或 [[标题|别名]] 中的标题部分）</param>
/// <param name="AliasText">可选别名（[[标题|别名]] 中的别名，没有则为 null）</param>
/// <param name="Position">匹配在正文中的起始偏移（用于上下文截取）</param>
/// <param name="Context">前后约 60 字符的上下文，反向链接面板展示用</param>
public record WikiLinkMatch(string AnchorText, string? AliasText, int Position, string Context);

/// <summary>
/// 解析 Markdown 正文里的 wiki 风格双链：
///   - [[标题]]            → AnchorText="标题"
///   - [[标题|别名]]       → AnchorText="标题"  AliasText="别名"
///
/// 故意不识别 [[]] 中嵌套的方括号；遇到嵌套或空字串直接跳过，保持解析的可预期性。
/// </summary>
public static class WikiLinkParser
{
    private static readonly Regex Pattern = new(
        @"\[\[([^\[\]\|\n]+?)(?:\|([^\[\]\n]+?))?\]\]",
        RegexOptions.Compiled);

    /// <summary>上下文前后取的字符数（约 60 字）</summary>
    private const int ContextRadius = 60;

    public static IReadOnlyList<WikiLinkMatch> Parse(string? content)
    {
        if (string.IsNullOrEmpty(content)) return Array.Empty<WikiLinkMatch>();

        var results = new List<WikiLinkMatch>();
        foreach (Match m in Pattern.Matches(content))
        {
            var anchorText = m.Groups[1].Value.Trim();
            if (anchorText.Length == 0) continue;

            var aliasText = m.Groups[2].Success ? m.Groups[2].Value.Trim() : null;
            if (aliasText is { Length: 0 }) aliasText = null;

            var start = Math.Max(0, m.Index - ContextRadius);
            var end = Math.Min(content.Length, m.Index + m.Length + ContextRadius);
            var context = content[start..end].Replace("\r", "").Replace("\n", " ").Trim();

            results.Add(new WikiLinkMatch(anchorText, aliasText, m.Index, context));
        }
        return results;
    }
}
