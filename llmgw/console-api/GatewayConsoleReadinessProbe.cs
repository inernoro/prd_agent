using System.Diagnostics;
using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.LlmGw;

/// <summary>
/// 控制台业务就绪探针，证明它**全部**权威 Mongo 持久层可读，不返回连接或异常细节。
/// </summary>
/// <remarks>
/// 控制台读两个库：网关库（自己的权威存储）与 MAP 库（model_groups / llmplatforms /
/// llmmodels / model_exchanges 四个集合）。两者在配置上可以指向不同部署，
/// 只探网关库的话，MAP 库一挂就会出现「readyz 回 200、而那几条路由全坏」——
/// 就绪声明又变成只探了「进程活着」。所以每个配置到的库都要探，缺一个就不算就绪。
///
/// 组件名 `mongodb` 不能改：凭据轮换的深检按这个名字要求它存在且为 true。
/// </remarks>
public sealed class GatewayConsoleReadinessProbe
{
    public const string MongoUnavailable = "MONGODB_UNAVAILABLE";
    private static readonly TimeSpan DefaultProbeTimeout = TimeSpan.FromSeconds(5);
    private readonly IReadOnlyList<(string Name, Func<CancellationToken, Task> Probe)> _probes;
    private readonly TimeSpan _probeTimeout;

    public GatewayConsoleReadinessProbe(IMongoDatabase gatewayDatabase, IMongoDatabase mapDatabase)
        : this([("mongodb", Ping(gatewayDatabase)), ("map-mongodb", Ping(mapDatabase))])
    {
    }

    public GatewayConsoleReadinessProbe(IMongoDatabase database)
        : this([("mongodb", Ping(database))])
    {
    }

    /// <param name="probeTimeout">探测上限，缺省 5 秒；显式传入只为把这条超时缩短到可测。</param>
    public GatewayConsoleReadinessProbe(
        Func<CancellationToken, Task> mongoProbe,
        TimeSpan? probeTimeout = null)
        : this([("mongodb", mongoProbe)], probeTimeout)
    {
    }

    public GatewayConsoleReadinessProbe(
        IReadOnlyList<(string Name, Func<CancellationToken, Task> Probe)> probes,
        TimeSpan? probeTimeout = null)
    {
        _probes = probes;
        _probeTimeout = probeTimeout ?? DefaultProbeTimeout;
    }

    private static Func<CancellationToken, Task> Ping(IMongoDatabase database)
        => async cancellationToken =>
        {
            await database.RunCommandAsync<BsonDocument>(
                new BsonDocument("ping", 1),
                cancellationToken: cancellationToken);
        };

    public async Task<GatewayConsoleReadinessSnapshot> CheckAsync(
        CancellationToken cancellationToken = default)
    {
        var stopwatch = Stopwatch.StartNew();
        // 超时必须真的把下游 Mongo 操作取消掉：只 WaitAsync(超时) 会让调用方走人、
        // 探测本身留在后台跑，Mongo 掉线期间每次探测都堆一条在途操作。
        // 仍然保留一层 WaitAsync(linked)，这样即使探测实现不认令牌，5 秒上限也成立。
        using var probeScope = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        probeScope.CancelAfter(_probeTimeout);
        var components = new List<GatewayConsoleReadinessComponent>(_probes.Count);
        var allReady = true;
        foreach (var (name, probe) in _probes)
        {
            try
            {
                await probe(probeScope.Token).WaitAsync(probeScope.Token);
                components.Add(new GatewayConsoleReadinessComponent(name, true, null));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                allReady = false;
                components.Add(new GatewayConsoleReadinessComponent(name, false, MongoUnavailable));
            }
        }
        return new GatewayConsoleReadinessSnapshot(
            Status: allReady ? "ready" : "not-ready",
            ErrorCode: allReady ? null : MongoUnavailable,
            Components: components,
            CheckedAt: DateTime.UtcNow,
            DurationMs: stopwatch.ElapsedMilliseconds);
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
