using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 内存 ID 生成器 - Redis 不可用时的 fallback
/// 使用 GUID + 时间戳确保唯一性
/// </summary>
public class MemoryIdGenerator : IIdGenerator
{
    private readonly bool _useReadableIds;
    private long _counter = 0;

    public MemoryIdGenerator(bool useReadableIds = false)
    {
        _useReadableIds = useReadableIds;
    }

    public Task<string> GenerateIdAsync(string category)
    {
        if (_useReadableIds)
        {
            // 开发环境：可读 ID
            var counter = Interlocked.Increment(ref _counter);
            return Task.FromResult($"{category}_{counter:D6}");
        }
        else
        {
            // 生产环境：GUID 格式
            var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var random = Guid.NewGuid().ToString("N")[..8];
            return Task.FromResult($"{category}_{timestamp}_{random}");
        }
    }
}
