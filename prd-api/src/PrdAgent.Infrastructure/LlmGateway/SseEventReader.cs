using System.Runtime.CompilerServices;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// SSE 事件读取器
/// 逐行读取 SSE 流，每个 data: 行立即作为独立事件派发。
/// OpenAI 兼容 API 的每个 data: 行都是完整 JSON，无需等待空行分隔。
/// </summary>
public class SseEventReader
{
    private readonly StreamReader _reader;

    public SseEventReader(StreamReader reader) => _reader = reader;

    /// <summary>
    /// 逐个 SSE data 事件读取
    /// </summary>
    public async IAsyncEnumerable<string> ReadEventsAsync(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        while (!_reader.EndOfStream)
        {
            var line = await _reader.ReadLineAsync(ct);
            if (string.IsNullOrEmpty(line)) continue;

            // 注释行跳过
            if (line[0] == ':') continue;

            // data: 行 → 立即派发
            if (line.StartsWith("data:"))
            {
                var value = line.Substring(5).TrimStart();
                if (value == "[DONE]")
                {
                    yield break;
                }
                yield return value;
            }
            // event:, id:, retry: 等其他字段忽略
        }
    }
}
