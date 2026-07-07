using System.Text;
using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.Services.DocumentStore;

/// <summary>
/// 自动补链：在 Markdown 正文中查找「其他文档的标题」的字面出现，
/// 把每个标题的第一处合法出现改写为 [[标题]]（Obsidian 风格双链）。
///
/// 设计约束（与 WikiLinkParser 配套）：
/// - 纯函数、无 IO，可单测；调用方负责准备候选标题（剔除自身标题）与写回正文。
/// - 保护区间内不改写：既有 [[..]]、fenced 代码块、行内代码、markdown 链接/图片、
///   裸 URL、autolink、文首 YAML frontmatter。
/// - 幂等：标题已以 [[标题]] 或 [[标题|别名]] 形式存在于正文任意处 → 该标题整篇跳过。
/// - 长标题优先：先匹配长标题，短标题不能抢占长标题内部的文字。
/// </summary>
public static class WikiLinkAutoLinker
{
    /// <param name="Content">改写后的正文（无改动时与输入相同）</param>
    /// <param name="LinksAdded">新增的 [[..]] 数量</param>
    /// <param name="LinkedTitles">被链接的标题列表</param>
    public record Result(string Content, int LinksAdded, IReadOnlyList<string> LinkedTitles);

    /// <summary>与 WikiLinkParser 同款 pattern，但整段（含括号）用于保护区间。</summary>
    private static readonly Regex WikiLinkPattern = new(
        @"\[\[([^\[\]\|\n]+?)(?:\|([^\[\]\n]+?))?\]\]",
        RegexOptions.Compiled);

    /// <summary>fenced 代码块 ``` 或 ~~~（未闭合时保护到文末，由匹配逻辑单独处理）</summary>
    private static readonly Regex FencedCodePattern = new(
        @"^(`{3,}|~{3,})[^\n]*\n.*?^\1`*[^\n]*$",
        RegexOptions.Compiled | RegexOptions.Singleline | RegexOptions.Multiline);

    /// <summary>行内代码 `...`（不跨行）</summary>
    private static readonly Regex InlineCodePattern = new(
        @"`[^`\n]+`",
        RegexOptions.Compiled);

    /// <summary>markdown 链接/图片整段 [text](url) / ![alt](url)</summary>
    private static readonly Regex MarkdownLinkPattern = new(
        @"!?\[[^\[\]\n]*\]\([^()\n]*\)",
        RegexOptions.Compiled);

    /// <summary>裸 URL</summary>
    private static readonly Regex BareUrlPattern = new(
        @"https?://[^\s<>""')\]]+",
        RegexOptions.Compiled);

    /// <summary>autolink：&lt;https://..&gt; 等尖括号包裹段</summary>
    private static readonly Regex AutolinkPattern = new(
        @"<[^<>\s]+>",
        RegexOptions.Compiled);

    /// <summary>文首 YAML frontmatter</summary>
    private static readonly Regex FrontmatterPattern = new(
        @"\A---\r?\n.*?^---\s*$",
        RegexOptions.Compiled | RegexOptions.Singleline | RegexOptions.Multiline);

    public static Result LinkTitles(string? content, IReadOnlyList<string> candidateTitles)
    {
        if (string.IsNullOrEmpty(content) || candidateTitles.Count == 0)
            return new Result(content ?? string.Empty, 0, Array.Empty<string>());

        // 1) 候选过滤：Trim ≥2 字符、剔纯数字、剔正则无法表达的字符（[ ] | 换行）、去重
        var titles = candidateTitles
            .Select(t => t?.Trim() ?? string.Empty)
            .Where(t => t.Length >= 2)
            .Where(t => !t.All(char.IsDigit))
            .Where(t => t.IndexOfAny(new[] { '[', ']', '|', '\n', '\r' }) < 0)
            .Distinct(StringComparer.Ordinal)
            .OrderByDescending(t => t.Length)
            .ThenBy(t => t, StringComparer.Ordinal)
            .ToList();
        if (titles.Count == 0)
            return new Result(content, 0, Array.Empty<string>());

        // 2) 收集保护区间（已排序合并）
        var protectedRanges = CollectProtectedRanges(content);

        // 3) 幂等：已有 [[标题]] / [[标题|..]] anchor 的标题整篇跳过
        var alreadyLinked = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match m in WikiLinkPattern.Matches(content))
        {
            var anchor = m.Groups[1].Value.Trim();
            if (anchor.Length > 0) alreadyLinked.Add(anchor);
        }

