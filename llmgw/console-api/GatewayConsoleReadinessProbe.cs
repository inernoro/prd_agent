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
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(5);
    private readonly Func<CancellationToken, Task> _mongoProbe;

    public GatewayConsoleReadinessProbe(IMongoDatabase database)
        : this(async cancellationToken =>
        {
            await database.RunCommandAsync<BsonDocument>(
                new BsonDocument("ping", 1),
                cancellationToken: cancellationToken);
        })
    {
    }

    public GatewayConsoleReadinessProbe(Func<CancellationToken, Task> mongoProbe)
    {
        _mongoProbe = mongoProbe;
    }

    public async Task<GatewayConsoleReadinessSnapshot> CheckAsync(
        CancellationToken cancellationToken = default)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            await _mongoProbe(cancellationToken).WaitAsync(ProbeTimeout, cancellationToken);
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
