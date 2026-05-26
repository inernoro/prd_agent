using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.Services.ProjectRouteAgent;

/// <summary>
/// 确定性 Markdown 章节抽取器：从方案 md 文档里找指定关键词章节，
/// 把章节下的列表项 / 段落原话直接抽出来（不让 AI 自由发挥 / 拆解）。
///
/// 工作流：
///   1. 找标题行（^#+\s+xxx$），命中关键词（contains）即为目标 section
///   2. 从该标题行下方开始收集，直到遇到下一个同级或更高级标题
///   3. 收集规则：
///      - 列表项 `- foo` / `* foo` / `+ foo` / `1. foo` → "foo"
///      - 纯文本段落 → 按行拆分（跳过空行 / 引用前缀）
///   4. 文本归一化：去前后空格、去 inline code 反引号、去末尾标点
///   5. 去重（保持原顺序）
///
/// 关键词命中是大小写不敏感的子串匹配，按列表顺序优先（先列的标题如果同时命中以它为准）。
/// </summary>
public static class MarkdownSectionExtractor
{
    /// <summary>「应用」章节关键词（按优先级从精确到宽泛）</summary>
    public static readonly IReadOnlyList<string> AppsKeywords = new[]
    {
        "涉及应用", "相关应用", "应用范围", "应用清单", "应用列表", "应用",
    };

    /// <summary>「业务模块」章节关键词</summary>
    public static readonly IReadOnlyList<string> ModulesKeywords = new[]
    {
        "业务模块", "涉及模块", "相关模块", "功能模块", "模块清单", "模块列表", "模块",
    };

    /// <summary>
    /// 从方案 markdown 抽出（apps, modules）原文清单。
    /// 找不到对应章节时返回的列表为空，调用方可决定是否回退到 LLM 抽取。
    /// </summary>
    public static (List<string> Apps, List<string> Modules) Extract(string? markdown)
    {
        if (string.IsNullOrWhiteSpace(markdown))
            return (new List<string>(), new List<string>());

        var apps = ExtractSection(markdown!, AppsKeywords);
        var modules = ExtractSection(markdown!, ModulesKeywords);
        return (apps, modules);
    }

    /// <summary>对外暴露：根据关键词清单抽一个 section 的原话列表。</summary>
    public static List<string> ExtractSection(string markdown, IReadOnlyList<string> keywords)
    {
        var lines = markdown.Split('\n');
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        int? sectionStart = null;
        int sectionLevel = 0;

        // 1) 找命中关键词的最浅 / 最早标题
        for (var i = 0; i < lines.Length; i++)
        {
            var headerMatch = HeadingRegex.Match(lines[i]);
            if (!headerMatch.Success) continue;
            var level = headerMatch.Groups[1].Value.Length;
            var title = headerMatch.Groups[2].Value.Trim();
            // 去掉行尾的 markdown 锚点 / 链接修饰
            title = StripHeadingDecoration(title);

            if (MatchesAnyKeyword(title, keywords))
            {
                sectionStart = i + 1;
                sectionLevel = level;
                break; // 用第一次命中
            }
        }

        if (sectionStart == null) return result;

        // 2) 收集到下一个同级或更高级标题之前
        for (var i = sectionStart.Value; i < lines.Length; i++)
        {
            var headerMatch = HeadingRegex.Match(lines[i]);
            if (headerMatch.Success)
            {
                var level = headerMatch.Groups[1].Value.Length;
                if (level <= sectionLevel) break;
                // 子标题（更深层）不视为分隔符，但本身也跳过不当作内容
                continue;
            }

            var raw = lines[i].TrimEnd('\r');
            if (string.IsNullOrWhiteSpace(raw)) continue;

            // 跳过引用块 / 水平线 / 代码块边界
            if (raw.TrimStart().StartsWith(">")) continue;
            if (raw.Trim() == "---" || raw.Trim() == "***" || raw.Trim() == "___") continue;
            if (raw.TrimStart().StartsWith("```")) continue;

            // 列表项
            var listMatch = ListItemRegex.Match(raw);
            string item;
            if (listMatch.Success)
            {
                item = listMatch.Groups[1].Value;
            }
            else
            {
                // 纯文本段落 —— 按行收（不二次拆分，方案 md 里这种情况罕见）
                item = raw.Trim();
            }

            item = Cleanup(item);
            if (item.Length == 0) continue;
            if (seen.Add(item)) result.Add(item);
        }

        return result;
    }

    private static bool MatchesAnyKeyword(string title, IReadOnlyList<string> keywords)
    {
        foreach (var kw in keywords)
        {
            if (title.Contains(kw, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string StripHeadingDecoration(string title)
    {
        // 去尾巴的 `{#anchor}` 或 `[link]()` 附加
        title = AnchorTagRegex.Replace(title, string.Empty);
        title = title.Trim();
        // 中文标题里有时会有 `:` 后缀（"应用："），剥掉
        title = title.TrimEnd('：', ':', '|', '·');
        return title.Trim();
    }

    private static string Cleanup(string item)
    {
        // 去 inline code 反引号、首尾标点、最后括号备注内容（保留原文意图）
        item = item.Trim().Trim('`').Trim();
        // 去末尾标点（中英文都剥）
        item = item.TrimEnd('。', '，', ',', '.', ';', '；');
        return item.Trim();
    }

    // ^# / ## / ###... 直到 ###### + 空格 + 标题文本
    private static readonly Regex HeadingRegex = new(@"^(#{1,6})\s+(.+?)\s*$", RegexOptions.Compiled);

    // 匹配列表项：`- foo` / `* foo` / `+ foo` / `1. foo` / `1) foo`
    private static readonly Regex ListItemRegex = new(@"^\s*(?:[-*+]|\d+[\.\)])\s+(.+?)\s*$", RegexOptions.Compiled);

    // 匹配 markdown 标题里附加的 `{#anchor}` 锚点
    private static readonly Regex AnchorTagRegex = new(@"\s*\{#[^}]+\}\s*$", RegexOptions.Compiled);
}
