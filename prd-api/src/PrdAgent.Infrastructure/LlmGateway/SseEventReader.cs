using System.Runtime.CompilerServices;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 标准 SSE 事件读取器
/// 按 SSE 规范解析事件流：多行 data: 正确拼接，空行作为事件分隔符
/// </summary>
public class SseEventReader
{
    private readonly StreamReader _reader;

    public SseEventReader(StreamReader reader) => _reader = reader;

    /// <summary>
    /// 逐个 SSE 事件读取，每次 yield 一个完整的 data 字符串
    /// </summary>
    public async IAsyncEnumerable<string> ReadEventsAsync(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var dataLines = new List<string>();

        while (!_reader.EndOfStream)
        {
            var line = await _reader.ReadLineAsync(ct);

            // 空行 = 事件边界，派发已积累的 data
            if (string.IsNullOrEmpty(line))
            {
                if (dataLines.Count > 0)
                {
                    yield return string.Join("\n", dataLines);
                    dataLines.Clear();
                }
                continue;
            }

            // 注释行跳过
            if (line[0] == ':') continue;

            // data: 行积累
            if (line.StartsWith("data:"))
            {
                var value = line.Substring(5).TrimStart();
                if (value == "[DONE]")
                {
                    yield break;
                }
                dataLines.Add(value);
            }
            // event:, id:, retry: 等其他字段忽略
        }

        // 流结束但还有未派发的 data
        if (dataLines.Count > 0)
        {
            yield return string.Join("\n", dataLines);
        }
    }
}
