using System.Diagnostics;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.LlmGatewayHost;

public interface IGatewayServingReadinessProbe
{
    Task<GatewayServingReadinessSnapshot> CheckAsync(CancellationToken cancellationToken);
}

public sealed record GatewayServingReadinessComponent(
    string Name,
    bool Ready,
    long DurationMs,
    string Summary);

public sealed record GatewayServingReadinessSnapshot(
    bool Ready,
    DateTime CheckedAt,
    IReadOnlyList<GatewayServingReadinessComponent> Components);

public sealed class GatewayServingReadinessProbe : IGatewayServingReadinessProbe
{
    private const string AppCallerCollection = "llmgw_app_callers";
    private const string PoolCollection = "llmgw_model_pools";
    private const string PlatformCollection = "llmgw_platforms";
    private const string ExchangeCollection = "llmgw_model_exchanges";

    private readonly MongoDbContext _mapDb;
    private readonly LlmGatewayDataContext _gatewayDb;
    private readonly IAssetStorage _assetStorage;
    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<GatewayServingReadinessProbe> _logger;
    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private GatewayServingReadinessSnapshot? _cached;
    private DateTime _cachedAt;

    public GatewayServingReadinessProbe(
        MongoDbContext mapDb,
        LlmGatewayDataContext gatewayDb,
        IAssetStorage assetStorage,
        IConfiguration configuration,
        IHostEnvironment environment,
        ILogger<GatewayServingReadinessProbe> logger)
    {
        _mapDb = mapDb;
        _gatewayDb = gatewayDb;
        _assetStorage = assetStorage;
        _configuration = configuration;
        _environment = environment;
        _logger = logger;
    }

