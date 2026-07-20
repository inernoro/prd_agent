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
        await BackfillInternalTenantAsync(cancellationToken);
        await BackfillServiceKeyDirectoryAsync(cancellationToken);
        var callers = _data.Database.GetCollection<GatewayAppCallerRecord>(AppCallerCollectionName);
        await ConsolidateDuplicateAppCallersAsync(callers, cancellationToken);
        await EnsureBudgetConfigurationIntegrityAsync(callers, cancellationToken);
        await EnsureTenantBudgetConfigurationIntegrityAsync(cancellationToken);

        var indexes = new[]
        {
            new CreateIndexModel<GatewayAppCallerRecord>(
                Builders<GatewayAppCallerRecord>.IndexKeys
                    .Ascending(x => x.TenantId)
                    .Ascending(x => x.AppCallerCode)
                    .Ascending(x => x.RequestType),
                new CreateIndexOptions
                {
                    Name = "uniq_llmgw_app_callers_tenant_code_request_type",
                    Unique = true,
                    Collation = GatewayAppCallerIdentity.Collation,
                }),
            new CreateIndexModel<GatewayAppCallerRecord>(
                Builders<GatewayAppCallerRecord>.IndexKeys
                    .Ascending(x => x.TenantId)
                    .Ascending(x => x.Status)
                    .Ascending(x => x.RequestType)
                    .Descending(x => x.LastSeenAt),
                new CreateIndexOptions { Name = "idx_llmgw_app_callers_tenant_status_type_seen" }),
        };
        await callers.Indexes.CreateManyAsync(indexes, cancellationToken);
        await DropIndexIfPresentAsync(callers, "uniq_llmgw_app_callers_code_request_type", cancellationToken);
        await DropIndexIfPresentAsync(callers, "idx_llmgw_app_callers_status_type_seen", cancellationToken);
        await EnsureGovernanceIndexesAsync(cancellationToken);
        _logger.LogInformation("[LlmGatewayData] appCaller、日志与治理索引已就绪");
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task BackfillInternalTenantAsync(CancellationToken ct)
    {
        var configured = _configuration["LlmGateway:InternalTenantId"]?.Trim();
        var tenantId = string.IsNullOrWhiteSpace(configured)
            ? GatewayTenantDefaults.InternalTenantId
            : configured;
        var collections = new[]
        {
            "llmgw_app_callers",
            "llmgw_model_pools",
            "llmgw_platforms",
            "llmgw_models",
            "llmgw_logical_models",
            "llmgw_model_offerings",
            "llmgw_model_exchanges",
            "llmgw_service_keys",
            "llmgw_service_key_rate_windows",
            "llmgw_prompt_policies",
            "llmrequestlogs",
            "llmshadow_comparisons",
            "llmgw_operation_audits",
            "llmgw_login_audits",
            "llmgw_lifecycle_runs",
            "llmgw_app_caller_rate_windows",
            "llmgw_tenant_rate_windows",
            "llmgw_budget_months",
            "llmgw_budget_reservations",
            "llmgw_request_executions",
            "llmgw_multipart_objects",
            "llmgw_provider_concurrency_slots",
            "llmgw_runtime_settings",
            "llmgw_asset_registry",
            "llmgw_cost_reconciliations",
            "llmgw_cost_import_scope_locks",
            "llmgw_legacy_key_cutovers",
            "llmgw_legacy_key_usage",
        };

        var missingTenant = Builders<BsonDocument>.Filter.Or(
            Builders<BsonDocument>.Filter.Exists("TenantId", false),
            Builders<BsonDocument>.Filter.Eq("TenantId", ""),
            Builders<BsonDocument>.Filter.Eq("TenantId", BsonNull.Value));
        foreach (var collectionName in collections)
        {
            var collection = _data.Database.GetCollection<BsonDocument>(collectionName);
            await collection.UpdateManyAsync(
                missingTenant,
                Builders<BsonDocument>.Update.Set("TenantId", tenantId),
                cancellationToken: ct);
        }
    }

    private static async Task DropIndexIfPresentAsync<T>(
        IMongoCollection<T> collection,
        string indexName,
        CancellationToken ct)
    {
        var indexes = await (await collection.Indexes.ListAsync(ct)).ToListAsync(ct);
        if (indexes.Any(x => x.GetValue("name", "").AsString == indexName))
            await collection.Indexes.DropOneAsync(indexName, ct);
    }

    private async Task BackfillServiceKeyDirectoryAsync(CancellationToken ct)
    {
        var keys = _data.Database.GetCollection<GatewayServiceKeyRecord>("llmgw_service_keys");
        var directory = _data.Database.GetCollection<GatewayServiceKeyDirectoryRecord>("llmgw_service_key_directory");
        var records = await keys.Find(x => x.TenantId != "" && x.KeyHash != "").ToListAsync(ct);
        foreach (var key in records)
        {
            await directory.ReplaceOneAsync(
                x => x.KeyHash == key.KeyHash,
                new GatewayServiceKeyDirectoryRecord
                {
                    Id = key.Id,
                    KeyHash = key.KeyHash,
                    TenantId = key.TenantId,
                    ServiceKeyId = key.Id,
                    CreatedAt = key.CreatedAt,
                },
                new ReplaceOptions { IsUpsert = true },
                ct);
        }
    }

    private async Task EnsureGovernanceIndexesAsync(CancellationToken ct)
    {
        var logs = _data.Database.GetCollection<BsonDocument>("llmrequestlogs");
        await logs.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys
                    .Ascending("TenantId")
                    .Descending("StartedAt")
                    .Ascending("AppCallerCode")
                    .Ascending("RequestType")
                    .Ascending("GatewayTransport"),
                new CreateIndexOptions { Name = "idx_llmgw_logs_tenant_time_caller_type_transport" }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys
                    .Ascending("TenantId")
                    .Ascending("ReleaseCommit")
                    .Ascending("AppCallerCode")
                    .Descending("StartedAt"),
                new CreateIndexOptions { Name = "idx_llmgw_logs_tenant_release_caller_time" }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys
                    .Ascending("TenantId")
                    .Ascending("RequestId")
                    .Descending("StartedAt"),
                new CreateIndexOptions { Name = "idx_llmgw_logs_tenant_request_time" }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys
                    .Ascending("TenantId")
                    .Ascending("Provider")
                    .Ascending("ProviderRequestId"),
                new CreateIndexOptions { Name = "idx_llmgw_logs_tenant_provider_request" }),
        }, cancellationToken: ct);

        var shadows = _data.Database.GetCollection<BsonDocument>("llmshadow_comparisons");
        await shadows.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys
                    .Ascending("TenantId")
                    .Ascending("ReleaseCommit")
                    .Ascending("AppCallerCode")
                    .Ascending("Kind")
                    .Descending("ComparedAt"),
                new CreateIndexOptions { Name = "idx_llmgw_shadow_tenant_release_caller_kind_time" }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys
                    .Ascending("TenantId")
                    .Ascending("HasCritical")
                    .Ascending("HttpOk")
                    .Descending("ComparedAt"),
                new CreateIndexOptions { Name = "idx_llmgw_shadow_tenant_failure_time" }),
        }, cancellationToken: ct);

        await CreateBsonIndexesAsync("llmgw_operation_audits", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Descending("CreatedAt").Ascending("Action"),
                new CreateIndexOptions { Name = "idx_llmgw_audit_tenant_time_action" }),
        }, ct);
        await CreateBsonIndexesAsync("llmgw_login_audits", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Descending("CreatedAt").Ascending("Success"),
                new CreateIndexOptions { Name = "idx_llmgw_login_audit_tenant_time_success" }),
        }, ct);
        await CreateBsonIndexesAsync("llmgw_map_sso_tickets", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("CodeHash"),
                new CreateIndexOptions { Name = "uniq_llmgw_map_sso_code_hash", Unique = true }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("ExpiresAt"),
                new CreateIndexOptions { Name = "ttl_llmgw_map_sso_expires", ExpireAfter = TimeSpan.Zero }),
        }, ct);
        await CreateBsonIndexesAsync("llmgw_lifecycle_runs", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Descending("StartedAt"),
                new CreateIndexOptions { Name = "idx_llmgw_lifecycle_tenant_started" }),
        }, ct);
        await DropIndexIfPresentAsync(_data.Database.GetCollection<BsonDocument>("llmgw_lifecycle_runs"), "idx_llmgw_lifecycle_started", ct);
        await CreateBsonIndexesAsync("llmgw_app_caller_rate_windows", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys
                    .Ascending("TenantId")
                    .Ascending("AppCallerCode")
                    .Ascending("RequestType")
                    .Ascending("WindowStart"),
                new CreateIndexOptions { Name = "idx_llmgw_rate_window_tenant_caller_type_time" }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("ExpiresAt"),
                new CreateIndexOptions { Name = "ttl_llmgw_rate_windows", ExpireAfter = TimeSpan.Zero }),
        }, ct);
        var tenantRateWindows = _data.Database.GetCollection<GatewayTenantRateWindowRecord>("llmgw_tenant_rate_windows");
        await tenantRateWindows.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<GatewayTenantRateWindowRecord>(
                Builders<GatewayTenantRateWindowRecord>.IndexKeys
                    .Ascending(x => x.TenantId)
                    .Ascending(x => x.WindowStart),
                new CreateIndexOptions { Name = "uniq_llmgw_tenant_rate_window", Unique = true }),
            new CreateIndexModel<GatewayTenantRateWindowRecord>(
                Builders<GatewayTenantRateWindowRecord>.IndexKeys.Ascending(x => x.ExpiresAt),
                new CreateIndexOptions { Name = "ttl_llmgw_tenant_rate_windows", ExpireAfter = TimeSpan.Zero }),
        }, cancellationToken: ct);
        await CreateBsonIndexesAsync("llmgw_model_pools", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("ModelType").Ascending("IsDefaultForType").Ascending("Priority"),
                new CreateIndexOptions { Name = "idx_llmgw_pool_tenant_type_default_priority" }),
        }, ct);
        await CreateBsonIndexesAsync("llmgw_platforms", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("Enabled").Ascending("Name"),
                new CreateIndexOptions { Name = "idx_llmgw_platform_tenant_enabled_name" }),
        }, ct);
        await CreateBsonIndexesAsync("llmgw_models", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("PlatformId").Ascending("Enabled").Ascending("Priority"),
                new CreateIndexOptions { Name = "idx_llmgw_model_tenant_platform_enabled_priority" }),
        }, ct);
        await CreateBsonIndexesAsync("llmgw_logical_models", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("PublicIdNormalized"),
                new CreateIndexOptions { Name = "uniq_llmgw_logical_model_tenant_public_id", Unique = true }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("ModelType").Ascending("Enabled").Ascending("DisplayOrder"),
                new CreateIndexOptions { Name = "idx_llmgw_logical_model_tenant_type_enabled_order" }),
        }, ct);
        await CreateBsonIndexesAsync("llmgw_model_offerings", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("LogicalModelId").Ascending("TargetKind").Ascending("TargetId"),
                new CreateIndexOptions { Name = "uniq_llmgw_offering_tenant_logical_target", Unique = true }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("LogicalModelId").Ascending("Enabled").Ascending("HealthStatus").Ascending("Priority"),
                new CreateIndexOptions { Name = "idx_llmgw_offering_tenant_logical_route" }),
        }, ct);
        await CreateBsonIndexesAsync("llmgw_model_exchanges", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("NameNormalized"),
                new CreateIndexOptions<BsonDocument>
                {
                    Name = "uniq_llmgw_exchange_tenant_name",
                    Unique = true,
                    PartialFilterExpression = Builders<BsonDocument>.Filter.And(
                        Builders<BsonDocument>.Filter.Type("TenantId", BsonType.String),
                        Builders<BsonDocument>.Filter.Type("NameNormalized", BsonType.String)),
                }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("Enabled").Ascending("Name"),
                new CreateIndexOptions { Name = "idx_llmgw_exchange_tenant_enabled_name" }),
        }, ct);

        await CreateBsonIndexesAsync("llmgw_cost_reconciliations", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("Provider").Ascending("ExternalRecordId"),
                new CreateIndexOptions { Name = "uniq_llmgw_cost_tenant_provider_external", Unique = true }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("Provider").Ascending("ProviderRequestId"),
                new CreateIndexOptions<BsonDocument>
                {
                    Name = "uniq_llmgw_cost_tenant_provider_request",
                    Unique = true,
                    PartialFilterExpression = Builders<BsonDocument>.Filter.And(
                        Builders<BsonDocument>.Filter.Eq("Granularity", "request"),
                        Builders<BsonDocument>.Filter.Type("ProviderRequestId", BsonType.String)),
                }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("TeamId").Ascending("ServiceKeyId").Descending("BilledAt"),
                new CreateIndexOptions { Name = "idx_llmgw_cost_tenant_key_billed" }),
        }, ct);
        await CreateBsonIndexesAsync("llmgw_cost_import_scope_locks", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("Provider").Ascending("TeamId"),
                new CreateIndexOptions { Name = "uniq_llmgw_cost_import_lock_tenant_provider_team", Unique = true }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("ExpiresAt"),
                new CreateIndexOptions { Name = "ttl_llmgw_cost_import_scope_locks", ExpireAfter = TimeSpan.Zero }),
        }, ct);
        await CreateBsonIndexesAsync("llmgw_legacy_key_cutovers", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId"),
                new CreateIndexOptions { Name = "uniq_llmgw_legacy_cutover_tenant", Unique = true }),
        }, ct);
        await CreateBsonIndexesAsync("llmgw_legacy_key_usage", new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys
                    .Ascending("TenantId")
                    .Ascending("SourceSystem")
                    .Ascending("AppCallerCode")
                    .Ascending("IngressProtocol"),
                new CreateIndexOptions { Name = "uniq_llmgw_legacy_usage_tenant_identity", Unique = true }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Descending("LastSeenAt"),
                new CreateIndexOptions { Name = "idx_llmgw_legacy_usage_tenant_seen" }),
        }, ct);

        var budgets = _data.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months");
        await budgets.Indexes.CreateOneAsync(new CreateIndexModel<GatewayBudgetMonthRecord>(
            Builders<GatewayBudgetMonthRecord>.IndexKeys
                .Ascending(x => x.TenantId)
                .Ascending(x => x.AppCallerCode)
                .Ascending(x => x.RequestType)
                .Ascending(x => x.MonthStart),
            new CreateIndexOptions { Name = "uniq_llmgw_budget_tenant_month", Unique = true }), cancellationToken: ct);
        await DropIndexIfPresentAsync(budgets, "uniq_llmgw_budget_month", ct);

        var reservations = _data.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations");
        await reservations.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<GatewayBudgetReservationRecord>(
                Builders<GatewayBudgetReservationRecord>.IndexKeys
                    .Ascending(x => x.TenantId)
                    .Ascending(x => x.AppCallerCode)
                    .Ascending(x => x.RequestType)
                    .Ascending(x => x.RequestId),
                new CreateIndexOptions { Name = "uniq_llmgw_budget_tenant_reservation_request", Unique = true }),
            new CreateIndexModel<GatewayBudgetReservationRecord>(
                Builders<GatewayBudgetReservationRecord>.IndexKeys
                    .Ascending(x => x.TenantId)
                    .Ascending(x => x.Status)
                    .Ascending(x => x.ExpiresAt),
                new CreateIndexOptions { Name = "idx_llmgw_budget_tenant_reservation_status_expiry" }),
        }, cancellationToken: ct);
        await DropIndexIfPresentAsync(reservations, "uniq_llmgw_budget_reservation_request", ct);

        var executions = _data.Database.GetCollection<GatewayRequestExecutionRecord>("llmgw_request_executions");
        await executions.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<GatewayRequestExecutionRecord>(
                Builders<GatewayRequestExecutionRecord>.IndexKeys
                    .Ascending(x => x.TenantId)
                    .Ascending(x => x.AppCallerCode)
                    .Ascending(x => x.RequestId)
                    .Ascending(x => x.Operation),
                new CreateIndexOptions { Name = "uniq_llmgw_execution_tenant_request", Unique = true }),
            new CreateIndexModel<GatewayRequestExecutionRecord>(
                Builders<GatewayRequestExecutionRecord>.IndexKeys.Ascending(x => x.ExpiresAt),
                new CreateIndexOptions { Name = "ttl_llmgw_request_executions", ExpireAfter = TimeSpan.Zero }),
        }, cancellationToken: ct);
        await DropIndexIfPresentAsync(executions, "uniq_llmgw_execution_request", ct);

        var serviceKeys = _data.Database.GetCollection<GatewayServiceKeyRecord>("llmgw_service_keys");
        await serviceKeys.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<GatewayServiceKeyRecord>(
                Builders<GatewayServiceKeyRecord>.IndexKeys.Ascending(x => x.TenantId).Ascending(x => x.KeyHash),
                new CreateIndexOptions { Name = "uniq_llmgw_service_key_tenant_hash", Unique = true }),
            new CreateIndexModel<GatewayServiceKeyRecord>(
                Builders<GatewayServiceKeyRecord>.IndexKeys.Ascending(x => x.TenantId).Descending(x => x.CreatedAt),
                new CreateIndexOptions { Name = "idx_llmgw_service_key_tenant_created" }),
            new CreateIndexModel<GatewayServiceKeyRecord>(
                Builders<GatewayServiceKeyRecord>.IndexKeys
                    .Ascending(x => x.TenantId)
                    .Ascending(x => x.TeamId)
                    .Ascending(x => x.ClientCode)
                    .Ascending(x => x.Environment)
                    .Ascending(x => x.Purpose),
                // 存量库已有不含 Purpose 的同名索引；用途扩维必须用新名字做纯加法迁移。
                new CreateIndexOptions { Name = "idx_llmgw_service_key_tenant_workload_purpose" }),
        }, cancellationToken: ct);
        await DropIndexIfPresentAsync(serviceKeys, "uniq_llmgw_service_key_hash", ct);
        var serviceKeyRateWindows = _data.Database.GetCollection<GatewayServiceKeyRateWindowRecord>("llmgw_service_key_rate_windows");
        await serviceKeyRateWindows.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<GatewayServiceKeyRateWindowRecord>(
                Builders<GatewayServiceKeyRateWindowRecord>.IndexKeys
                    .Ascending(x => x.TenantId)
                    .Ascending(x => x.ServiceKeyId)
                    .Ascending(x => x.WindowStart),
                new CreateIndexOptions { Name = "uniq_llmgw_service_key_rate_tenant_window", Unique = true }),
            new CreateIndexModel<GatewayServiceKeyRateWindowRecord>(
                Builders<GatewayServiceKeyRateWindowRecord>.IndexKeys.Ascending(x => x.ExpiresAt),
                new CreateIndexOptions { Name = "ttl_llmgw_service_key_rate_windows", ExpireAfter = TimeSpan.Zero }),
        }, cancellationToken: ct);
        var serviceKeyDirectory = _data.Database.GetCollection<GatewayServiceKeyDirectoryRecord>("llmgw_service_key_directory");
        await serviceKeyDirectory.Indexes.CreateOneAsync(new CreateIndexModel<GatewayServiceKeyDirectoryRecord>(
            Builders<GatewayServiceKeyDirectoryRecord>.IndexKeys.Ascending(x => x.KeyHash),
            new CreateIndexOptions { Name = "uniq_llmgw_service_key_directory_hash", Unique = true }), cancellationToken: ct);

        var promptPolicies = _data.Database.GetCollection<BsonDocument>("llmgw_prompt_policies");
        await promptPolicies.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("AppCallerCode").Ascending("RequestType").Ascending("Version"),
                new CreateIndexOptions { Name = "uniq_llmgw_prompt_policy_tenant_caller_type_version", Unique = true }),
            new CreateIndexModel<BsonDocument>(
                Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("TeamId").Ascending("UpdatedAt"),
                new CreateIndexOptions { Name = "idx_llmgw_prompt_policy_tenant_team_updated" }),
        }, cancellationToken: ct);

        var multipart = _data.Database.GetCollection<GatewayMultipartObjectRecord>("llmgw_multipart_objects");
        await multipart.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<GatewayMultipartObjectRecord>(
                Builders<GatewayMultipartObjectRecord>.IndexKeys.Ascending(x => x.TenantId).Ascending(x => x.RefKey),
                new CreateIndexOptions { Name = "uniq_llmgw_multipart_tenant_ref", Unique = true }),
            new CreateIndexModel<GatewayMultipartObjectRecord>(
                Builders<GatewayMultipartObjectRecord>.IndexKeys.Ascending(x => x.TenantId).Ascending(x => x.Status).Ascending(x => x.ExpiresAt),
                new CreateIndexOptions { Name = "idx_llmgw_multipart_tenant_status_expiry" }),
        }, cancellationToken: ct);
        await DropIndexIfPresentAsync(multipart, "uniq_llmgw_multipart_ref", ct);
        await DropIndexIfPresentAsync(multipart, "idx_llmgw_multipart_status_expiry", ct);

        var concurrencySlots = _data.Database.GetCollection<GatewayProviderConcurrencySlotRecord>("llmgw_provider_concurrency_slots");
        await concurrencySlots.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<GatewayProviderConcurrencySlotRecord>(
                Builders<GatewayProviderConcurrencySlotRecord>.IndexKeys
                    .Ascending(x => x.TenantId)
                    .Ascending(x => x.ResourceKey)
                    .Ascending(x => x.Slot),
                new CreateIndexOptions { Name = "uniq_llmgw_provider_tenant_concurrency_slot", Unique = true }),
            new CreateIndexModel<GatewayProviderConcurrencySlotRecord>(
                Builders<GatewayProviderConcurrencySlotRecord>.IndexKeys.Ascending(x => x.ExpiresAt),
                new CreateIndexOptions { Name = "ttl_llmgw_provider_concurrency_slot", ExpireAfter = TimeSpan.Zero }),
        }, cancellationToken: ct);
        await DropIndexIfPresentAsync(concurrencySlots, "uniq_llmgw_provider_concurrency_slot", ct);

        var offeringRateWindows = _data.Database.GetCollection<GatewayOfferingRateWindowRecord>("llmgw_offering_rate_windows");
        await offeringRateWindows.Indexes.CreateManyAsync(new[]
        {
            new CreateIndexModel<GatewayOfferingRateWindowRecord>(
                Builders<GatewayOfferingRateWindowRecord>.IndexKeys
                    .Ascending(x => x.TenantId)
                    .Ascending(x => x.OfferingId)
                    .Ascending(x => x.WindowStart),
                new CreateIndexOptions { Name = "uniq_llmgw_offering_tenant_rate_window", Unique = true }),
            new CreateIndexModel<GatewayOfferingRateWindowRecord>(
                Builders<GatewayOfferingRateWindowRecord>.IndexKeys.Ascending(x => x.ExpiresAt),
                new CreateIndexOptions { Name = "ttl_llmgw_offering_rate_window", ExpireAfter = TimeSpan.Zero }),
        }, cancellationToken: ct);

        _logger.LogInformation("[LlmGatewayData] 非破坏性治理索引已就绪；TTL 索引由 lifecycle worker 在持久化 dry-run 后启用");
    }

    public async Task EnsureRetentionTtlIndexesAsync(CancellationToken ct)
    {
        if (!_configuration.GetValue("LlmGateway:Retention:EnableTtlIndexes", false))
        {
            _logger.LogWarning("[LlmGatewayData] TTL 删除索引未启用；lifecycle 保持 dry-run");
            return;
        }
        var logDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:RequestLogDays", 90));
        var shadowDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:ShadowDays", 30));
        var auditDays = Math.Max(1, _configuration.GetValue("LlmGateway:Retention:AuditDays", 180));
        await EnsureTtlIndexAsync("llmrequestlogs", "StartedAt", "ttl_llmgw_logs_started", TimeSpan.FromDays(logDays), ct);
        await EnsureTtlIndexAsync("llmshadow_comparisons", "ComparedAt", "ttl_llmgw_shadow_compared", TimeSpan.FromDays(shadowDays), ct);
        await EnsureTtlIndexAsync("llmgw_operation_audits", "CreatedAt", "ttl_llmgw_operation_audits", TimeSpan.FromDays(auditDays), ct);
        await EnsureTtlIndexAsync("llmgw_login_audits", "CreatedAt", "ttl_llmgw_login_audits", TimeSpan.FromDays(auditDays), ct);
        await EnsureTtlIndexAsync("llmgw_lifecycle_runs", "StartedAt", "ttl_llmgw_lifecycle_runs", TimeSpan.FromDays(auditDays), ct);
        _logger.LogWarning("[LlmGatewayData] TTL 删除索引已启用 logs={LogDays}d shadow={ShadowDays}d audit={AuditDays}d", logDays, shadowDays, auditDays);
    }

    private async Task EnsureTtlIndexAsync(
        string collectionName,
        string fieldName,
        string indexName,
        TimeSpan expiry,
        CancellationToken ct)
    {
        var collection = _data.Database.GetCollection<BsonDocument>(collectionName);
        var existing = await (await collection.Indexes.ListAsync(ct)).ToListAsync(ct);
        var current = existing.FirstOrDefault(x => x.GetValue("name", "").AsString == indexName);
        var seconds = (long)expiry.TotalSeconds;
        if (current is not null && current.TryGetValue("expireAfterSeconds", out var value) && value.ToInt64() == seconds)
            return;

        if (current is not null)
        {
            try
            {
                await _data.Database.RunCommandAsync<BsonDocument>(new BsonDocument
                {
                    { "collMod", collectionName },
                    { "index", new BsonDocument { { "name", indexName }, { "expireAfterSeconds", seconds } } },
                }, cancellationToken: ct);
                return;
            }
            catch (MongoCommandException ex)
            {
                _logger.LogWarning(ex, "[LlmGatewayData] collMod TTL 失败，重建索引 collection={Collection} index={Index}", collectionName, indexName);
                await collection.Indexes.DropOneAsync(indexName, ct);
            }
        }

        await collection.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(
            Builders<BsonDocument>.IndexKeys.Ascending(fieldName),
            new CreateIndexOptions { Name = indexName, ExpireAfter = expiry }), cancellationToken: ct);
    }

    private async Task CreateBsonIndexesAsync(
        string collectionName,
        IEnumerable<CreateIndexModel<BsonDocument>> indexes,
        CancellationToken ct)
    {
        await _data.Database.GetCollection<BsonDocument>(collectionName)
            .Indexes.CreateManyAsync(indexes, cancellationToken: ct);
    }

    private async Task EnsureBudgetConfigurationIntegrityAsync(
        IMongoCollection<GatewayAppCallerRecord> callers,
        CancellationToken ct)
    {
        var fb = Builders<GatewayAppCallerRecord>.Filter;
        var monthlyWithoutReservation = fb.Gt(x => x.MonthlyBudgetUsd, 0)
                                        & (fb.Eq(x => x.BudgetReservationUsd, null)
                                           | fb.Lte(x => x.BudgetReservationUsd, 0));
        var reservationWithoutMonthly = fb.Gt(x => x.BudgetReservationUsd, 0)
                                        & (fb.Eq(x => x.MonthlyBudgetUsd, null)
                                           | fb.Lte(x => x.MonthlyBudgetUsd, 0));
        FilterDefinition<GatewayAppCallerRecord> reservationExceedsMonthly =
            new BsonDocumentFilterDefinition<GatewayAppCallerRecord>(new BsonDocument(
                "$expr",
                new BsonDocument("$gt", new BsonArray { "$BudgetReservationUsd", "$MonthlyBudgetUsd" })));
        var invalid = await callers.Find(fb.Or(
                monthlyWithoutReservation,
                reservationWithoutMonthly,
                reservationExceedsMonthly))
            .Project(x => new { x.AppCallerCode, x.RequestType })
            .Limit(20)
            .ToListAsync(ct);
        if (invalid.Count == 0) return;

        var identities = string.Join(", ", invalid.Select(x => $"{x.AppCallerCode}::{x.RequestType}"));
        _logger.LogCritical(
            "[LlmGatewayData] 检测到无效预算配置，拒绝启动 serving；必须成对配置 MonthlyBudgetUsd 与 BudgetReservationUsd，且单次预占不能超过月预算。Callers={Callers}",
            identities);
        throw new InvalidOperationException(
            $"APP_CALLER_BUDGET_MIGRATION_REQUIRED: {identities}");
    }

    private async Task EnsureTenantBudgetConfigurationIntegrityAsync(CancellationToken ct)
    {
        var tenants = _data.Database.GetCollection<GatewayTenantGovernanceRecord>("llmgw_tenants");
        var fb = Builders<GatewayTenantGovernanceRecord>.Filter;
        var monthlyWithoutReservation = fb.Gt(x => x.MonthlyBudgetUsd, 0)
                                        & (fb.Eq(x => x.BudgetReservationUsd, null)
                                           | fb.Lte(x => x.BudgetReservationUsd, 0));
        var reservationWithoutMonthly = fb.Gt(x => x.BudgetReservationUsd, 0)
                                        & (fb.Eq(x => x.MonthlyBudgetUsd, null)
                                           | fb.Lte(x => x.MonthlyBudgetUsd, 0));
        FilterDefinition<GatewayTenantGovernanceRecord> reservationExceedsMonthly =
            new BsonDocumentFilterDefinition<GatewayTenantGovernanceRecord>(new BsonDocument(
                "$expr",
                new BsonDocument("$gt", new BsonArray { "$BudgetReservationUsd", "$MonthlyBudgetUsd" })));
        var invalid = await tenants.Find(fb.Or(
                monthlyWithoutReservation,
                reservationWithoutMonthly,
                reservationExceedsMonthly))
            .Project(x => x.Id)
            .Limit(20)
            .ToListAsync(ct);
        if (invalid.Count == 0) return;

        var identities = string.Join(", ", invalid);
        _logger.LogCritical(
            "[LlmGatewayData] 检测到无效租户预算配置，拒绝启动 serving。Tenants={Tenants}",
            identities);
        throw new InvalidOperationException($"TENANT_BUDGET_MIGRATION_REQUIRED: {identities}");
    }

    private async Task ConsolidateDuplicateAppCallersAsync(
        IMongoCollection<GatewayAppCallerRecord> callers,
        CancellationToken ct)
    {
        var records = await callers.Find(_ => true).ToListAsync(ct);
        var duplicateGroups = records
            .Where(x => !string.IsNullOrWhiteSpace(x.AppCallerCode) && !string.IsNullOrWhiteSpace(x.RequestType))
            .GroupBy(
                x => (x.TenantId, x.AppCallerCode.Trim(), x.RequestType.Trim()),
                TenantAppCallerTupleComparer.OrdinalIgnoreCase)
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
                .Set(x => x.AppCallerCode, group.Key.Item2)
                .Set(x => x.RequestType, group.Key.Item3)
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
                    { "TenantId", group.Key.Item1 },
                    { "AppCallerCode", group.Key.Item2 },
                    { "RequestType", group.Key.Item3 },
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

            await callers.UpdateOneAsync(x => x.TenantId == group.Key.Item1 && x.Id == survivor.Id, update, cancellationToken: ct);
            var deleteResult = await callers.DeleteManyAsync(x => x.TenantId == group.Key.Item1 && duplicateIds.Contains(x.Id), ct);

            var audits = _data.Database.GetCollection<BsonDocument>(OperationAuditCollectionName);
            await audits.InsertOneAsync(new BsonDocument
            {
                { "_id", Guid.NewGuid().ToString("N") },
                { "TenantId", group.Key.Item1 },
                { "Action", "app_caller.deduplicate" },
                { "TargetType", "llmgw_app_caller" },
                { "TargetId", survivor.Id },
                { "TargetName", $"{group.Key.Item2}::{group.Key.Item3}" },
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
                group.Key.Item2,
                group.Key.Item3,
                survivor.Id,
                deleteResult.DeletedCount);
        }
    }

    private sealed class TenantAppCallerTupleComparer : IEqualityComparer<(string, string, string)>
    {
        public static TenantAppCallerTupleComparer OrdinalIgnoreCase { get; } = new();

        public bool Equals((string, string, string) x, (string, string, string) y)
            => string.Equals(x.Item1, y.Item1, StringComparison.OrdinalIgnoreCase)
               && string.Equals(x.Item2, y.Item2, StringComparison.OrdinalIgnoreCase)
               && string.Equals(x.Item3, y.Item3, StringComparison.OrdinalIgnoreCase);

        public int GetHashCode((string, string, string) obj)
            => HashCode.Combine(
                StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item1),
                StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item2),
                StringComparer.OrdinalIgnoreCase.GetHashCode(obj.Item3));
    }
}
