using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services.DocumentStore;

/// <summary>
/// 划词评论重锚定（rebinding）算法 — 纯函数版本，供单元测试使用。
///
/// 使用场景：文档正文被编辑后，需要判断原本锚定在某段文字上的评论能否找到新位置。
///
/// 算法（按成本递增）：
///   1) SelectedText 在新正文中唯一出现 → 直接返回该位置
///   2) 多处出现 → 用 ContextBefore/ContextAfter 做字符级打分消歧，取最高分
///   3) 零出现 → 返回 null（调用方将评论标记为 orphaned）
/// </summary>
public static class InlineCommentRebinder
{
    public record RebindResult(int StartOffset, int EndOffset, string ContextBefore, string ContextAfter);

    /// <summary>
    /// 尝试在 newContent 中重锚定一条评论。
    /// </summary>
    /// <param name="newContent">新版本的正文（通常是 ParsedPrd.RawContent）</param>
    /// <param name="selectedText">被评论的原文片段</param>
    /// <param name="origContextBefore">原评论创建时的前上下文（约 50 字）</param>
    /// <param name="origContextAfter">原评论创建时的后上下文（约 50 字）</param>
    /// <param name="contextWindow">上下文窗口大小（字符数），默认 50</param>
    /// <returns>命中时返回新位置；无法定位时返回 null</returns>
    public static RebindResult? TryRebind(
        string newContent,
        string selectedText,
        string origContextBefore,
        string origContextAfter,
        int contextWindow = 50)
    {
        if (string.IsNullOrEmpty(selectedText) || string.IsNullOrEmpty(newContent)) return null;

        // Step 1: 收集所有出现位置
        var positions = FindAllPositions(newContent, selectedText);
        if (positions.Count == 0) return null;

        // Step 2: 唯一命中直接返回
        int chosenStart;
        if (positions.Count == 1)
        {
            chosenStart = positions[0];
        }
        else
        {
            // Step 3: 多处命中 → 用 context 打分消歧
            chosenStart = ChooseBestPositionByContext(
                newContent, positions, selectedText, origContextBefore, origContextAfter, contextWindow);
        }

        var chosenEnd = chosenStart + selectedText.Length;
        var newContextBefore = SliceAround(newContent, chosenStart, -contextWindow);
        var newContextAfter = SliceAround(newContent, chosenEnd, contextWindow);
        return new RebindResult(chosenStart, chosenEnd, newContextBefore, newContextAfter);
    }

    /// <summary>
    /// 收集 selectedText 在 content 中的所有起始位置（允许重叠；但通常评论片段足够长不会重叠）。
    /// </summary>
    public static List<int> FindAllPositions(string content, string selectedText)
    {
        var positions = new List<int>();
        if (string.IsNullOrEmpty(content) || string.IsNullOrEmpty(selectedText)) return positions;
        int idx = 0;
        while ((idx = content.IndexOf(selectedText, idx, StringComparison.Ordinal)) >= 0)
        {
            positions.Add(idx);
            idx += 1;
        }
        return positions;
    }

    /// <summary>
    /// 多处命中时的消歧：对每个候选位置提取前后 contextWindow 个字符，与原 context 做"相同字符数"打分。
    /// </summary>
    public static int ChooseBestPositionByContext(
        string content,
        List<int> positions,
        string selectedText,
        string origBefore,
        string origAfter,
        int contextWindow = 50)
    {
        int bestPos = positions[0];
        int bestScore = -1;
        foreach (var pos in positions)
        {
            var before = SliceAround(content, pos, -contextWindow);
            var after = SliceAround(content, pos + selectedText.Length, contextWindow);
            int score = CountMatchingChars(before, origBefore) + CountMatchingChars(after, origAfter);
            if (score > bestScore)
            {
                bestScore = score;
                bestPos = pos;
            }
        }
        return bestPos;
    }

    /// <summary>
    /// 取 pos 附近 length 个字符（length 为负表示往前取，正表示往后取）。
    /// 越界时会自动 clamp 到字符串边界。
    /// </summary>
    public static string SliceAround(string content, int pos, int length)
    {
        if (content == null) return string.Empty;
        if (length < 0)
        {
            int start = Math.Max(0, pos + length);
            int safePos = Math.Min(content.Length, Math.Max(0, pos));
            return content.Substring(start, safePos - start);
        }
        else
        {
            int safePos = Math.Min(content.Length, Math.Max(0, pos));
            int end = Math.Min(content.Length, safePos + length);
            return content.Substring(safePos, end - safePos);
        }
    }

    /// <summary>
    /// 简单比较：两个字符串相同位置字符一致的个数。用于 rebind 时的上下文打分。
    /// </summary>
    public static int CountMatchingChars(string a, string b)
    {
        if (a == null || b == null) return 0;
        int n = Math.Min(a.Length, b.Length);
        int match = 0;
        for (int i = 0; i < n; i++)
        {
            if (a[i] == b[i]) match++;
        }
        return match;
    }
}

/// <summary>
/// 重锚定最终状态（由调用方根据 TryRebind 结果决定）。
/// </summary>
public static class InlineCommentRebinderStatus
{
    public const string Active = DocumentInlineCommentStatus.Active;
    public const string Orphaned = DocumentInlineCommentStatus.Orphaned;
}
