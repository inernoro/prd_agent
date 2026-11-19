using System.Text;

namespace PrdAgent.Core.Services;

/// <summary>
/// 锚点插入服务：将解析后的锚点-插入指令应用到原始文章中。
/// 在原文中匹配锚点文本，并在其后插入 [插图]: ... 标记行。
/// </summary>
public static class AnchorInsertionService
{
    /// <summary>
    /// 将锚点插入指令应用到原始文章，生成带标记的文章内容。
    /// </summary>
    /// <param name="originalArticle">用户上传的原始文章内容</param>
    /// <param name="insertions">LLM 解析出的锚点-插入对列表</param>
    /// <returns>合并结果，包含带标记的文章和匹配报告</returns>
    public static AnchorMergeResult Apply(string originalArticle, List<AnchorInsertion> insertions)
    {
        if (string.IsNullOrEmpty(originalArticle) || insertions.Count == 0)
        {
            return new AnchorMergeResult
            {
                MergedContent = originalArticle ?? string.Empty,
                MatchedCount = 0,
                TotalCount = insertions.Count,
                UnmatchedAnchors = insertions.Select(i => i.AnchorText).ToList()
            };
        }

        // 找到每个锚点在原文中的位置
        var positioned = new List<(int Position, AnchorInsertion Insertion)>();
        var unmatched = new List<string>();

        foreach (var ins in insertions)
        {
            var pos = FindAnchorPosition(originalArticle, ins.AnchorText);
            if (pos >= 0)
            {
                positioned.Add((pos, ins));
            }
            else
            {
                unmatched.Add(ins.AnchorText);
            }
        }

        // 按位置从后往前排序，避免插入时偏移量累积
        positioned.Sort((a, b) => b.Position.CompareTo(a.Position));

        var sb = new StringBuilder(originalArticle);

        foreach (var (position, insertion) in positioned)
        {
            // 找到锚点所在行的末尾
            var lineEnd = FindLineEnd(sb, position);
            sb.Insert(lineEnd, $"\n\n{insertion.MarkerLine}\n");
        }

        // 对于未匹配的锚点，追加到文章末尾
        if (unmatched.Count > 0)
        {
            var unmatchedInsertions = insertions.Where(i => unmatched.Contains(i.AnchorText)).ToList();
            foreach (var ins in unmatchedInsertions)
            {
                sb.Append($"\n\n{ins.MarkerLine}");
            }
        }

        return new AnchorMergeResult
        {
            MergedContent = sb.ToString(),
            MatchedCount = positioned.Count,
            TotalCount = insertions.Count,
            UnmatchedAnchors = unmatched
        };
    }

    /// <summary>
    /// 在原文中查找锚点文本的位置。
    /// 优先精确匹配，失败则尝试归一化空白后匹配。
    /// </summary>
    private static int FindAnchorPosition(string article, string anchor)
    {
        if (string.IsNullOrWhiteSpace(anchor)) return -1;
        var index = article.IndexOf(anchor, StringComparison.Ordinal);
        if (index < 0) index = article.IndexOf(anchor, StringComparison.OrdinalIgnoreCase);
        if (index >= 0) return index + anchor.Length - 1;

        var originalOffsets = new List<int>(article.Length);
        var normalizedArticle = NormalizeWhitespace(article, originalOffsets);
        var normalizedAnchor = NormalizeWhitespace(anchor);

        index = normalizedArticle.IndexOf(normalizedAnchor, StringComparison.OrdinalIgnoreCase);
        if (index < 0)
        {
            index = NormalizePunctuation(normalizedArticle)
                .IndexOf(NormalizePunctuation(normalizedAnchor), StringComparison.OrdinalIgnoreCase);
        }
        return index < 0 ? -1 : originalOffsets[index + normalizedAnchor.Length - 1];
    }

    /// <summary>归一化空白并记录每个字符在原文中的位置</summary>
    private static string NormalizeWhitespace(string text, List<int>? originalOffsets = null)
    {
        var sb = new StringBuilder(text.Length);
        var spaceAt = -1;
        for (var i = 0; i < text.Length; i++)
        {
            if (char.IsWhiteSpace(text[i]))
            {
                if (spaceAt < 0) spaceAt = i;
                continue;
            }
            if (spaceAt >= 0 && sb.Length > 0)
            {
                sb.Append(' ');
                originalOffsets?.Add(spaceAt);
            }
            spaceAt = -1;
            sb.Append(text[i]);
            originalOffsets?.Add(i);
        }
        return sb.ToString();
    }

    /// <summary>归一化标点：中文标点转英文标点（用于容错匹配）</summary>
    private static string NormalizePunctuation(string text)
    {
        return text
            .Replace('，', ',')
            .Replace('。', '.')
            .Replace('！', '!')
            .Replace('？', '?')
            .Replace('；', ';')
            .Replace('：', ':')
            .Replace('"', '"')
            .Replace('"', '"')
            .Replace('\u2018', '\'')
            .Replace('\u2019', '\'');
    }

    /// <summary>找到从 position 开始所在行的末尾（\n 之前的位置）</summary>
    private static int FindLineEnd(StringBuilder sb, int position)
    {
        for (int i = position; i < sb.Length; i++)
        {
            if (sb[i] == '\n')
            {
                return i;
            }
        }
        return sb.Length; // 文章最后一行没有换行符
    }
}

/// <summary>
/// 锚点合并结果
/// </summary>
public class AnchorMergeResult
{
    /// <summary>合并后的完整文章内容（原文 + 插入的标记）</summary>
    public string MergedContent { get; set; } = string.Empty;

    /// <summary>成功匹配的锚点数</summary>
    public int MatchedCount { get; set; }

    /// <summary>总锚点数</summary>
    public int TotalCount { get; set; }

    /// <summary>未匹配的锚点文本列表</summary>
    public List<string> UnmatchedAnchors { get; set; } = new();
}
