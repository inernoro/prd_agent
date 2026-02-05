using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 多图 Prompt 转换器（纯函数，无副作用，方便单元测试）
///
/// 将用户原始输入中的 @imgN 引用转换为模型可理解的格式。
///
/// 示例：
///   输入: "让@img12打@img9"
///   输出: "让图1打图2"  (按出现顺序)
/// </summary>
public static class MultiImagePromptTransformer
{
    /// <summary>
    /// 匹配 @imgN 格式（N 为 1-6 位数字）
    /// </summary>
    private static readonly Regex ImageRefPattern = new(@"@img(\d{1,6})", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>
    /// 将用户原始输入转换为发送给大模型的 prompt
    /// </summary>
    /// <param name="userInput">用户原始输入，可能包含 @imgN 引用</param>
    /// <param name="refIdToOrder">图片引用的顺序映射：refId -> 出现顺序(从1开始)</param>
    /// <returns>转换后的 prompt</returns>
    /// <example>
    /// var mapping = new Dictionary&lt;int, int&gt; { { 12, 1 }, { 9, 2 } };
    /// var result = Transform("让@img12打@img9", mapping);
    /// // result = "让图1打图2"
    /// </example>
    public static string Transform(string userInput, IReadOnlyDictionary<int, int> refIdToOrder)
    {
        if (string.IsNullOrWhiteSpace(userInput))
        {
            return userInput ?? string.Empty;
        }

        if (refIdToOrder == null || refIdToOrder.Count == 0)
        {
            return userInput;
        }

        return ImageRefPattern.Replace(userInput, match =>
        {
            if (int.TryParse(match.Groups[1].Value, out var refId) && refIdToOrder.TryGetValue(refId, out var order))
            {
                return $"图{order}";
            }
            return match.Value; // 未找到的引用保持原样
        });
    }

    /// <summary>
    /// 从用户输入中提取 @imgN 引用的 refId（按出现顺序，去重）
    /// </summary>
    /// <param name="userInput">用户原始输入</param>
    /// <returns>去重后的 refId 列表，按首次出现顺序排列</returns>
    /// <example>
    /// var refIds = ExtractRefIds("@img12 @img9 @img12 融合");
    /// // refIds = [12, 9]  (12 出现两次但只记录一次)
    /// </example>
    public static List<int> ExtractRefIds(string userInput)
    {
        var result = new List<int>();
        if (string.IsNullOrWhiteSpace(userInput))
        {
            return result;
        }

        var seen = new HashSet<int>();
        foreach (Match match in ImageRefPattern.Matches(userInput))
        {
            if (int.TryParse(match.Groups[1].Value, out var refId) && refId > 0 && seen.Add(refId))
            {
                result.Add(refId);
            }
        }

        return result;
    }

    /// <summary>
    /// 构建 refId -> 顺序号 的映射（顺序号从1开始）
    /// </summary>
    /// <param name="userInput">用户原始输入</param>
    /// <returns>映射字典</returns>
    /// <example>
    /// var mapping = BuildRefIdToOrderMapping("让@img12打@img9");
    /// // mapping = { 12: 1, 9: 2 }
    /// </example>
    public static Dictionary<int, int> BuildRefIdToOrderMapping(string userInput)
    {
        var refIds = ExtractRefIds(userInput);
        var mapping = new Dictionary<int, int>();
        for (var i = 0; i < refIds.Count; i++)
        {
            mapping[refIds[i]] = i + 1;
        }
        return mapping;
    }

    /// <summary>
    /// 一步完成：从用户输入直接转换为模型 prompt
    /// </summary>
    /// <param name="userInput">用户原始输入</param>
    /// <returns>转换后的 prompt</returns>
    /// <example>
    /// var result = TransformDirect("让@img12打@img9");
    /// // result = "让图1打图2"
    /// </example>
    public static string TransformDirect(string userInput)
    {
        var mapping = BuildRefIdToOrderMapping(userInput);
        return Transform(userInput, mapping);
    }
}
