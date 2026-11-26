using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.ModelUpgrades;
using PrdAgent.LlmGw.Mongo;
using PrdAgent.LlmGw.Provisioning;

namespace PrdAgent.LlmGw.ModelAdvisories;

/// <summary>每日更新发现目录。候选只有供选择的信息，不写逻辑模型、线路或默认配置。</summary>
public sealed class ModelAdvisoryCatalogWorker(
    IMongoDatabase gateway, ModelUpgradeDiscovery discovery, IConfiguration configuration,
    string tenantId, ILogger<ModelAdvisoryCatalogWorker> logger) : BackgroundService
{
    public const string Collection = "llmgw_model_advisory_catalog";
    private const string Section = "LlmGateway:ModelAdvisories";
    private static readonly FilterDefinitionBuilder<BsonDocument> Filter = Builders<BsonDocument>.Filter;
    private static readonly UpdateDefinitionBuilder<BsonDocument> Update = Builders<BsonDocument>.Update;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(10));
        do
        {
            if (ModelUpgradeDeploymentAuthority.BlockReason(configuration, Section + ":WorkerEnabled", Section + ":WorkerDeployment") is not null)
                continue;
            try { await RefreshDueProvidersAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogWarning("每日模型候选目录未更新。错误类型 {ErrorType}", ex.GetType().Name); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    public async Task RefreshDueProvidersAsync(CancellationToken ct)
    {
        var configuredIds = (configuration.GetSection(Section + ":ProviderIds").Get<string[]>() ?? [])
            .Where(id => !string.IsNullOrWhiteSpace(id)).Distinct(StringComparer.Ordinal).Take(20).ToArray();
        if (configuredIds.Length == 0) return;
        var providers = await gateway.GetCollection<BsonDocument>("llmgw_platforms")
            .Find(Filter.Eq("TenantId", tenantId) & Filter.Eq("Enabled", true)
                & Filter.In("_id", configuredIds)).ToListAsync(ct);
        foreach (var provider in providers)
            await RefreshProviderAsync(provider, ct);
    }

    private async Task RefreshProviderAsync(BsonDocument provider, CancellationToken ct)
    {
        var snapshots = gateway.GetCollection<BsonDocument>(Collection);
        var providerId = provider.GetStringOrEmpty("_id");
        var key = Filter.Eq("_id", providerId) & Filter.Eq("TenantId", tenantId);
        await snapshots.UpdateOneAsync(key, Update.SetOnInsert("ProviderId", providerId)
            .SetOnInsert("TenantId", tenantId), new UpdateOptions { IsUpsert = true }, ct);

        var now = DateTime.UtcNow;
        var lockToken = Guid.NewGuid().ToString("N");
        var due = !Filter.Exists("NextCheckAt") | Filter.Lte("NextCheckAt", now);
        var unlocked = !Filter.Exists("LeaseUntil") | Filter.Lte("LeaseUntil", now);
        var claimed = await snapshots.UpdateOneAsync(key & due & unlocked,
            Update.Set("LastAttemptAt", now).Set("LeaseUntil", now.AddMinutes(2)).Set("LeaseToken", lockToken), cancellationToken: ct);
        if (claimed.ModifiedCount == 0) return;

        var completed = Update.Set("NextCheckAt", now.AddDays(1)).Unset("LeaseUntil").Unset("LeaseToken");
        try
        {
            var preset = ModelUpgradeDiscovery.RequireOfficial(provider);
            var scope = new ModelUpgradeState { Id = lockToken, TenantId = tenantId, ActorUsername = "model-advisory-schedule" };
            var discovered = await discovery.DiscoverCatalogAsync(scope, provider, catalogRefresh: true, ct);
            var items = discovered
                .Where(model => model.Key.Length is > 0 and <= 200
                    && model.Key.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_' or '.' or ':' or '/' or '+'))
                .OrderByDescending(model => model.Value).ThenBy(model => model.Key, StringComparer.Ordinal)
                .Take(2000).Select(model => new BsonDocument
                {
                    { "ModelId", model.Key },
                    { "Created", model.Value is { } value ? new BsonInt64(value) : BsonNull.Value },
                    { "SuggestedCapabilities", new BsonArray(ProviderPresets.InferCapabilities(model.Key)) },
                }).ToList();
            if (items.Count == 0)
                throw new ModelUpgradeException("EMPTY_CATALOG", "上游目录没有可识别的模型。");
            completed = completed.Set("Provider", preset.Key).Set("Status", "fresh")
                .Set("LastSuccessfulCheckAt", DateTime.UtcNow).Set("Models", new BsonArray(items)).Unset("ErrorCode");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            var code = ex is ModelUpgradeException known ? known.Code : "CATALOG_REFRESH_FAILED";
            completed = completed.Set("Status", "unknown").Set("ErrorCode", code);
            logger.LogWarning("每日模型候选目录保留上次结果。ProviderId={ProviderId} Code={Code}", providerId, code);
        }
        await snapshots.UpdateOneAsync(key & Filter.Eq("LeaseToken", lockToken), completed, cancellationToken: ct);
    }
}
