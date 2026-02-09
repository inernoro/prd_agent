using System.Text.RegularExpressions;

namespace PrdAgent.Core.Services;

/// <summary>
/// 解析 LLM 输出的锚点插入指令格式：
/// @AFTER 原文中的一句话
/// [插图]: 配图提示词描述
/// </summary>
public static class AnchorInsertionParser
{
    private static readonly Regex AfterLineRegex = new(@"^@AFTER\s+(.+)$", RegexOptions.Compiled);
    private static readonly Regex MarkerLineRegex = new(@"^\[插图\]\s*:\s*(.+)$", RegexOptions.Compiled);

    /// <summary>
    /// 从 LLM 完整输出中解析所有锚点-插入对
    /// </summary>
    public static List<AnchorInsertion> Parse(string llmOutput)
    {
        var result = new List<AnchorInsertion>();
        if (string.IsNullOrWhiteSpace(llmOutput)) return result;

        var lines = llmOutput.Split('\n');
        string? pendingAnchor = null;

        foreach (var rawLine in lines)
        {
            var line = rawLine.TrimEnd('\r');

            var afterMatch = AfterLineRegex.Match(line);
            if (afterMatch.Success)
            {
                pendingAnchor = afterMatch.Groups[1].Value.Trim();
                continue;
            }

            if (pendingAnchor != null)
            {
                var markerMatch = MarkerLineRegex.Match(line);
                if (markerMatch.Success)
                {
                    var promptText = markerMatch.Groups[1].Value.Trim();
                    if (promptText.Length > 0)
                    {
                        result.Add(new AnchorInsertion
                        {
                            Index = result.Count,
                            AnchorText = pendingAnchor,
                            MarkerText = promptText,
                            MarkerLine = $"[插图]: {promptText}"
                        });
                    }
                    pendingAnchor = null;
                    continue;
                }

                // 非空行但不是 [插图] 格式 → 放弃当前锚点
                if (!string.IsNullOrWhiteSpace(line))
                {
                    pendingAnchor = null;
                }
            }
        }

        return result;
    }

    /// <summary>
    /// 增量解析：从新追加的行中尝试提取锚点-插入对。
    /// 用于流式处理场景，调用者维护 pendingAnchor 状态。
    /// </summary>
    public static AnchorInsertion? TryParseLine(string line, ref string? pendingAnchor, int nextIndex)
    {
        var trimmed = line.TrimEnd('\r');

        var afterMatch = AfterLineRegex.Match(trimmed);
        if (afterMatch.Success)
        {
            pendingAnchor = afterMatch.Groups[1].Value.Trim();
            return null;
        }

        if (pendingAnchor != null)
        {
            var markerMatch = MarkerLineRegex.Match(trimmed);
            if (markerMatch.Success)
            {
                var promptText = markerMatch.Groups[1].Value.Trim();
                if (promptText.Length > 0)
                {
                    var result = new AnchorInsertion
                    {
                        Index = nextIndex,
                        AnchorText = pendingAnchor,
                        MarkerText = promptText,
                        MarkerLine = $"[插图]: {promptText}"
                    };
                    pendingAnchor = null;
                    return result;
                }
            }

            if (!string.IsNullOrWhiteSpace(trimmed))
            {
                pendingAnchor = null;
            }
        }

        return null;
    }
}

/// <summary>
/// 锚点插入指令数据模型
/// </summary>
public class AnchorInsertion
{
    /// <summary>顺序索引</summary>
    public int Index { get; set; }

    /// <summary>锚点文本（原文中的片段，用于定位插入位置）</summary>
    public string AnchorText { get; set; } = string.Empty;

    /// <summary>配图提示词描述文本</summary>
    public string MarkerText { get; set; } = string.Empty;

    /// <summary>完整的标记行 [插图]: ...</summary>
    public string MarkerLine { get; set; } = string.Empty;
}
