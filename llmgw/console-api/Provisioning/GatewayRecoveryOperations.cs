using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;
using PrdAgent.LlmGw.Models;

namespace PrdAgent.LlmGw.Provisioning;

public static class GatewayRecoveryKinds
{
    public const string TenantCreate = "tenant-create";
    public const string MemberCreate = "member-create";
    public const string OwnerMutation = "owner-mutation";
}

[BsonIgnoreExtraElements]
public sealed class GatewayRecoveryOperation
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Kind { get; set; } = string.Empty;
    public string Status { get; set; } = "pending";
    public string TenantId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string TeamId { get; set; } = string.Empty;
    public string MembershipId { get; set; } = string.Empty;
    public long ExpectedMembershipVersion { get; set; }
    public string TargetRole { get; set; } = string.Empty;
    public string TargetStatus { get; set; } = string.Empty;
    public List<string> TargetTeamIds { get; set; } = new();
    public DateTime LeaseExpiresAt { get; set; }
    public string? RepairToken { get; set; }
    public long RepairGeneration { get; set; }
    public string? Detail { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public enum OwnerRemovalResult
{
    Removed,
    LastOwner,
    NotActiveOwner,
}

public sealed record OwnerRemovalDecision(OwnerRemovalResult Result, long Generation);

public static class TenantOwnerAuthority
{
    public static async Task BackfillAsync(
        IMongoCollection<LlmGwTenant> tenants,
        IMongoCollection<LlmGwMembership> memberships)
    {
        var pending = await tenants.Find(x => !x.OwnerAuthorityInitialized).ToListAsync(CancellationToken.None);
        foreach (var tenant in pending)
        {
            var ownerIds = await memberships.Find(x =>
                    x.TenantId == tenant.Id
                    && x.Role == LlmGwTenantRoles.Owner
                    && x.Status == "active")
                .Project(x => x.Id)
                .ToListAsync(CancellationToken.None);
            await tenants.UpdateOneAsync(
                x => x.Id == tenant.Id && !x.OwnerAuthorityInitialized,
                Builders<LlmGwTenant>.Update
                    .Set(x => x.ActiveOwnerMembershipIds, ownerIds.Distinct(StringComparer.Ordinal).ToList())
                    .Set(x => x.OwnerAuthorityInitialized, true)
                    .Set(x => x.OwnerFenceGeneration, Math.Max(1, tenant.OwnerFenceGeneration))
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
        }
    }

    public static bool IsEffectiveOwner(LlmGwTenant tenant, LlmGwMembership membership)
        => membership.Role != LlmGwTenantRoles.Owner
           || tenant.OwnerAuthorityInitialized
           && tenant.ActiveOwnerMembershipIds.Contains(membership.Id, StringComparer.Ordinal);

    public static async Task<long> AddAsync(
        IMongoCollection<LlmGwTenant> tenants,
        string tenantId,
        string membershipId)
    {
        var fb = Builders<LlmGwTenant>.Filter;
        var updated = await tenants.FindOneAndUpdateAsync(
            fb.And(
                fb.Eq(x => x.Id, tenantId),
                fb.Eq(x => x.OwnerAuthorityInitialized, true),
                fb.Not(fb.AnyEq(x => x.ActiveOwnerMembershipIds, membershipId))),
            Builders<LlmGwTenant>.Update
                .AddToSet(x => x.ActiveOwnerMembershipIds, membershipId)
                .Inc(x => x.OwnerFenceGeneration, 1)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            new FindOneAndUpdateOptions<LlmGwTenant> { ReturnDocument = ReturnDocument.After },
            CancellationToken.None);
        if (updated is not null) return updated.OwnerFenceGeneration;

        var current = await tenants.Find(x => x.Id == tenantId && x.OwnerAuthorityInitialized)
            .FirstOrDefaultAsync(CancellationToken.None)
            ?? throw new InvalidOperationException("租户 owner 权威状态不存在");
        if (!current.ActiveOwnerMembershipIds.Contains(membershipId, StringComparer.Ordinal))
            throw new InvalidOperationException("无法写入租户 owner 权威状态");
        return current.OwnerFenceGeneration;
    }

    public static async Task<OwnerRemovalDecision> TryRemoveAsync(
        IMongoCollection<LlmGwTenant> tenants,
        string tenantId,
        string membershipId)
    {
        var filter = new MongoDB.Driver.BsonDocumentFilterDefinition<LlmGwTenant>(new MongoDB.Bson.BsonDocument
        {
            { "_id", tenantId },
            { "OwnerAuthorityInitialized", true },
            { "ActiveOwnerMembershipIds", membershipId },
            { "$expr", new MongoDB.Bson.BsonDocument("$gt", new MongoDB.Bson.BsonArray
                {
                    new MongoDB.Bson.BsonDocument("$size", new MongoDB.Bson.BsonDocument("$ifNull", new MongoDB.Bson.BsonArray { "$ActiveOwnerMembershipIds", new MongoDB.Bson.BsonArray() })),
                    1,
                }) },
        });
        var updated = await tenants.FindOneAndUpdateAsync(
            filter,
            Builders<LlmGwTenant>.Update
                .Pull(x => x.ActiveOwnerMembershipIds, membershipId)
                .Inc(x => x.OwnerFenceGeneration, 1)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            new FindOneAndUpdateOptions<LlmGwTenant> { ReturnDocument = ReturnDocument.After },
            CancellationToken.None);
        if (updated is not null)
            return new OwnerRemovalDecision(OwnerRemovalResult.Removed, updated.OwnerFenceGeneration);

        var current = await tenants.Find(x => x.Id == tenantId && x.OwnerAuthorityInitialized)
            .FirstOrDefaultAsync(CancellationToken.None)
            ?? throw new InvalidOperationException("租户 owner 权威状态不存在");
        return current.ActiveOwnerMembershipIds.Contains(membershipId, StringComparer.Ordinal)
            ? new OwnerRemovalDecision(OwnerRemovalResult.LastOwner, current.OwnerFenceGeneration)
            : new OwnerRemovalDecision(OwnerRemovalResult.NotActiveOwner, current.OwnerFenceGeneration);
    }

    public static async Task RestoreAsync(
        IMongoCollection<LlmGwTenant> tenants,
        string tenantId,
        string membershipId)
        => _ = await AddAsync(tenants, tenantId, membershipId);

    public static async Task DiscardProvisionedOwnerAsync(
        IMongoCollection<LlmGwTenant> tenants,
        string tenantId,
        string membershipId)
        => await tenants.UpdateOneAsync(
            x => x.Id == tenantId && x.ActiveOwnerMembershipIds.Contains(membershipId),
            Builders<LlmGwTenant>.Update
                .Pull(x => x.ActiveOwnerMembershipIds, membershipId)
                .Inc(x => x.OwnerFenceGeneration, 1)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
}

public static class GatewayRecoveryOperations
{
    private static readonly TimeSpan OperationLease = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(30);

    public static GatewayRecoveryOperation New(
        string kind,
        string tenantId,
        string userId = "",
        string teamId = "",
        string membershipId = "")
        => new()
        {
            Kind = kind,
            TenantId = tenantId,
            UserId = userId,
            TeamId = teamId,
            MembershipId = membershipId,
            LeaseExpiresAt = DateTime.UtcNow.Add(OperationLease),
        };

    public static async Task CompleteAsync(
        IMongoCollection<GatewayRecoveryOperation> operations,
        string operationId,
        string status,
        string? detail = null)
        => await operations.UpdateOneAsync(
            x => x.Id == operationId && x.Status == "pending",
            Builders<GatewayRecoveryOperation>.Update
                .Set(x => x.Status, status)
                .Set(x => x.Detail, detail)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

    public static async Task<IAsyncDisposable> StartHeartbeatAsync(
        IMongoCollection<GatewayRecoveryOperation> operations,
        string operationId,
        TimeSpan? heartbeatInterval = null)
    {
        var heartbeat = new GatewayRecoveryHeartbeat(
            operations,
            operationId,
            heartbeatInterval ?? HeartbeatInterval,
            OperationLease);
        await heartbeat.StartAsync();
        return heartbeat;
    }

    public static async Task<int> RepairExpiredAsync(IMongoDatabase database)
    {
        var operations = database.GetCollection<GatewayRecoveryOperation>("llmgw_recovery_operations");
        var repaired = 0;
        while (true)
        {
            var now = DateTime.UtcNow;
            var token = Guid.NewGuid().ToString("N");
            var expiredFilter = Builders<GatewayRecoveryOperation>.Filter.And(
                Builders<GatewayRecoveryOperation>.Filter.In(x => x.Status, new[] { "pending", "repairing" }),
                Builders<GatewayRecoveryOperation>.Filter.Lte(x => x.LeaseExpiresAt, now));
            var operation = await operations.FindOneAndUpdateAsync(
                expiredFilter,
                Builders<GatewayRecoveryOperation>.Update
                    .Set(x => x.Status, "repairing")
                    .Set(x => x.RepairToken, token)
                    .Set(x => x.LeaseExpiresAt, now.Add(OperationLease))
                    .Inc(x => x.RepairGeneration, 1)
                    .Set(x => x.UpdatedAt, now),
                new FindOneAndUpdateOptions<GatewayRecoveryOperation, GatewayRecoveryOperation>
                {
                    Sort = Builders<GatewayRecoveryOperation>.Sort.Ascending(x => x.CreatedAt),
                    ReturnDocument = ReturnDocument.After,
                },
                CancellationToken.None);
            if (operation is null) break;

            try
            {
                var detail = operation.Kind switch
                {
                    GatewayRecoveryKinds.TenantCreate => await RepairTenantCreateAsync(database, operation),
                    GatewayRecoveryKinds.MemberCreate => await RepairMemberCreateAsync(database, operation),
                    GatewayRecoveryKinds.OwnerMutation => await RepairOwnerMutationAsync(database, operation),
                    _ => "unknown-operation-kind",
                };
                await operations.UpdateOneAsync(
                    x => x.Id == operation.Id && x.Status == "repairing" && x.RepairToken == token,
                    Builders<GatewayRecoveryOperation>.Update
                        .Set(x => x.Status, detail == "unknown-operation-kind" ? "repair-failed" : "repaired")
                        .Set(x => x.Detail, detail)
                        .Set(x => x.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
                repaired++;
            }
            catch (Exception ex)
            {
                await operations.UpdateOneAsync(
                    x => x.Id == operation.Id && x.Status == "repairing" && x.RepairToken == token,
                    Builders<GatewayRecoveryOperation>.Update
                        .Set(x => x.Status, "pending")
                        .Set(x => x.Detail, $"repair-error:{ex.GetType().Name}")
                        .Set(x => x.LeaseExpiresAt, DateTime.UtcNow.Add(OperationLease))
                        .Set(x => x.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
            }
        }
        return repaired;
    }

    private static async Task<string> RepairTenantCreateAsync(IMongoDatabase database, GatewayRecoveryOperation operation)
    {
        await database.GetCollection<LlmGwMembership>("llmgw_memberships")
            .DeleteOneAsync(x => x.Id == operation.MembershipId && x.TenantId == operation.TenantId, CancellationToken.None);
        await database.GetCollection<LlmGwTeam>("llmgw_teams")
            .DeleteOneAsync(x => x.Id == operation.TeamId && x.TenantId == operation.TenantId, CancellationToken.None);
        await database.GetCollection<LlmGwTenant>("llmgw_tenants")
            .DeleteOneAsync(x => x.Id == operation.TenantId, CancellationToken.None);
        await database.GetCollection<LlmGwUser>("llmgw_console_users").UpdateOneAsync(
            x => x.Id == operation.UserId,
            Builders<LlmGwUser>.Update
                .Pull(x => x.TenantIds, operation.TenantId)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
        await database.GetCollection<MongoDB.Bson.BsonDocument>("llmgw_model_pool_types")
            .DeleteManyAsync(Builders<MongoDB.Bson.BsonDocument>.Filter.Eq("TenantId", operation.TenantId), CancellationToken.None);
        await database.GetCollection<MongoDB.Bson.BsonDocument>("llmgw_model_pools")
            .DeleteManyAsync(Builders<MongoDB.Bson.BsonDocument>.Filter.And(
                Builders<MongoDB.Bson.BsonDocument>.Filter.Eq("TenantId", operation.TenantId),
                Builders<MongoDB.Bson.BsonDocument>.Filter.Eq("ManagedByRegistry", true)), CancellationToken.None);
        return "tenant-create-rolled-back";
    }

    private static async Task<string> RepairMemberCreateAsync(IMongoDatabase database, GatewayRecoveryOperation operation)
    {
        await TenantOwnerAuthority.DiscardProvisionedOwnerAsync(
            database.GetCollection<LlmGwTenant>("llmgw_tenants"),
            operation.TenantId,
            operation.MembershipId);
        await database.GetCollection<LlmGwMembership>("llmgw_memberships")
            .DeleteOneAsync(x => x.Id == operation.MembershipId && x.TenantId == operation.TenantId && x.UserId == operation.UserId, CancellationToken.None);
        await database.GetCollection<LlmGwUser>("llmgw_console_users")
            .DeleteOneAsync(x => x.Id == operation.UserId, CancellationToken.None);
        return "member-create-rolled-back";
    }

    private static async Task<string> RepairOwnerMutationAsync(IMongoDatabase database, GatewayRecoveryOperation operation)
    {
        var tenants = database.GetCollection<LlmGwTenant>("llmgw_tenants");
        var memberships = database.GetCollection<LlmGwMembership>("llmgw_memberships");
        var membership = await memberships.Find(x => x.Id == operation.MembershipId && x.TenantId == operation.TenantId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (membership is null) return "owner-mutation-membership-missing";

        var targetIsOwner = operation.TargetRole == LlmGwTenantRoles.Owner && operation.TargetStatus == "active";
        if (targetIsOwner)
        {
            if (membership.Version == operation.ExpectedMembershipVersion + 1
                && membership.Role == operation.TargetRole
                && membership.Status == operation.TargetStatus)
            {
                await TenantOwnerAuthority.AddAsync(tenants, operation.TenantId, operation.MembershipId);
                return "owner-promotion-completed";
            }
            return "owner-promotion-rolled-back";
        }

        var tenant = await tenants.Find(x => x.Id == operation.TenantId).FirstOrDefaultAsync(CancellationToken.None);
        if (tenant is null) return "owner-mutation-tenant-missing";
        if (tenant.ActiveOwnerMembershipIds.Contains(operation.MembershipId, StringComparer.Ordinal))
            return "owner-removal-not-committed";
        if (membership.Version == operation.ExpectedMembershipVersion)
        {
            membership.Role = operation.TargetRole;
            membership.Status = operation.TargetStatus;
            membership.TeamIds = operation.TargetTeamIds;
            membership.Version++;
            membership.UpdatedAt = DateTime.UtcNow;
            var replaced = await memberships.ReplaceOneAsync(
                x => x.Id == membership.Id && x.TenantId == membership.TenantId && x.Version == operation.ExpectedMembershipVersion,
                membership,
                cancellationToken: CancellationToken.None);
            if (replaced.ModifiedCount == 1) return "owner-removal-completed";
            membership = await memberships.Find(x => x.Id == operation.MembershipId && x.TenantId == operation.TenantId)
                .FirstOrDefaultAsync(CancellationToken.None);
            if (membership is null) return "owner-mutation-membership-missing";
        }
        if (membership.Role == operation.TargetRole && membership.Status == operation.TargetStatus)
            return "owner-removal-already-completed";

        await TenantOwnerAuthority.RestoreAsync(tenants, operation.TenantId, operation.MembershipId);
        return "owner-removal-conflict-restored";
    }
}

internal sealed class GatewayRecoveryHeartbeat : IAsyncDisposable
{
    private readonly IMongoCollection<GatewayRecoveryOperation> _operations;
    private readonly string _operationId;
    private readonly TimeSpan _interval;
    private readonly TimeSpan _lease;
    private readonly CancellationTokenSource _stop = new();
    private Task _runTask = Task.CompletedTask;

    public GatewayRecoveryHeartbeat(
        IMongoCollection<GatewayRecoveryOperation> operations,
        string operationId,
        TimeSpan interval,
        TimeSpan lease)
    {
        if (interval <= TimeSpan.Zero || interval >= lease)
            throw new ArgumentOutOfRangeException(nameof(interval), "心跳间隔必须大于零且小于 recovery lease");
        _operations = operations;
        _operationId = operationId;
        _interval = interval;
        _lease = lease;
    }

    public async Task StartAsync()
    {
        if (!await RenewAsync())
            throw new InvalidOperationException("recovery operation 不存在或已被其他修复器接管");
        _runTask = RunAsync();
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        await _runTask;
        _stop.Dispose();
    }

    private async Task RunAsync()
    {
        using var timer = new PeriodicTimer(_interval);
        try
        {
            while (await timer.WaitForNextTickAsync(_stop.Token))
            {
                try
                {
                    if (!await RenewAsync()) return;
                }
                catch (Exception) when (_stop.IsCancellationRequested)
                {
                    return;
                }
                catch when (!_stop.IsCancellationRequested)
                {
                    // Mongo 短暂不可用时保留下一次续租机会；业务写入仍由调用链自行失败并补偿。
                }
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested)
        {
        }
    }

    private async Task<bool> RenewAsync()
    {
        var now = DateTime.UtcNow;
        var result = await _operations.UpdateOneAsync(
            x => x.Id == _operationId && x.Status == "pending" && x.RepairToken == null,
            Builders<GatewayRecoveryOperation>.Update
                .Set(x => x.LeaseExpiresAt, now.Add(_lease))
                .Set(x => x.UpdatedAt, now),
            cancellationToken: CancellationToken.None);
        return result.MatchedCount == 1;
    }
}
