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

    private static readonly TimeSpan DependencyTimeout = TimeSpan.FromSeconds(5);
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
            async cancellationToken =>
            {
                await redis.GetDatabase().PingAsync().WaitAsync(
                    DependencyTimeout,
                    cancellationToken);
            },
            (force, cancellationToken) => assetProbe.CheckAsync(force, cancellationToken),
            logger)
    {
    }

    internal ApplicationReadinessProbe(
        Func<CancellationToken, Task> mongoProbe,
        Func<CancellationToken, Task> redisProbe,
        Func<bool, CancellationToken, Task<AssetStorageReadinessResponse>> assetProbe,
        ILogger<ApplicationReadinessProbe> logger)
    {
        _mongoProbe = mongoProbe;
        _redisProbe = redisProbe;
        _assetProbe = assetProbe;
        _logger = logger;
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
        try
        {
            await probe(cancellationToken).WaitAsync(DependencyTimeout, cancellationToken);
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
        try
        {
            var result = await _assetProbe(force, cancellationToken);
            if (string.Equals(result.Status, "healthy", StringComparison.Ordinal))
            {
                return new AssetReadinessResult(Ready("asset-storage"), result);
            }

            return new AssetReadinessResult(
                Failed(
                    "asset-storage",
                    string.IsNullOrWhiteSpace(result.ErrorCode)
                        ? AssetStorageUnavailable
                        : result.ErrorCode),
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
