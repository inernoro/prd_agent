using System.Reflection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayRuntimeGovernanceTests
{
    [Fact]
    public async Task ConcurrentBudgetReservations_CannotExceedMonthlyBudget()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.CreateGovernanceIndexesAsync();

        var caller = new GatewayAppCallerRecord
        {
            TenantId = "tenant-a",
            AppCallerCode = "budget-test",
            RequestType = "chat",
            MonthlyBudgetUsd = 1m,
            BudgetReservationUsd = 0.6m,
        };
        var coordinators = Enumerable.Range(0, 8)
            .Select(_ => new GatewayBudgetCoordinator(scope.Context, NullLogger<GatewayBudgetCoordinator>.Instance))
            .ToArray();

        var admissions = await Task.WhenAll(coordinators.Select((coordinator, index) =>
            coordinator.ReserveAsync(caller, $"request-{index}", CancellationToken.None)));

        admissions.Count(x => x.Allowed).ShouldBe(1);
        admissions.Count(x => !x.Allowed && x.ErrorCode == "APP_CALLER_MONTHLY_BUDGET_EXCEEDED").ShouldBe(7);

        var winner = admissions.Single(x => x.Allowed).Lease;
        winner.ShouldNotBeNull();
        await coordinators[0].FinalizeAsync(winner, 200, pipelineThrew: false);

        var month = await scope.Context.Database
            .GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months")
            .Find(_ => true)
            .SingleAsync();
        month.ReservedUsd.ShouldBe(0m);
        month.SpentUsd.ShouldBe(0.6m);
    }

    [Fact]
    public async Task ConcurrentFirstMonthReservations_AllSucceedWhenBudgetHasCapacity()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.CreateGovernanceIndexesAsync();

        var caller = new GatewayAppCallerRecord
        {
            TenantId = "tenant-a",
            AppCallerCode = "budget-month-create-race",
            RequestType = "chat",
            MonthlyBudgetUsd = 1m,
            BudgetReservationUsd = 0.1m,
        };
        var coordinators = Enumerable.Range(0, 8)
            .Select(_ => new GatewayBudgetCoordinator(scope.Context, NullLogger<GatewayBudgetCoordinator>.Instance))
            .ToArray();

        var admissions = await Task.WhenAll(coordinators.Select((coordinator, index) =>
            coordinator.ReserveAsync(caller, $"month-race-{index}", CancellationToken.None)));

        admissions.Count(x => x.Allowed).ShouldBe(8);
        var month = await scope.Context.Database
            .GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months")
            .Find(_ => true)
            .SingleAsync();
        month.ReservedUsd.ShouldBe(0.8m);
        month.SpentUsd.ShouldBe(0m);
    }

    [Fact]
    public async Task ClientFailure_ReleasesBudgetReservation()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.CreateGovernanceIndexesAsync();
        var coordinator = new GatewayBudgetCoordinator(scope.Context, NullLogger<GatewayBudgetCoordinator>.Instance);
        var admission = await coordinator.ReserveAsync(new GatewayAppCallerRecord
        {
            TenantId = "tenant-a",
            AppCallerCode = "client-failure-test",
            RequestType = "chat",
            MonthlyBudgetUsd = 1m,
            BudgetReservationUsd = 0.6m,
        }, "client-failure-request", CancellationToken.None);

        admission.Allowed.ShouldBeTrue();
        admission.Lease.ShouldNotBeNull();
        await coordinator.FinalizeAsync(admission.Lease!, 422, pipelineThrew: false);

        var month = await scope.Context.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months")
            .Find(_ => true)
            .SingleAsync();
        month.ReservedUsd.ShouldBe(0m);
        month.SpentUsd.ShouldBe(0m);
    }

    [Fact]
    public async Task ServerFailure_KeepsBudgetReservationAsUnknown()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.CreateGovernanceIndexesAsync();
        var coordinator = new GatewayBudgetCoordinator(scope.Context, NullLogger<GatewayBudgetCoordinator>.Instance);
        var admission = await coordinator.ReserveAsync(new GatewayAppCallerRecord
        {
            TenantId = "tenant-a",
            AppCallerCode = "server-failure-test",
            RequestType = "image-gen",
            MonthlyBudgetUsd = 1m,
            BudgetReservationUsd = 0.6m,
        }, "server-failure-request", CancellationToken.None);

        admission.Allowed.ShouldBeTrue();
        admission.Lease.ShouldNotBeNull();
        await coordinator.FinalizeAsync(admission.Lease!, 503, pipelineThrew: false);

        var month = await scope.Context.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months")
            .Find(_ => true)
            .SingleAsync();
        month.ReservedUsd.ShouldBe(0.6m);
        month.SpentUsd.ShouldBe(0m);
        var reservation = await scope.Context.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations")
            .Find(_ => true)
            .SingleAsync();
        reservation.Status.ShouldBe("unknown");
    }

    [Fact]
    public async Task CancelledUnknownOutcome_KeepsBudgetReservationAsUnknown()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.CreateGovernanceIndexesAsync();
        var coordinator = new GatewayBudgetCoordinator(scope.Context, NullLogger<GatewayBudgetCoordinator>.Instance);
        var admission = await coordinator.ReserveAsync(new GatewayAppCallerRecord
        {
            TenantId = "tenant-a",
            AppCallerCode = "cancelled-unknown-test",
            RequestType = "image-gen",
            MonthlyBudgetUsd = 1m,
            BudgetReservationUsd = 0.6m,
        }, "cancelled-unknown-request", CancellationToken.None);

        admission.Allowed.ShouldBeTrue();
        admission.Lease.ShouldNotBeNull();
        await coordinator.FinalizeAsync(
            admission.Lease!,
            409,
            pipelineThrew: false,
            outcomeUnknown: true);

        var month = await scope.Context.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months")
            .Find(_ => true)
            .SingleAsync();
        month.ReservedUsd.ShouldBe(0.6m);
        month.SpentUsd.ShouldBe(0m);
        var reservation = await scope.Context.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations")
            .Find(_ => true)
            .SingleAsync();
        reservation.Status.ShouldBe("unknown");
        reservation.Detail.ShouldBe("upstream-outcome-unknown");
    }

    [Fact]
    public async Task DuplicateRawRequestId_HasSingleExecutionOwner()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.CreateGovernanceIndexesAsync();

        var stores = Enumerable.Range(0, 8)
            .Select(_ => new GatewayRequestExecutionStore(scope.Context))
            .ToArray();
        var begins = await Task.WhenAll(stores.Select(store => store.BeginAsync(
            "tenant-a",
            "idempotency-test",
            "same-request-id",
            "raw:/v1/images/generations",
            "same-fingerprint",
            CancellationToken.None)));

        begins.Count(x => x.State == GatewayExecutionBeginState.Started).ShouldBe(1);
        begins.Count(x => x.State == GatewayExecutionBeginState.Running).ShouldBe(7);
        var owner = begins.Single(x => x.State == GatewayExecutionBeginState.Started);
        await stores[0].UnknownAsync("tenant-a", owner.ExecutionId, "UPSTREAM_OUTCOME_UNKNOWN", CancellationToken.None);
        var status = await stores[1].GetAsync(
            "tenant-a",
            "idempotency-test",
            "same-request-id",
            "raw:/v1/images/generations",
            CancellationToken.None);
        status.ShouldNotBeNull();
        status.Status.ShouldBe("unknown");
    }

    [Fact]
    public void RawFingerprint_ChangesWhenMultipartFileContentChanges()
    {
        static GatewayRawRequest Request(byte[] content) => new()
        {
            AppCallerCode = "fingerprint-test",
            ModelType = "generation",
            EndpointPath = "/v1/images/edits",
            IsMultipart = true,
            MultipartFields = new Dictionary<string, object> { ["prompt"] = "edit" },
            MultipartFiles = new Dictionary<string, (string FileName, byte[] Content, string MimeType)>
            {
                ["image"] = ("input.png", content, "image/png"),
            },
        };

        var first = GatewayRequestExecutionStore.Fingerprint(Request([1, 2, 3]));
        var second = GatewayRequestExecutionStore.Fingerprint(Request([1, 2, 4]));

        first.ShouldNotBe(second);
    }

    [Fact]
    public async Task OversizedReplaySnapshot_DoesNotFailCompletedUpstreamCall()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.CreateGovernanceIndexesAsync();
        var store = new GatewayRequestExecutionStore(scope.Context);
        var begin = await store.BeginAsync(
            "tenant-a",
            "large-replay-test",
            "large-response-request",
            "openai-images-generation",
            "same-fingerprint",
            CancellationToken.None);
        begin.State.ShouldBe(GatewayExecutionBeginState.Started);

        var oversized = new string('x', GatewayRequestExecutionStore.MaxReplayResponseBytes + 1);
        await store.CompleteAsync("tenant-a", begin.ExecutionId, oversized, CancellationToken.None);

        var replay = await store.BeginAsync(
            "tenant-a",
            "large-replay-test",
            "large-response-request",
            "openai-images-generation",
            "same-fingerprint",
            CancellationToken.None);
        replay.State.ShouldBe(GatewayExecutionBeginState.ReplayUnavailable);
        var stored = await store.GetAsync(
            "tenant-a",
            "large-replay-test",
            "large-response-request",
            "openai-images-generation",
            CancellationToken.None);
        stored.ShouldNotBeNull();
        stored.Status.ShouldBe("completed-unreplayable");
        stored.ResponseJson.ShouldBeNull();
        stored.ErrorCode.ShouldBe("GATEWAY_REPLAY_RESPONSE_TOO_LARGE");
    }

    [Fact]
    public async Task ExpiredPendingReservation_DoesNotDecrementMonthThatWasNeverReserved()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.CreateGovernanceIndexesAsync();

        var monthStart = new DateTime(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        await scope.Context.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months").InsertOneAsync(new GatewayBudgetMonthRecord
        {
            TenantId = "tenant-a",
            AppCallerCode = "pending-test",
            RequestType = "chat",
            MonthStart = monthStart,
            BudgetUsd = 1m,
            ReservedUsd = 0m,
            SpentUsd = 0m,
        });
        await scope.Context.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations").InsertOneAsync(new GatewayBudgetReservationRecord
        {
            TenantId = "tenant-a",
            AppCallerCode = "pending-test",
            RequestType = "chat",
            RequestId = "pending-request",
            MonthStart = monthStart,
            ReservedUsd = 0.6m,
            Status = "pending",
            ExpiresAt = DateTime.UtcNow.AddMinutes(-1),
        });

        var coordinator = new GatewayBudgetCoordinator(scope.Context, NullLogger<GatewayBudgetCoordinator>.Instance);
        await coordinator.ReleaseExpiredAsync(CancellationToken.None);

        var month = await scope.Context.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months")
            .Find(_ => true)
            .SingleAsync();
        month.ReservedUsd.ShouldBe(0m);
    }

    [Fact]
    public async Task ExpiredUnknownReservation_SettlesConservatively()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.CreateGovernanceIndexesAsync();

        var monthStart = new DateTime(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        await scope.Context.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months").InsertOneAsync(new GatewayBudgetMonthRecord
        {
            TenantId = "tenant-a",
            AppCallerCode = "unknown-test",
            RequestType = "image-gen",
            MonthStart = monthStart,
            BudgetUsd = 1m,
            ReservedUsd = 0.6m,
            SpentUsd = 0m,
        });
        var reservation = new GatewayBudgetReservationRecord
        {
            TenantId = "tenant-a",
            AppCallerCode = "unknown-test",
            RequestType = "image-gen",
            RequestId = "unknown-request",
            MonthStart = monthStart,
            ReservedUsd = 0.6m,
            Status = "unknown",
            ExpiresAt = DateTime.UtcNow.AddMinutes(-1),
        };
        await scope.Context.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations")
            .InsertOneAsync(reservation);

        var coordinator = new GatewayBudgetCoordinator(scope.Context, NullLogger<GatewayBudgetCoordinator>.Instance);
        await coordinator.ReleaseExpiredAsync(CancellationToken.None);

        var month = await scope.Context.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months")
            .Find(_ => true)
            .SingleAsync();
        month.ReservedUsd.ShouldBe(0m);
        month.SpentUsd.ShouldBe(0.6m);
        var updated = await scope.Context.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations")
            .Find(x => x.Id == reservation.Id)
            .SingleAsync();
        updated.Status.ShouldBe("settled-unknown-expired");
        updated.SettledUsd.ShouldBe(0.6m);
    }

    [Fact]
    public async Task LifecycleApply_RedactsAndDeletesExpiredDataForEveryTenant()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var now = DateTime.UtcNow;
        var logs = scope.Context.Database.GetCollection<BsonDocument>("llmrequestlogs");
        await logs.InsertManyAsync(new[]
        {
            new BsonDocument
            {
                { "_id", "log-a" },
                { "TenantId", "tenant-a" },
                { "StartedAt", now.AddDays(-10) },
                { "QuestionText", "tenant-a-secret" },
            },
            new BsonDocument
            {
                { "_id", "log-b" },
                { "TenantId", "tenant-b" },
                { "StartedAt", now.AddDays(-10) },
                { "QuestionText", "tenant-b-secret" },
            },
        });
        var multipart = scope.Context.Database.GetCollection<GatewayMultipartObjectRecord>("llmgw_multipart_objects");
        await multipart.InsertManyAsync(new[]
        {
            new GatewayMultipartObjectRecord
            {
                TenantId = "tenant-a",
                RefKey = "tenant-a/expired.bin",
                Status = "stored",
                ExpiresAt = now.AddMinutes(-1),
            },
            new GatewayMultipartObjectRecord
            {
                TenantId = "tenant-b",
                RefKey = "tenant-b/expired.bin",
                Status = "stored",
                ExpiresAt = now.AddMinutes(-1),
            },
        });
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:InternalTenantId"] = "tenant-internal",
            ["LlmGateway:Retention:ApplyChanges"] = "true",
            ["LlmGateway:Retention:EnableTtlIndexes"] = "false",
            ["LlmGateway:Retention:SensitiveBodyDays"] = "1",
        }).Build();
        var storage = new RecordingAssetStorage();
        var worker = new GatewayDataLifecycleWorker(
            scope.Context,
            storage,
            new GatewayBudgetCoordinator(scope.Context, NullLogger<GatewayBudgetCoordinator>.Instance),
            new LlmGatewayDatabaseInitializer(
                scope.Context,
                configuration,
                NullLogger<LlmGatewayDatabaseInitializer>.Instance),
            configuration,
            NullLogger<GatewayDataLifecycleWorker>.Instance);
        var runOnce = typeof(GatewayDataLifecycleWorker).GetMethod(
            "RunOnceAsync",
            BindingFlags.Instance | BindingFlags.NonPublic);
        runOnce.ShouldNotBeNull();

        await (Task)runOnce.Invoke(worker, new object[] { CancellationToken.None })!;

        var updatedLogs = await logs.Find(_ => true).ToListAsync();
        updatedLogs.Count.ShouldBe(2);
        updatedLogs.ShouldAllBe(x => x["RequestBodyRedacted"].AsString == "[retention-redacted]");
        updatedLogs.ShouldAllBe(x => !x.Contains("QuestionText"));
        var updatedMultipart = await multipart.Find(_ => true).ToListAsync();
        updatedMultipart.ShouldAllBe(x => x.Status == "deleted");
        storage.DeletedKeys.OrderBy(x => x).ShouldBe(new[]
        {
            "tenant-a/expired.bin",
            "tenant-b/expired.bin",
        });
        var tenantRuns = await scope.Context.Database.GetCollection<GatewayLifecycleRunRecord>("llmgw_lifecycle_runs")
            .Find(x => x.TenantId == "tenant-a" || x.TenantId == "tenant-b")
            .ToListAsync();
        tenantRuns.Count.ShouldBe(2);
        tenantRuns.ShouldAllBe(x => x.Status == "applied");
        tenantRuns.ShouldAllBe(x => x.RedactedSensitiveLogs == 1 && x.DeletedMultipartObjects == 1);
    }

    [Fact]
    public async Task ScopedKey_RejectsCrossAppCallerAndWritesAudit()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_test_scoped_key";
        var keyRecord = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "test-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            SourceSystem = "external-system",
            AppCallerCodes = ["allowed-caller"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["chat"],
        };
        await InsertServiceKeyAsync(scope.Context, keyRecord);
        var authorizer = new GatewayScopedKeyAuthorizer(scope.Context);

        var allowed = await authorizer.AuthorizeAsync(
            key,
            "legacy-key",
            "external-system",
            "allowed-caller",
            "openai-compatible",
            "chat",
            CancellationToken.None);
        var denied = await authorizer.AuthorizeAsync(
            key,
            "legacy-key",
            "external-system",
            "other-caller",
            "openai-compatible",
            "chat",
            CancellationToken.None);

        allowed.Allowed.ShouldBeTrue();
        allowed.TenantId.ShouldBe("tenant-a");
        denied.Allowed.ShouldBeFalse();
        denied.Authenticated.ShouldBeTrue();
        denied.StatusCode.ShouldBe(403);
        var auditCount = await scope.Context.Database
            .GetCollection<BsonDocument>("llmgw_operation_audits")
            .CountDocumentsAsync(Builders<BsonDocument>.Filter.Eq("Action", "service_key.scope_denied"));
        auditCount.ShouldBe(1);
    }

    [Fact]
    public async Task RequestExecution_SameIdentityIsIsolatedByTenant()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var store = new GatewayRequestExecutionStore(scope.Context);

        var tenantA = await store.BeginAsync("tenant-a", "shared-caller", "shared-request", "raw-submit", "fingerprint-a", CancellationToken.None);
        var tenantB = await store.BeginAsync("tenant-b", "shared-caller", "shared-request", "raw-submit", "fingerprint-b", CancellationToken.None);

        tenantA.State.ShouldBe(GatewayExecutionBeginState.Started);
        tenantB.State.ShouldBe(GatewayExecutionBeginState.Started);
        (await store.GetAsync("tenant-a", "shared-caller", "shared-request", "raw-submit", CancellationToken.None))!.Fingerprint.ShouldBe("fingerprint-a");
        (await store.GetAsync("tenant-b", "shared-caller", "shared-request", "raw-submit", CancellationToken.None))!.Fingerprint.ShouldBe("fingerprint-b");
        (await store.GetAsync("tenant-c", "shared-caller", "shared-request", "raw-submit", CancellationToken.None)).ShouldBeNull();
    }

    [Fact]
    public void CancellationRegistry_SameRequestIdentityIsIsolatedByTenant()
    {
        var registry = new GatewayCancellationRegistry();
        using var tenantA = registry.Register("tenant-a", "shared-caller", "shared-request");
        using var tenantB = registry.Register("tenant-b", "shared-caller", "shared-request");

        registry.Cancel("tenant-a", "shared-caller", "shared-request").ShouldBeTrue();
        tenantA.Token.IsCancellationRequested.ShouldBeTrue();
        tenantB.Token.IsCancellationRequested.ShouldBeFalse();
        registry.Cancel("tenant-c", "shared-caller", "shared-request").ShouldBeFalse();
    }

    [Fact]
    public async Task ScopedKey_EmptyBindingsFailClosed()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_test_empty_binding_key";
        var keyRecord = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "empty-binding-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            SourceSystem = "*",
            AppCallerCodes = [],
            IngressProtocols = [],
            Scopes = [],
        };
        await InsertServiceKeyAsync(scope.Context, keyRecord);
        var authorizer = new GatewayScopedKeyAuthorizer(scope.Context);

        var denied = await authorizer.AuthorizeAsync(
            key,
            "legacy-key",
            "external-system",
            "requested-caller",
            "openai-compatible",
            "invoke",
            CancellationToken.None);

        denied.Allowed.ShouldBeFalse();
        denied.Authenticated.ShouldBeTrue();
        denied.StatusCode.ShouldBe(403);
    }

    [Fact]
    public async Task ScopedInvokeKey_CannotUseProfileTestScope()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_test_invoke_only_key";
        await InsertServiceKeyAsync(scope.Context, new GatewayServiceKeyRecord
            {
                TenantId = "tenant-a",
                Name = "invoke-only",
                KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
                SourceSystem = "external",
                AppCallerCodes = ["profile-caller"],
                IngressProtocols = ["gw-native"],
                Scopes = ["invoke"],
            });
        var authorizer = new GatewayScopedKeyAuthorizer(scope.Context);

        var denied = await authorizer.AuthorizeAsync(
            key,
            "legacy-key",
            "external",
            "profile-caller",
            "gw-native",
            "profile:test",
            CancellationToken.None);

        denied.Allowed.ShouldBeFalse();
        denied.Authenticated.ShouldBeTrue();
        denied.StatusCode.ShouldBe(403);
    }

    private static async Task<TestDatabase?> TryCreateDatabaseAsync()
    {
        var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                               ?? "mongodb://localhost:27017";
        var settings = MongoClientSettings.FromConnectionString(connectionString);
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(2);
        var client = new MongoClient(settings);
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(
                new BsonDocument("ping", 1),
                cancellationToken: cts.Token);
            var databaseName = $"llmgw_governance_test_{Guid.NewGuid():N}";
            return new TestDatabase(client, databaseName, new LlmGatewayDataContext(connectionString, databaseName));
        }
        catch
        {
            return null;
        }
    }

    private static async Task InsertServiceKeyAsync(LlmGatewayDataContext context, GatewayServiceKeyRecord record)
    {
        await context.Database.GetCollection<GatewayServiceKeyRecord>("llmgw_service_keys").InsertOneAsync(record);
        await context.Database.GetCollection<GatewayServiceKeyDirectoryRecord>("llmgw_service_key_directory")
            .InsertOneAsync(new GatewayServiceKeyDirectoryRecord
            {
                KeyHash = record.KeyHash,
                TenantId = record.TenantId,
                ServiceKeyId = record.Id,
            });
    }

    private sealed class RecordingAssetStorage : IAssetStorage
    {
        public List<string> DeletedKeys { get; } = [];

        public Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct, string? domain = null, string? type = null, string? fileName = null, string? extensionHint = null)
            => throw new NotSupportedException();

        public Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
            => throw new NotSupportedException();

        public Task DeleteByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
            => throw new NotSupportedException();

        public string? TryBuildUrlBySha(string sha256, string mime, string? domain = null, string? type = null)
            => throw new NotSupportedException();

        public Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct)
            => throw new NotSupportedException();

        public Task<bool> ExistsAsync(string key, CancellationToken ct)
            => throw new NotSupportedException();

        public Task UploadToKeyAsync(string key, byte[] bytes, string? contentType, CancellationToken ct, string? cacheControl = null)
            => throw new NotSupportedException();

        public string BuildUrlForKey(string key) => throw new NotSupportedException();

        public Task DeleteByKeyAsync(string key, CancellationToken ct)
        {
            DeletedKeys.Add(key);
            return Task.CompletedTask;
        }

        public string BuildSiteKey(string siteId, string filePath) => throw new NotSupportedException();
    }

    private sealed class TestDatabase : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        public TestDatabase(MongoClient client, string databaseName, LlmGatewayDataContext context)
        {
            _client = client;
            _databaseName = databaseName;
            Context = context;
        }

        public LlmGatewayDataContext Context { get; }

        public async Task CreateGovernanceIndexesAsync()
        {
            var months = Context.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months");
            await months.Indexes.CreateOneAsync(new CreateIndexModel<GatewayBudgetMonthRecord>(
                Builders<GatewayBudgetMonthRecord>.IndexKeys
                    .Ascending(x => x.AppCallerCode)
                    .Ascending(x => x.RequestType)
                    .Ascending(x => x.MonthStart),
                new CreateIndexOptions { Unique = true }));
            var reservations = Context.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations");
            await reservations.Indexes.CreateOneAsync(new CreateIndexModel<GatewayBudgetReservationRecord>(
                Builders<GatewayBudgetReservationRecord>.IndexKeys
                    .Ascending(x => x.AppCallerCode)
                    .Ascending(x => x.RequestType)
                    .Ascending(x => x.RequestId),
                new CreateIndexOptions { Unique = true }));
            var executions = Context.Database.GetCollection<GatewayRequestExecutionRecord>("llmgw_request_executions");
            await executions.Indexes.CreateOneAsync(new CreateIndexModel<GatewayRequestExecutionRecord>(
                Builders<GatewayRequestExecutionRecord>.IndexKeys
                    .Ascending(x => x.AppCallerCode)
                    .Ascending(x => x.RequestId)
                    .Ascending(x => x.Operation),
                new CreateIndexOptions { Unique = true }));
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
