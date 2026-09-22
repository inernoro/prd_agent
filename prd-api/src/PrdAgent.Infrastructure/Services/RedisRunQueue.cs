using System.Security.Cryptography;
using System.Text;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using StackExchange.Redis;

namespace PrdAgent.Infrastructure.Services;

public sealed class RedisRunQueue : IRunQueue, IDisposable
{
    private readonly ConnectionMultiplexer _redis;
    private readonly IDatabase _db;
    private readonly string _designQueueKey;

    public RedisRunQueue(string connectionString)
        : this(connectionString, () => DeploymentScope.Current)
    {
    }

    internal RedisRunQueue(string connectionString, Func<string?> scopeReader)
    {
        if (string.IsNullOrWhiteSpace(connectionString))
            throw new ArgumentException("Redis 连接字符串不能为空", nameof(connectionString));
        // 在构造时冻结完整部署作用域，避免入队与出队期间环境变化导致队列漂移。
        _designQueueKey = BuildKey(RunKinds.DesignArtifact, scopeReader());
        _redis = ConnectionMultiplexer.Connect(connectionString.Trim());
        _db = _redis.GetDatabase();
    }

    internal static string BuildKey(string? kind, string? scope)
    {
        kind = (kind ?? string.Empty).Trim();
        if (kind != RunKinds.DesignArtifact) return $"run:{kind}:queue";

        // v2 不与旧公共队列互读，防止旧消费者弹走新设计任务 ID。
        // null（生产/本地）也有独立稳定键；预览按项目、分支、revision 的完整 scope 隔离。
        // 这里只隔离 Redis 唤醒队列，Mongo 扫描与认领仍需独立的作用域过滤。
        var identity = scope is null
            ? "unscoped"
            : $"scope:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(scope)))}";
        return $"run:v2:{RunKinds.DesignArtifact}:{identity}:queue";
    }

    private string Key(string kind) => (kind ?? string.Empty).Trim() == RunKinds.DesignArtifact
        ? _designQueueKey
        : BuildKey(kind, null);

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
