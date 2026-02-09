namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 流式思考标签剥离器
/// 处理模型在 content 字段中嵌入 &lt;think&gt;...&lt;/think&gt; 标签的情况
///
/// 工作原理：
/// - 跟踪是否在 &lt;think&gt; 块内
/// - &lt;think&gt; 块内的内容被过滤，不输出到最终结果
/// - &lt;/think&gt; 之后的内容正常输出
/// - 支持跨 chunk 边界的标签检测
/// </summary>
public class ThinkTagStripper
{
    private bool _insideThink;
    private string _pendingBuffer = string.Empty;

    private const string OpenTag = "<think>";
    private const string CloseTag = "</think>";

    /// <summary>
    /// 处理一个流式 chunk，返回应该输出的内容（过滤掉 think 标签内的部分）
    /// 返回 null 表示当前 chunk 全部被过滤
    /// </summary>
    public string? Process(string content)
    {
        var input = _pendingBuffer + content;
        _pendingBuffer = string.Empty;

        var result = new System.Text.StringBuilder();
        var pos = 0;

        while (pos < input.Length)
        {
            if (_insideThink)
            {
                // 在 think 块内，寻找 </think>
                var closeIdx = input.IndexOf(CloseTag, pos, StringComparison.OrdinalIgnoreCase);
                if (closeIdx >= 0)
                {
                    // 找到关闭标签，跳过 think 内容
                    _insideThink = false;
                    pos = closeIdx + CloseTag.Length;
                }
                else
                {
                    // 没找到关闭标签，可能标签跨 chunk 了
                    // 保留末尾可能是部分 </think> 的内容
                    var partialLen = PendingPartialMatch(input, pos, CloseTag);
                    if (partialLen > 0)
                    {
                        _pendingBuffer = input[^partialLen..];
                    }
                    // think 块内的内容全部丢弃
                    break;
                }
            }
            else
            {
                // 在正常内容区，寻找 <think>
                var openIdx = input.IndexOf(OpenTag, pos, StringComparison.OrdinalIgnoreCase);
                if (openIdx >= 0)
                {
                    // 找到开始标签，输出标签之前的内容
                    if (openIdx > pos)
                    {
                        result.Append(input, pos, openIdx - pos);
                    }
                    _insideThink = true;
                    pos = openIdx + OpenTag.Length;
                }
                else
                {
                    // 没有 <think> 标签
                    // 检查末尾是否有部分 <think> 匹配
                    var partialLen = PendingPartialMatch(input, pos, OpenTag);
                    if (partialLen > 0)
                    {
                        // 输出到部分匹配之前的内容
                        result.Append(input, pos, input.Length - pos - partialLen);
                        _pendingBuffer = input[^partialLen..];
                    }
                    else
                    {
                        result.Append(input, pos, input.Length - pos);
                    }
                    break;
                }
            }
        }

        var output = result.ToString();
        return output.Length > 0 ? output : null;
    }

    /// <summary>
    /// 刷新剩余缓冲区（流结束时调用）
    /// 返回未处理的挂起内容
    /// </summary>
    public string? Flush()
    {
        if (string.IsNullOrEmpty(_pendingBuffer))
            return null;

        var remaining = _pendingBuffer;
        _pendingBuffer = string.Empty;

        // 如果在 think 块内，丢弃剩余内容
        if (_insideThink)
            return null;

        return remaining;
    }

    /// <summary>
    /// 检查 input 末尾是否有 tag 的部分前缀匹配
    /// 返回部分匹配的长度，0 表示无匹配
    /// </summary>
    private static int PendingPartialMatch(string input, int startPos, string tag)
    {
        // 从 tag 的最长前缀（tag.Length - 1 个字符）开始，逐步缩短
        var maxCheck = Math.Min(tag.Length - 1, input.Length - startPos);
        for (var len = maxCheck; len > 0; len--)
        {
            var suffix = input.AsSpan(input.Length - len);
            var prefix = tag.AsSpan(0, len);
            if (suffix.Equals(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return len;
            }
        }
        return 0;
    }
}