    public async Task<GatewayServingReadinessSnapshot> CheckAsync(CancellationToken cancellationToken)
    {
        var cacheSeconds = Math.Clamp(
            _configuration.GetValue("LlmGateway:Readiness:CacheSeconds", 10),
            1,
            60);
        var cached = _cached;
        if (cached != null && DateTime.UtcNow - _cachedAt < TimeSpan.FromSeconds(cacheSeconds))
            return cached;

        await _refreshLock.WaitAsync(cancellationToken);
        try
        {
            cached = _cached;
            if (cached != null && DateTime.UtcNow - _cachedAt < TimeSpan.FromSeconds(cacheSeconds))
                return cached;

            var refreshed = await CheckFreshAsync(cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            _cached = refreshed;
            _cachedAt = DateTime.UtcNow;
            return refreshed;
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    private async Task<GatewayServingReadinessSnapshot> CheckFreshAsync(CancellationToken cancellationToken)
    {
        var timeoutSeconds = Math.Clamp(
            _configuration.GetValue("LlmGateway:Readiness:ProbeTimeoutSeconds", 10),
            1,
            30);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));

        var components = new List<GatewayServingReadinessComponent>
        {
            await CheckMongoAsync("map-mongo", _mapDb.Database, timeout.Token),
            await CheckMongoAsync("gateway-mongo", _gatewayDb.Database, timeout.Token),
            await CheckAssetStorageAsync(timeout.Token),
            await CheckKeyIntegrityAsync(timeout.Token),
            await CheckRouterAsync(timeout.Token),
        };

        return new GatewayServingReadinessSnapshot(
            components.All(x => x.Ready),
            DateTime.UtcNow,
            components);
    }

    private async Task<GatewayServingReadinessComponent> CheckMongoAsync(
        string name,
        IMongoDatabase database,
        CancellationToken cancellationToken)
    {
        return await MeasureAsync(name, async () =>
        {
            await database.RunCommandAsync<BsonDocument>(
                new BsonDocument("ping", 1),
                cancellationToken: cancellationToken);
            return "ping ok";
        });
    }

    private async Task<GatewayServingReadinessComponent> CheckAssetStorageAsync(CancellationToken cancellationToken)
    {
        var requireProbe = _configuration.GetValue(
            "LlmGateway:Readiness:RequireAssetProbe",
            _environment.IsProduction());
        var probeKey = _configuration["LlmGateway:Readiness:AssetProbeKey"]?.Trim();

        if (string.IsNullOrWhiteSpace(probeKey))
        {
            return new GatewayServingReadinessComponent(
                "asset-storage",
                !requireProbe,
                0,
                requireProbe ? "probe key missing" : "probe disabled");
        }

        return await MeasureAsync("asset-storage", async () =>
        {
            var exists = await _assetStorage.ExistsAsync(probeKey, cancellationToken);
            if (!exists)
                throw new InvalidOperationException("configured probe object is not reachable");
            return "probe object reachable";
        });
    }

    private async Task<GatewayServingReadinessComponent> CheckKeyIntegrityAsync(CancellationToken cancellationToken)
    {
        return await MeasureAsync("key-integrity", async () =>
        {
            var platforms = _gatewayDb.Database.GetCollection<LLMPlatform>(PlatformCollection);
            var exchanges = _gatewayDb.Database.GetCollection<ModelExchange>(ExchangeCollection);
            var enabledPlatforms = await platforms.Find(x => x.Enabled).ToListAsync(cancellationToken);
            var enabledExchanges = await exchanges.Find(x => x.Enabled).ToListAsync(cancellationToken);

            var encryptedKeys = enabledPlatforms
                .Select(x => x.ApiKeyEncrypted)
                .Concat(enabledExchanges.Select(x => x.TargetApiKeyEncrypted))
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .ToList();
            var failed = encryptedKeys.Count(x => !ApiKeyCryptoKeyRing.Decrypt(x, _configuration).Success);
            if (failed > 0)
                throw new InvalidOperationException($"{failed} enabled provider keys cannot be decrypted");

            return $"{encryptedKeys.Count} encrypted provider keys verified";
        });
    }

    private async Task<GatewayServingReadinessComponent> CheckRouterAsync(CancellationToken cancellationToken)
    {
        return await MeasureAsync("router", async () =>
        {
            var callers = _gatewayDb.Database.GetCollection<GatewayAppCallerRecord>(AppCallerCollection);
            var pools = _gatewayDb.Database.GetCollection<ModelGroup>(PoolCollection);
            var governed = await callers.Find(x => x.Status == "configured" || x.Status == "active")
                .ToListAsync(cancellationToken);
            var poolIds = governed
                .Select(x => x.ModelPoolId)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x!)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var boundPools = poolIds.Count == 0
                ? new List<ModelGroup>()
                : await pools.Find(Builders<ModelGroup>.Filter.In(x => x.Id, poolIds))
                    .ToListAsync(cancellationToken);
            var requestTypes = governed
                .Select(x => x.RequestType)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Distinct(StringComparer.Ordinal)
                .ToList();
            var defaultPools = requestTypes.Count == 0
                ? new List<ModelGroup>()
                : await pools.Find(
                        Builders<ModelGroup>.Filter.And(
                            Builders<ModelGroup>.Filter.Eq(x => x.IsDefaultForType, true),
                            Builders<ModelGroup>.Filter.In(x => x.ModelType, requestTypes)))
                    .ToListAsync(cancellationToken);
            var poolById = boundPools.ToDictionary(x => x.Id, StringComparer.OrdinalIgnoreCase);
            var routableCallers = governed.Count(x => IsCallerRoutable(x, poolById, defaultPools));
            var invalidCallers = governed.Count - routableCallers;
            // Readiness is instance-scoped. A single invalid caller is configuration degradation,
            // which the config-authority release gate blocks; taking every serving instance out
            // would turn one caller's bad binding into a global AI outage.
            if (governed.Count > 0 && routableCallers == 0)
            {
                throw new InvalidOperationException(
                    $"no governed appCaller has a usable model pool: invalid={invalidCallers}");
            }

            return $"{routableCallers}/{governed.Count} governed appCallers routable, invalid={invalidCallers}";
        });
    }

    public static bool IsCallerRoutable(
        GatewayAppCallerRecord caller,
        IReadOnlyDictionary<string, ModelGroup> poolById,
        IReadOnlyCollection<ModelGroup> defaultPools)
    {
        if (!string.IsNullOrWhiteSpace(caller.ModelPoolId))
        {
            return poolById.TryGetValue(caller.ModelPoolId, out var boundPool) &&
                   IsPoolRoutableForRequestType(boundPool, caller.RequestType);
        }

        return defaultPools.Any(pool =>
            pool.IsDefaultForType &&
            IsPoolRoutableForRequestType(pool, caller.RequestType));
    }

    private static bool IsPoolRoutableForRequestType(ModelGroup pool, string requestType)
        => pool.ModelType == requestType &&
           pool.Models.Count > 0 &&
           pool.Models.Any(m => m.HealthStatus != ModelHealthStatus.Unavailable);

    private async Task<GatewayServingReadinessComponent> MeasureAsync(
        string name,
        Func<Task<string>> action)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            var summary = await action();
            return new GatewayServingReadinessComponent(name, true, stopwatch.ElapsedMilliseconds, summary);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                "LLM Gateway readiness component failed: component={Component}, exceptionType={ExceptionType}",
                name,
                ex.GetType().Name);
            return new GatewayServingReadinessComponent(
                name,
                false,
                stopwatch.ElapsedMilliseconds,
                ex is OperationCanceledException ? "probe timeout" : "probe failed");
        }
    }
}
