using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.LlmGateway;

public sealed record GatewayProviderConcurrencyAdmission(
    bool Allowed,
    string ErrorCode,
    GatewayProviderConcurrencyLease? Lease)
{
    public static GatewayProviderConcurrencyAdmission Allow(GatewayProviderConcurrencyLease? lease = null)
        => new(true, string.Empty, lease);

    public static GatewayProviderConcurrencyAdmission Reject(string errorCode)
        => new(false, errorCode, null);
}

public sealed class GatewayProviderConcurrencyCoordinator
{
    private const string CollectionName = "llmgw_provider_concurrency_slots";
    private readonly LlmGatewayDataContext _data;
    private readonly ILogger<GatewayProviderConcurrencyCoordinator> _logger;
    private readonly string _ownerInstance;

    public GatewayProviderConcurrencyCoordinator(
        LlmGatewayDataContext data,
        ILogger<GatewayProviderConcurrencyCoordinator> logger)
    {
        _data = data;
        _logger = logger;
        _ownerInstance = Environment.GetEnvironmentVariable("HOSTNAME")
                         ?? Environment.MachineName
                         ?? "unknown";
    }

    public async Task<GatewayProviderConcurrencyAdmission> AcquireAsync(
        ModelResolutionResult resolution,
        int timeoutSeconds,
        CancellationToken ct)
    {
        var platformId = resolution.ActualPlatformId?.Trim();
        var model = resolution.ActualModel?.Trim();
        if (string.IsNullOrWhiteSpace(platformId) || string.IsNullOrWhiteSpace(model))
            return GatewayProviderConcurrencyAdmission.Allow();

        var limits = new List<(string ResourceKey, int Limit)>();
        if (resolution.PlatformMaxConcurrency is > 0)
            limits.Add(($"platform:{platformId}", resolution.PlatformMaxConcurrency.Value));
        if (resolution.ModelMaxConcurrency is > 0)
            limits.Add(($"model:{platformId}:{model}", resolution.ModelMaxConcurrency.Value));
        if (limits.Count == 0)
            return GatewayProviderConcurrencyAdmission.Allow();

        var leaseId = Guid.NewGuid().ToString("N");
        var expiresAt = DateTime.UtcNow.AddSeconds(Math.Clamp(timeoutSeconds + 60, 90, 3660));
        var acquired = new List<string>(limits.Count);
        foreach (var (resourceKey, limit) in limits)
        {
            var slotId = await TryAcquireSlotAsync(resourceKey, Math.Clamp(limit, 1, 10000), leaseId, expiresAt, ct);
            if (slotId is null)
            {
                await ReleaseAsync(leaseId, acquired, CancellationToken.None);
                _logger.LogWarning(
                    "[GatewayConcurrency] provider concurrency exhausted resource={ResourceKey} limit={Limit} platform={Platform} model={Model}",
                    resourceKey,
                    limit,
                    platformId,
                    model);
                return GatewayProviderConcurrencyAdmission.Reject("PROVIDER_CONCURRENCY_EXHAUSTED");
            }
            acquired.Add(slotId);
        }

        return GatewayProviderConcurrencyAdmission.Allow(
            new GatewayProviderConcurrencyLease(this, leaseId, acquired));
    }

    private async Task<string?> TryAcquireSlotAsync(
        string resourceKey,
        int limit,
        string leaseId,
        DateTime expiresAt,
        CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var collection = _data.Database.GetCollection<GatewayProviderConcurrencySlotRecord>(CollectionName);
        for (var slot = 0; slot < limit; slot++)
        {
            var slotId = $"{Sha256Hex(resourceKey)}:{slot}";
            var filter = Builders<GatewayProviderConcurrencySlotRecord>.Filter.Eq(x => x.Id, slotId)
                         & (Builders<GatewayProviderConcurrencySlotRecord>.Filter.Lte(x => x.ExpiresAt, now)
                            | Builders<GatewayProviderConcurrencySlotRecord>.Filter.Eq(x => x.LeaseId, string.Empty));
            try
            {
                var acquired = await collection.FindOneAndUpdateAsync(
                    filter,
                    Builders<GatewayProviderConcurrencySlotRecord>.Update
                        .SetOnInsert(x => x.Id, slotId)
                        .SetOnInsert(x => x.ResourceKey, resourceKey)
                        .SetOnInsert(x => x.Slot, slot)
                        .Set(x => x.LeaseId, leaseId)
                        .Set(x => x.OwnerInstance, _ownerInstance)
                        .Set(x => x.AcquiredAt, now)
                        .Set(x => x.ExpiresAt, expiresAt),
                    new FindOneAndUpdateOptions<GatewayProviderConcurrencySlotRecord>
                    {
                        IsUpsert = true,
                        ReturnDocument = ReturnDocument.After,
                    },
                    ct);
                if (acquired?.LeaseId == leaseId)
                    return slotId;
            }
            catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
            {
                // Another serving instance claimed this slot between filter evaluation and upsert.
            }
            catch (MongoCommandException ex) when (ex.Code is 11000 or 11001)
            {
                // findAndModify reports the same race as a command error on some Mongo versions.
            }
        }

        return null;
    }

    internal async Task ReleaseAsync(string leaseId, IReadOnlyCollection<string> slotIds, CancellationToken ct)
    {
        if (slotIds.Count == 0) return;
        var collection = _data.Database.GetCollection<GatewayProviderConcurrencySlotRecord>(CollectionName);
        await collection.DeleteManyAsync(
            Builders<GatewayProviderConcurrencySlotRecord>.Filter.In(x => x.Id, slotIds)
            & Builders<GatewayProviderConcurrencySlotRecord>.Filter.Eq(x => x.LeaseId, leaseId),
            ct);
    }

    internal async Task ReleaseSafelyAsync(string leaseId, IReadOnlyCollection<string> slotIds)
    {
        try
        {
            await ReleaseAsync(leaseId, slotIds, CancellationToken.None);
        }
        catch (Exception ex)
        {
            // The slot has a bounded expiry; a cleanup failure must not replace a valid provider response.
            _logger.LogError(ex,
                "[GatewayConcurrency] lease release failed lease={LeaseId}; slot will expire automatically",
                leaseId);
        }
    }

    private static string Sha256Hex(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}

public sealed class GatewayProviderConcurrencyLease : IAsyncDisposable
{
    private readonly GatewayProviderConcurrencyCoordinator _owner;
    private readonly string _leaseId;
    private readonly IReadOnlyCollection<string> _slotIds;
    private int _released;

    internal GatewayProviderConcurrencyLease(
        GatewayProviderConcurrencyCoordinator owner,
        string leaseId,
        IReadOnlyCollection<string> slotIds)
    {
        _owner = owner;
        _leaseId = leaseId;
        _slotIds = slotIds;
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _released, 1) != 0) return;
        await _owner.ReleaseSafelyAsync(_leaseId, _slotIds);
    }
}
