using System.Diagnostics;
using MongoDB.Bson;
using PrdAgent.Api.Json;
using PrdAgent.Infrastructure.Database;
using StackExchange.Redis;

namespace PrdAgent.Api.Services;

/// <summary>
/// 验证 API 真正依赖的 MongoDB、Redis 与对象存储，而不是只证明 HTTP 进程存活。
/// </summary>
public sealed class ApplicationReadinessProbe
{
    internal const string MongoUnavailable = "MONGODB_UNAVAILABLE";
    internal const string RedisUnavailable = "REDIS_UNAVAILABLE";
    internal const string AssetStorageUnavailable = "ASSET_STORAGE_UNAVAILABLE";

    private static readonly TimeSpan DefaultDependencyTimeout = TimeSpan.FromSeconds(5);
    private readonly TimeSpan _dependencyTimeout;
    private readonly Func<CancellationToken, Task> _mongoProbe;
    private readonly Func<CancellationToken, Task> _redisProbe;
    private readonly Func<bool, CancellationToken, Task<AssetStorageReadinessResponse>> _assetProbe;
    private readonly ILogger<ApplicationReadinessProbe> _logger;

    public ApplicationReadinessProbe(
        MongoDbContext mongo,
        ConnectionMultiplexer redis,
        AssetStorageReadinessProbe assetProbe,
        ILogger<ApplicationReadinessProbe> logger)
        : this(
            async cancellationToken =>
            {
                await mongo.Database.RunCommandAsync<BsonDocument>(
                    new BsonDocument("ping", 1),
                    cancellationToken: cancellationToken);
            },
            // PingAsync 不收令牌，谁也停不掉它。所以这里不再自己套第二层超时（同一条判据
            // 两份拷贝，改一处忘一处），改为把它合并成一次在途调用——理由见
            // SingleFlightProbe：这条路真的会挂住，本仓库已经量到过。
            _ => redis.GetDatabase().PingAsync(),
            (force, cancellationToken) => assetProbe.CheckAsync(force, cancellationToken),
            logger)
    {
    }

    internal ApplicationReadinessProbe(
        Func<CancellationToken, Task> mongoProbe,
        Func<CancellationToken, Task> redisProbe,
        Func<bool, CancellationToken, Task<AssetStorageReadinessResponse>> assetProbe,
        ILogger<ApplicationReadinessProbe> logger,
        TimeSpan? dependencyTimeout = null)
    {
        _mongoProbe = mongoProbe;
        // Redis 探测单独合并：它底下那次调用不认取消令牌，超时只能让调用方走人、停不掉它。
        // 不合并的话，Redis 挂住期间每一次 /health/ready（编排每几秒来一次）都会再起一次，
        // 攒成一堆谁也停不掉的在途操作。Mongo 与对象存储不需要：它们真的收令牌，
        // 超时一到下游就被取消，每次探测都干净结束。
        _redisProbe = new SingleFlightProbe(redisProbe).RunAsync;
        _assetProbe = assetProbe;
        _logger = logger;
        // 显式传入只为把这条 5 秒上限缩短到可测。
        _dependencyTimeout = dependencyTimeout ?? DefaultDependencyTimeout;
    }

    public async Task<ApplicationReadinessResponse> CheckAsync(
        bool force = false,
        CancellationToken cancellationToken = default)
    {
        var stopwatch = Stopwatch.StartNew();
        var mongoTask = ProbeAsync("mongodb", MongoUnavailable, _mongoProbe, cancellationToken);
        var redisTask = ProbeAsync("redis", RedisUnavailable, _redisProbe, cancellationToken);
        var assetTask = ProbeAssetStorageAsync(force, cancellationToken);
        await Task.WhenAll(mongoTask, redisTask, assetTask);
        var assetResult = await assetTask;
        var components = new[] { await mongoTask, await redisTask, assetResult.Component };
        var firstFailure = components.FirstOrDefault(component => !component.Ready);

        return new ApplicationReadinessResponse
        {
            // 保持既有 /health/ready 的 status 契约，发布证据消费者无需迁移。
            Status = firstFailure == null ? "healthy" : "unhealthy",
            ErrorCode = firstFailure?.ErrorCode,
            Provider = assetResult.Response.Provider,
            ExpectedProvider = assetResult.Response.ExpectedProvider,
            WriteVerified = assetResult.Response.WriteVerified,
            InternalReadVerified = assetResult.Response.InternalReadVerified,
            PublicReadVerified = assetResult.Response.PublicReadVerified,
            CleanupVerified = assetResult.Response.CleanupVerified,
            ProbeBytes = assetResult.Response.ProbeBytes,
            Components = components.ToList(),
            CheckedAt = DateTime.UtcNow,
            DurationMs = stopwatch.ElapsedMilliseconds,
        };
    }