        // 4) 长标题优先逐个找第一处合法出现；claim 区间防止短标题嵌进长标题的改写区
        var claims = new List<(int Start, int Length, string Title)>();
        foreach (var title in titles)
        {
            if (alreadyLinked.Contains(title)) continue;

            var searchFrom = 0;
            while (searchFrom < content.Length)
            {
                var idx = content.IndexOf(title, searchFrom, StringComparison.Ordinal);
                if (idx < 0) break;

                var end = idx + title.Length;
                var blocked = Overlaps(protectedRanges, idx, end)
                    || claims.Any(c => idx < c.Start + c.Length && c.Start < end)
                    || !HasWordBoundary(content, title, idx);
                if (!blocked)
                {
                    claims.Add((idx, title.Length, title));
                    break; // 每篇每标题只链首次出现
                }
                searchFrom = idx + 1;
            }
        }

        if (claims.Count == 0)
            return new Result(content, 0, Array.Empty<string>());

        // 5) 按 start 倒序应用替换，避免偏移失效
        var sb = new StringBuilder(content);
        foreach (var (start, length, _) in claims.OrderByDescending(c => c.Start))
        {
            sb.Insert(start + length, "]]");
            sb.Insert(start, "[[");
        }

        var linkedTitles = claims.OrderBy(c => c.Start).Select(c => c.Title).ToList();
        return new Result(sb.ToString(), claims.Count, linkedTitles);
    }

    /// <summary>纯 ASCII 字母数字标题要求两侧非字母数字（防 API 匹配进 APIs / MAPI）；含 CJK 等其他字符不做边界。</summary>
    private static bool HasWordBoundary(string content, string title, int idx)
    {
        if (!title.All(ch => ch < 128 && char.IsLetterOrDigit(ch))) return true;
        var before = idx - 1;
        if (before >= 0 && char.IsLetterOrDigit(content[before]) && content[before] < 128) return false;
        var after = idx + title.Length;
        if (after < content.Length && char.IsLetterOrDigit(content[after]) && content[after] < 128) return false;
        return true;
    }

    private static bool Overlaps(List<(int Start, int End)> ranges, int start, int end)
    {
        // ranges 已按 Start 排序；线性即可（每篇正文只算一次，量级小）
        foreach (var (rs, re) in ranges)
        {
            if (rs >= end) break;
            if (start < re && rs < end) return true;
        }
        return false;
    }

    private static List<(int Start, int End)> CollectProtectedRanges(string content)
    {
        var ranges = new List<(int Start, int End)>();

        void AddMatches(Regex re)
        {
            foreach (Match m in re.Matches(content))
                ranges.Add((m.Index, m.Index + m.Length));
        }

        // frontmatter 只认文首
        var fm = FrontmatterPattern.Match(content);
        if (fm.Success) ranges.Add((0, fm.Length));

        // fenced 代码块（含未闭合 → 保护到文末）
        var lastFenceEnd = 0;
        foreach (Match m in FencedCodePattern.Matches(content))
        {
            ranges.Add((m.Index, m.Index + m.Length));
            lastFenceEnd = Math.Max(lastFenceEnd, m.Index + m.Length);
        }
        var openFence = FindUnclosedFence(content, lastFenceEnd);
        if (openFence >= 0) ranges.Add((openFence, content.Length));

        AddMatches(WikiLinkPattern);
        AddMatches(InlineCodePattern);
        AddMatches(MarkdownLinkPattern);
        AddMatches(BareUrlPattern);
        AddMatches(AutolinkPattern);

        return ranges.OrderBy(r => r.Start).ToList();
    }

    /// <summary>
    /// 在 from 之后查找未闭合的 fence 开头（``` 或 ~~~ 起行）；找到返回其起始偏移，否则 -1。
    /// FencedCodePattern 已消费所有闭合块，此处扫到的第一个 fence 起行必然未闭合。
    /// </summary>
    private static int FindUnclosedFence(string content, int from)
    {
        // 对齐到行首
        var pos = from;
        if (pos > 0 && pos < content.Length && content[pos - 1] != '\n')
        {
            var nl = content.IndexOf('\n', pos);
            if (nl < 0) return -1;
            pos = nl + 1;
        }
        while (pos < content.Length)
        {
            var ch = content[pos];
            if (ch == '`' || ch == '~')
            {
                var run = 0;
                while (pos + run < content.Length && content[pos + run] == ch) run++;
                if (run >= 3) return pos;
            }
            var next = content.IndexOf('\n', pos);
            if (next < 0) break;
            pos = next + 1;
        }
        return -1;
    }
}
