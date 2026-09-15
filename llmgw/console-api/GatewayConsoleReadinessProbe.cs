using System.Diagnostics;
using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw;

/// <summary>
/// 控制台业务就绪探针，只证明其权威 Mongo 持久层可读，不返回连接或异常细节。
/// </summary>
public sealed class GatewayConsoleReadinessProbe
{
    public const string MongoUnavailable = "MONGODB_UNAVAILABLE";
    private static readonly TimeSpan DefaultProbeTimeout = TimeSpan.FromSeconds(5);
    private readonly Func<CancellationToken, Task> _mongoProbe;
    private readonly TimeSpan _probeTimeout;

    public GatewayConsoleReadinessProbe(IMongoDatabase database)
        : this(async cancellationToken =>
        {
            await database.RunCommandAsync<BsonDocument>(
                new BsonDocument("ping", 1),
                cancellationToken: cancellationToken);
        })
    {
    }

    /// <param name="probeTimeout">探测上限，缺省 5 秒；显式传入只为把这条超时缩短到可测。</param>
    public GatewayConsoleReadinessProbe(
        Func<CancellationToken, Task> mongoProbe,
        TimeSpan? probeTimeout = null)
    {
        _mongoProbe = mongoProbe;
        _probeTimeout = probeTimeout ?? DefaultProbeTimeout;
    }

    public async Task<GatewayConsoleReadinessSnapshot> CheckAsync(
        CancellationToken cancellationToken = default)
    {
        var stopwatch = Stopwatch.StartNew();
        // 超时必须真的把下游 Mongo 操作取消掉：只 WaitAsync(超时) 会让调用方走人、
        // 探测本身留在后台跑，Mongo 掉线期间每次探测都堆一条在途操作。
        // 仍然保留一层 WaitAsync(linked)，这样即使探测实现不认令牌，5 秒上限也成立。
        using var probeScope = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        probeScope.CancelAfter(_probeTimeout);
        try
        {
            await _mongoProbe(probeScope.Token).WaitAsync(probeScope.Token);
            return new GatewayConsoleReadinessSnapshot(
                Status: "ready",
                ErrorCode: null,
                Components: [new GatewayConsoleReadinessComponent("mongodb", true, null)],
                CheckedAt: DateTime.UtcNow,
                DurationMs: stopwatch.ElapsedMilliseconds);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return new GatewayConsoleReadinessSnapshot(
                Status: "not-ready",
                ErrorCode: MongoUnavailable,
                Components: [new GatewayConsoleReadinessComponent("mongodb", false, MongoUnavailable)],
                CheckedAt: DateTime.UtcNow,
                DurationMs: stopwatch.ElapsedMilliseconds);
        }
    }
}

public sealed record GatewayConsoleReadinessSnapshot(
    string Status,
    string? ErrorCode,
    IReadOnlyList<GatewayConsoleReadinessComponent> Components,
    DateTime CheckedAt,
    long DurationMs);

public sealed record GatewayConsoleReadinessComponent(
    string Name,
    bool Ready,
    string? ErrorCode);
