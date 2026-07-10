using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// 在 serving 接收流量前收敛 GW 自有数据结构。
/// </summary>
public sealed class LlmGatewayDatabaseInitializer : IHostedService
{
    private const string AppCallerCollectionName = "llmgw_app_callers";
    private const string DuplicateArchiveCollectionName = "llmgw_app_caller_duplicate_archive";
    private const string OperationAuditCollectionName = "llmgw_operation_audits";
    private readonly LlmGatewayDataContext _data;
    private readonly IConfiguration _configuration;
    private readonly ILogger<LlmGatewayDatabaseInitializer> _logger;

    public LlmGatewayDatabaseInitializer(
        LlmGatewayDataContext data,
        IConfiguration configuration,
        ILogger<LlmGatewayDatabaseInitializer> logger)
    {
        _data = data;
        _configuration = configuration;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var callers = _data.Database.GetCollection<GatewayAppCallerRecord>(AppCallerCollectionName);
        await ConsolidateDuplicateAppCallersAsync(callers, cancellationToken);

        var indexes = new[]
        {
            new CreateIndexModel<GatewayAppCallerRecord>(
                Builders<GatewayAppCallerRecord>.IndexKeys
                    .Ascending(x => x.AppCallerCode)
                    .Ascending(x => x.RequestType),
                new CreateIndexOptions
                {
                    Name = "uniq_llmgw_app_callers_code_request_type",
                    Unique = true,
                    Collation = GatewayAppCallerIdentity.Collation,
                }),
            new CreateIndexModel<GatewayAppCallerRecord>(
                Builders<GatewayAppCallerRecord>.IndexKeys
                    .Ascending(x => x.Status)
                    .Ascending(x => x.RequestType)
                    .Descending(x => x.LastSeenAt),
                new CreateIndexOptions { Name = "idx_llmgw_app_callers_status_type_seen" }),
        };
        await callers.Indexes.CreateManyAsync(indexes, cancellationToken);
        await EnsureGovernanceIndexesAsync(cancellationToken);
        _logger.LogInformation("[LlmGatewayData] appCaller、日志与治理索引已就绪");
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task EnsureGovernanceIndexesAsync(CancellationToken ct)
    {
        var logs = _data.Database.GetCollection<BsonDocument>("llmrequestlogs");
        await logs.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys
                    .Descending("StartedAt")
                    .Ascending("AppCallerCode")
                    .Ascending("RequestType")
                    .Ascending("GatewayTransport"),
                new CreateIndexOptions { Name = "idx_llmgw_logs_time_caller_type_transport" }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys
                    .Ascending("ReleaseCommit")
                    .Ascending("AppCallerCode")
                    .Descending("StartedAt"),
                new CreateIndexOptions { Name = "idx_llmgw_logs_release_caller_time" }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys
                    .Ascending("RequestId")
                    .Descending("StartedAt"),
                new CreateIndexOptions { Name = "idx_llmgw_logs_request_time" }),
        }, cancellationToken: ct);

        var shadows = _data.Database.GetCollection<BsonDocument>("llmshadow_comparisons");
        await shadows.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys
                    .Ascending("ReleaseCommit")
                    .Ascending("AppCallerCode")
                    .Ascending("Kind")
                    .Descending("ComparedAt"),
                new CreateIndexOptions { Name = "idx_llmgw_shadow_release_caller_kind_time" }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys
                    .Ascending("HasCritical")
                    .Ascending("HttpOk")
                    .Descending("ComparedAt"),
                new CreateIndexOptions { Name = "idx_llmgw_shadow_failure_time" }),
        }, cancellationToken: ct);

        await CreateBsonIndexesAsync("llmgw_operation_audits", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Descending("CreatedAt").Ascending("Action"),
                new CreateIndexOptions { Name = "idx_llmgw_audit_time_action" }),
        }, ct);
        await CreateBsonIndexesAsync("llmgw_app_caller_rate_windows", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("ExpiresAt"),
                new CreateIndexOptions { Name = "ttl_llmgw_rate_windows", ExpireAfter = TimeSpan.Zero }),
        }, ct);

        var budgets = _data.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months");
        await budgets.Indexes.CreateOneAsync(new CreateIndexModel<GatewayBudgetMonthRecord>(
            Builders<GatewayBudgetMonthRecord>.IndexKeys
                .Ascending(x => x.AppCallerCode)
                .Ascending(x => x.RequestType)
                .Ascending(x => x.MonthStart),
            new CreateIndexOptions { Name = "uniq_llmgw_budget_month", Unique = true }), cancellationToken: ct);

        var reservations = _data.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations");
        await reservations.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<GatewayBudgetReservationRecord>(
                Builders<GatewayBudgetReservationRecord>.IndexKeys
                    .Ascending(x => x.AppCallerCode)
                    .Ascending(x => x.RequestType)
                    .Ascending(x => x.RequestId),
                new CreateIndexOptions { Name = "uniq_llmgw_budget_reservation_request", Unique = true }),
            new CreateIndexModel<GatewayBudgetReservationRecord>(
                Builders<GatewayBudgetReservationRecord>.IndexKeys
                    .Ascending(x => x.Status)
                    .Ascending(x => x.ExpiresAt),
                new CreateIndexOptions { Name = "idx_llmgw_budget_reservation_status_expiry" }),
        }, cancellationToken: ct);

        var executions = _data.Database.GetCollection<GatewayRequestExecutionRecord>("llmgw_request_executions");
        await executions.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<GatewayRequestExecutionRecord>(
                Builders<GatewayRequestExecutionRecord>.IndexKeys
                    .Ascending(x => x.AppCallerCode)
                    .Ascending(x => x.RequestId)
                    .Ascending(x => x.Operation),
                new CreateIndexOptions { Name = "uniq_llmgw_execution_request", Unique = true }),
            new CreateIndexModel<GatewayRequestExecutionRecord>(
                Builders<GatewayRequestExecutionRecord>.IndexKeys.Ascending(x => x.ExpiresAt),
                new CreateIndexOptions { Name = "ttl_llmgw_request_executions", ExpireAfter = TimeSpan.Zero }),
        }, cancellationToken: ct);

        var serviceKeys = _data.Database.GetCollection<GatewayServiceKeyRecord>("llmgw_service_keys");
        await serviceKeys.Indexes.CreateOneAsync(new CreateIndexModel<GatewayServiceKeyRecord>(
            Builders<GatewayServiceKeyRecord>.IndexKeys.Ascending(x => x.KeyHash),
            new CreateIndexOptions { Name = "uniq_llmgw_service_key_hash", Unique = true }), cancellationToken: ct);

        var multipart = _data.Database.GetCollection<GatewayMultipartObjectRecord>("llmgw_multipart_objects");
        await multipart.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<GatewayMultipartObjectRecord>(
                Builders<GatewayMultipartObjectRecord>.IndexKeys.Ascending(x => x.RefKey),
                new CreateIndexOptions { Name = "uniq_llmgw_multipart_ref", Unique = true }),
            new CreateIndexModel<GatewayMultipartObjectRecord>(
                Builders<GatewayMultipartObjectRecord>.IndexKeys.Ascending(x => x.Status).Ascending(x => x.ExpiresAt),
                new CreateIndexOptions { Name = "idx_llmgw_multipart_status_expiry" }),
        }, cancellationToken: ct);

        var concurrencySlots = _data.Database.GetCollection<GatewayProviderConcurrencySlotRecord>("llmgw_provider_concurrency_slots");
        await concurrencySlots.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<GatewayProviderConcurrencySlotRecord>(
                Builders<GatewayProviderConcurrencySlotRecord>.IndexKeys
                    .Ascending(x => x.ResourceKey)
                    .Ascending(x => x.Slot),
                new CreateIndexOptions { Name = "uniq_llmgw_provider_concurrency_slot", Unique = true }),
            new CreateIndexModel<GatewayProviderConcurrencySlotRecord>(
                Builders<GatewayProviderConcurrencySlotRecord>.IndexKeys.Ascending(x => x.ExpiresAt),
                new CreateIndexOptions { Name = "ttl_llmgw_provider_concurrency_slot", ExpireAfter = TimeSpan.Zero }),
        }, cancellationToken: ct);

        if (_configuration.GetValue("LlmGateway:Retention:EnableTtlIndexes", false))
        {
            await EnsureRetentionTtlIndexesAsync(logs, shadows, ct);
        }
        else
        {
            _logger.LogWarning("[LlmGatewayData] TTL 删除索引未启用；先运行生命周期 dry-run，再设置 LlmGateway:Retention:EnableTtlIndexes=true");
        }
    }

    private async Task EnsureRetentionTtlIndexesAsync(
        IMongoCollection<BsonDocument> logs,
        IMongoCollection<BsonDocument> shadows,
        CancellationToken ct)
    {
        var logDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:RequestLogDays", 90));
        var shadowDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:ShadowDays", 30));
        var auditDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:OperationAuditDays", 365));
        await logs.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(
            Builders<BsonDocument>.IndexKeys.Ascending("StartedAt"),
            new CreateIndexOptions { Name = "ttl_llmgw_logs_started", ExpireAfter = TimeSpan.FromDays(logDays) }), cancellationToken: ct);
        await shadows.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(
            Builders<BsonDocument>.IndexKeys.Ascending("ComparedAt"),
            new CreateIndexOptions { Name = "ttl_llmgw_shadow_compared", ExpireAfter = TimeSpan.FromDays(shadowDays) }), cancellationToken: ct);
        await CreateBsonIndexesAsync("llmgw_operation_audits", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("CreatedAt"),
                new CreateIndexOptions { Name = "ttl_llmgw_operation_audits", ExpireAfter = TimeSpan.FromDays(auditDays) }),
        }, ct);
        _logger.LogWarning("[LlmGatewayData] TTL 删除索引已启用 logs={LogDays}d shadow={ShadowDays}d audit={AuditDays}d", logDays, shadowDays, auditDays);
    }

    private async Task CreateBsonIndexesAsync(
        string collectionName,
        IEnumerable<CreateIndexModel<BsonDocument>> indexes,
        CancellationToken ct)
    {
        await _data.Database.GetCollection<BsonDocument>(collectionName)
            .Indexes.CreateManyAsync(indexes, cancellationToken: ct);
    }

    private async Task ConsolidateDuplicateAppCallersAsync(
        IMongoCollection<GatewayAppCallerRecord> callers,
        CancellationToken ct)
    {
        var records = await callers.Find(_ => true).ToListAsync(ct);
        var duplicateGroups = records
            .Where(x => !string.IsNullOrWhiteSpace(x.AppCallerCode) && !string.IsNullOrWhiteSpace(x.RequestType))
            .GroupBy(
                x => (x.AppCallerCode.Trim(), x.RequestType.Trim()),
                StringTupleComparer.OrdinalIgnoreCase)
            .Where(x => x.Count() > 1)
            .ToList();

        foreach (var group in duplicateGroups)
        {
            var ordered = group
                .OrderBy(x => string.Equals(x.Status, "discovered", StringComparison.OrdinalIgnoreCase) ? 1 : 0)
                .ThenByDescending(x => x.UpdatedAt)
                .ThenByDescending(x => x.LastSeenAt)
                .ToList();
            var survivor = ordered[0];
            var duplicates = ordered.Skip(1).ToList();
            var duplicateIds = duplicates.Select(x => x.Id).ToList();
            var protocols = ordered
                .SelectMany(x => x.ObservedIngressProtocols ?? [])
                .Append(survivor.IngressProtocol)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
                .ToList();

            var update = Builders<GatewayAppCallerRecord>.Update
                .Set(x => x.AppCallerCode, group.Key.Item1)
                .Set(x => x.RequestType, group.Key.Item2)
                .Set(x => x.ObservedIngressProtocols, protocols)
                .Set(x => x.TotalSeen, ordered.Sum(x => Math.Max(0, x.TotalSeen)))
                .Set(x => x.FirstSeenAt, ordered.Min(x => x.FirstSeenAt))
                .Set(x => x.LastSeenAt, ordered.Max(x => x.LastSeenAt))
                .Set(x => x.CreatedAt, ordered.Min(x => x.CreatedAt))
                .Set(x => x.UpdatedAt, ordered.Max(x => x.UpdatedAt));

            // Preserve every source document before deleting duplicates. The archive uses the
            // original duplicate id as its own id, so a crash/retry remains idempotent.
            var archive = _data.Database.GetCollection<BsonDocument>(DuplicateArchiveCollectionName);
            foreach (var duplicate in duplicates)
            {
                var archiveDocument = new BsonDocument
                {
                    { "_id", duplicate.Id },
                    { "AppCallerCode", group.Key.Item1 },
                    { "RequestType", group.Key.Item2 },
                    { "SurvivorId", survivor.Id },
                    { "ArchivedAt", DateTime.UtcNow },
                    { "Reason", "duplicate-before-unique-index" },
                    { "Original", duplicate.ToBsonDocument() },
                };
                await archive.ReplaceOneAsync(
                    Builders<BsonDocument>.Filter.Eq("_id", duplicate.Id),
                    archiveDocument,
                    new ReplaceOptions { IsUpsert = true },
                    ct);
            }

            await callers.UpdateOneAsync(x => x.Id == survivor.Id, update, cancellationToken: ct);
            var deleteResult = await callers.DeleteManyAsync(x => duplicateIds.Contains(x.Id), ct);

            var audits = _data.Database.GetCollection<BsonDocument>(OperationAuditCollectionName);
            await audits.InsertOneAsync(new BsonDocument
            {
                { "_id", Guid.NewGuid().ToString("N") },
                { "Action", "app_caller.deduplicate" },
                { "TargetType", "llmgw_app_caller" },
                { "TargetId", survivor.Id },
                { "TargetName", $"{group.Key.Item1}::{group.Key.Item2}" },
                { "ActorUserId", BsonNull.Value },
                { "ActorUsername", "system" },
                { "Success", true },
                { "Reason", "prepare-unique-index" },
                { "Changes", new BsonDocument
                    {
                        { "survivorId", survivor.Id },
                        { "archivedDuplicateIds", new BsonArray(duplicateIds) },
                        { "deletedCount", deleteResult.DeletedCount },
                    }
                },
                { "RemoteIp", BsonNull.Value },
                { "UserAgent", "llmgw-database-initializer" },
                { "CreatedAt", DateTime.UtcNow },
            }, cancellationToken: ct);
            _logger.LogWarning(
                "[LlmGatewayData] 合并重复 appCaller: Code={Code}, RequestType={RequestType}, Survivor={Survivor}, Removed={Removed}",
                group.Key.Item1,
                group.Key.Item2,
                survivor.Id,
                deleteResult.DeletedCount);
        }
    }

    private sealed class StringTupleComparer : IEqualityComparer<(string, string)>
    {
        public static StringTupleComparer OrdinalIgnoreCase { get; } = new();

        public bool Equals((string, string) x, (string, string) y)
            => string.Equals(x.Item1, y.Item1, StringComparison.OrdinalIgnoreCase)
               && string.Equals(x.Item2, y.Item2, StringComparison.OrdinalIgnoreCase);

        public int GetHashCode((string, string) obj)
            => HashCode.Combine(
                StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item1),
                StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item2));
    }
}