    private async Task<ApplicationReadinessComponent> ProbeAsync(
        string name,
        string errorCode,
        Func<CancellationToken, Task> probe,
        CancellationToken cancellationToken)
    {
        // 超时必须真的把下游操作取消掉：只 WaitAsync(超时) 会让 /health/ready 走人、
        // 探测留在后台跑，依赖掉线期间每次就绪请求都堆一条在途操作。
        using var probeScope = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        probeScope.CancelAfter(_dependencyTimeout);
        try
        {
            await probe(probeScope.Token).WaitAsync(probeScope.Token);
            return Ready(name);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                "Application readiness dependency failed. component={Component} exceptionType={ExceptionType}",
                name,
                ex.GetType().Name);
            return Failed(name, errorCode);
        }
    }

    private async Task<AssetReadinessResult> ProbeAssetStorageAsync(
        bool force,
        CancellationToken cancellationToken)
    {
        // 对象存储与 Mongo / Redis 共用同一条超时口径：少了它，存储卡住时
        // Task.WhenAll 会一直等，/health/ready 整个挂着，调用方在它后面排队。
        using var probeScope = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        probeScope.CancelAfter(_dependencyTimeout);
        try
        {
            var result = await _assetProbe(force, probeScope.Token).WaitAsync(probeScope.Token);
            if (string.Equals(result.Status, "healthy", StringComparison.Ordinal))
            {
                return new AssetReadinessResult(Ready("asset-storage"), result);
            }

            return new AssetReadinessResult(
                // 聚合就绪接口只暴露稳定组件码；对象存储阶段详情留在专用诊断端点。
                Failed("asset-storage", AssetStorageUnavailable),
                result);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                "Application readiness dependency failed. component=asset-storage exceptionType={ExceptionType}",
                ex.GetType().Name);
            return new AssetReadinessResult(
                Failed("asset-storage", AssetStorageUnavailable),
                new AssetStorageReadinessResponse { Status = "unhealthy" });
        }
    }

    private static ApplicationReadinessComponent Ready(string name)
        => new() { Name = name, Ready = true };

    private static ApplicationReadinessComponent Failed(string name, string errorCode)
        => new() { Name = name, Ready = false, ErrorCode = errorCode };

    private sealed record AssetReadinessResult(
        ApplicationReadinessComponent Component,
        AssetStorageReadinessResponse Response);
}

/// <summary>
/// 把「不认取消令牌」的探测合并成一次在途调用。
///
/// 为什么需要：调用方的超时只能让自己走人，停不掉底下那一次。StackExchange.Redis 的
/// PingAsync 不收令牌，而本仓库量到过 multiplexer 半失活时命令不按 SyncTimeout 抛异常、
/// 直接挂住（见 DocumentStoreAgentWorker 里那条 3 秒硬超时的注释）。就绪端点由编排每几秒
/// 打一次，一次 Redis 故障就会攒出成百条谁也停不掉的在途操作。
///
/// 只在「上一次还没结束」时合并，不缓存结果：上一次一结束，下一次就重新发起。
/// 所以它不会让调用方读到过期结论，只会让并发的调用方共享同一次真实探测。
/// </summary>
internal sealed class SingleFlightProbe
{
    private readonly Func<CancellationToken, Task> _probe;
    private readonly object _gate = new();
    private Task? _inFlight;

    internal SingleFlightProbe(Func<CancellationToken, Task> probe) => _probe = probe;

    internal Task RunAsync(CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            if (_inFlight is { IsCompleted: false }) return _inFlight;
            // 令牌不往下传：这一次是共享的，第一个调用方走人不该把后来者的探测一起取消掉。
            // 各自的上限仍由 ProbeAsync 的 WaitAsync 施加。
            var started = _probe(CancellationToken.None);
            // 所有调用方都超时走人之后这个 Task 可能没人 await，异常会变成未观察异常。
            _inFlight = started;
            _ = started.ContinueWith(
                task => _ = task.Exception,
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            return started;
        }
    }
}
