using PrdAgent.Core.Interfaces;
using StackExchange.Redis;

namespace PrdAgent.Infrastructure.Services;

public sealed class RedisRunQueue : IRunQueue, IDisposable
{
    private readonly ConnectionMultiplexer _redis;
    private readonly IDatabase _db;

    public RedisRunQueue(string connectionString)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
            throw new ArgumentException("Redis 连接字符串不能为空", nameof(connectionString));
        _redis = ConnectionMultiplexer.Connect(connectionString.Trim());
        _db = _redis.GetDatabase();
    }

    private static string Key(string kind) => $"run:{(kind ?? string.Empty).Trim()}:queue";

    public async Task EnqueueAsync(string kind, string runId, CancellationToken ct = default)
    {
        var id = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(id)) return;
        await _db.ListRightPushAsync(Key(kind), id);
    }

    public async Task<string?> DequeueAsync(string kind, TimeSpan timeout, CancellationToken ct = default)
    {
        // StackExchange.Redis 不支持 CancellationToken；用短超时轮询即可。
        var seconds = Math.Max(0, (int)Math.Round(timeout.TotalSeconds));
        var res = await _db.ListLeftPopAsync(Key(kind));
        if (!res.IsNullOrEmpty) return res.ToString();

        // 退化：没有 BLPOP；用 delay + 再 pop
        if (seconds > 0)
        {
            await Task.Delay(TimeSpan.FromSeconds(Math.Min(seconds, 1)));
            res = await _db.ListLeftPopAsync(Key(kind));
            if (!res.IsNullOrEmpty) return res.ToString();
        }
        return null;
    }

    public void Dispose()
    {
        _redis.Dispose();
    }
}


