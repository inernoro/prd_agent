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
            // PingAsync 不收令牌，所以这里不再自己套一层超时——上限由 ProbeAsync 统一施加，
            // 两处各写一个超时就是同一条判据的两份拷贝，改一处忘一处。
            async _ => await redis.GetDatabase().PingAsync(),
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
        _redisProbe = redisProbe;
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
