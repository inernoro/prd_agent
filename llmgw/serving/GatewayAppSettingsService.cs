using Microsoft.Extensions.Caching.Memory;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.LlmGatewayHost;

/// <summary>
/// Serving-owned runtime settings. Only the non-sensitive fields consumed by the gateway are
/// copied from MAP during one-time bootstrap; all subsequent reads use llm_gateway.
/// </summary>
public sealed class GatewayAppSettingsService : IAppSettingsService
{
    internal const string CollectionName = "llmgw_runtime_settings";
    private const string CacheKey = "LlmGateway:RuntimeSettings:Global";
    private static readonly TimeSpan CacheExpiration = TimeSpan.FromMinutes(5);

    private readonly IMongoCollection<AppSettings> _settings;
    private readonly MongoDbContext? _mapDb;
    private readonly IMemoryCache _cache;
    private readonly IConfiguration _configuration;
    private readonly ILogger<GatewayAppSettingsService> _logger;

    public GatewayAppSettingsService(
        LlmGatewayDataContext gatewayDb,
        MongoDbContext? mapDb,
        IMemoryCache cache,
        IConfiguration configuration,
        ILogger<GatewayAppSettingsService> logger)
    {
        _settings = gatewayDb.Database.GetCollection<AppSettings>(CollectionName);
        _mapDb = mapDb;
        _cache = cache;
        _configuration = configuration;
        _logger = logger;
    }

    public async Task<AppSettings> GetSettingsAsync(CancellationToken ct = default)
    {
        if (_cache.TryGetValue<AppSettings>(CacheKey, out var cached))
            return cached!;

        var settings = await _settings.Find(x => x.Id == "global").FirstOrDefaultAsync(ct);
        if (settings is null)
        {
            var seed = await TryBootstrapFromMapAsync(ct) ?? CreateDefaults();
            var update = Builders<AppSettings>.Update
                .SetOnInsert(x => x.Id, "global")
                .SetOnInsert(x => x.EnablePromptCache, seed.EnablePromptCache)
                .SetOnInsert(x => x.RequestBodyMaxChars, seed.RequestBodyMaxChars)
                .SetOnInsert(x => x.AnswerMaxChars, seed.AnswerMaxChars)
                .SetOnInsert(x => x.ErrorMaxChars, seed.ErrorMaxChars)
                .SetOnInsert(x => x.UpdatedAt, seed.UpdatedAt);
            var filter = Builders<AppSettings>.Filter.Eq(x => x.Id, "global");
            settings = await _settings.FindOneAndUpdateAsync(
                filter,
                update,
                new FindOneAndUpdateOptions<AppSettings, AppSettings>
                {
                    IsUpsert = true,
                    ReturnDocument = ReturnDocument.After,
                },
                ct);
        }

        _cache.Set(CacheKey, settings, CacheExpiration);
        return settings;
    }

    public async Task RefreshAsync(CancellationToken ct = default)
    {
        _cache.Remove(CacheKey);
        await GetSettingsAsync(ct);
    }

    private async Task<AppSettings?> TryBootstrapFromMapAsync(CancellationToken ct)
    {
        if (_mapDb is null || !_configuration.GetValue("LlmGateway:RuntimeSettings:BootstrapFromMap", true))
            return null;

        var timeoutSeconds = Math.Clamp(
            _configuration.GetValue("LlmGateway:RuntimeSettings:MapBootstrapTimeoutSeconds", 2),
            1,
            5);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
        try
        {
            var source = await _mapDb.AppSettings.Find(x => x.Id == "global").FirstOrDefaultAsync(timeout.Token);
            if (source is null) return null;

            _logger.LogInformation("LLM Gateway runtime settings bootstrapped from MAP non-sensitive fields");
            return CopyGatewayFields(source);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            _logger.LogWarning(
                "LLM Gateway runtime settings MAP bootstrap unavailable; continuing with gateway defaults: {ExceptionType}",
                ex.GetType().Name);
            return null;
        }
    }

    public static AppSettings CopyGatewayFields(AppSettings source) => new()
    {
        Id = "global",
        EnablePromptCache = source.EnablePromptCache,
        RequestBodyMaxChars = source.RequestBodyMaxChars,
        AnswerMaxChars = source.AnswerMaxChars,
        ErrorMaxChars = source.ErrorMaxChars,
        UpdatedAt = DateTime.UtcNow,
    };

    private static AppSettings CreateDefaults() => new()
    {
        Id = "global",
        EnablePromptCache = true,
        UpdatedAt = DateTime.UtcNow,
    };
}

public sealed class GatewayRuntimeSettingsInitializer : IHostedService
{
    private readonly IAppSettingsService _settings;

    public GatewayRuntimeSettingsInitializer(IAppSettingsService settings) => _settings = settings;

    public async Task StartAsync(CancellationToken cancellationToken)
        => await _settings.GetSettingsAsync(cancellationToken);

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
