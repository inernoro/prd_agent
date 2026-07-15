using System.Reflection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.DependencyInjection;
using System.Text.Json.Nodes;
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
    public void PromptPolicy_MergesPrefixRequestAndSuffixInFixedOrder()
    {
        var body = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "user", ["content"] = "question" },
                new JsonObject { ["role"] = "system", ["content"] = "request-system" },
            },
        };

        GatewayPromptPolicyApplier.ApplyToStandardMessages(body, "policy-prefix", "policy-suffix");

        var messages = body["messages"]!.AsArray();
        messages.Count.ShouldBe(2);
        messages[0]!["role"]!.GetValue<string>().ShouldBe("system");
        messages[0]!["content"]!.GetValue<string>().ShouldBe("policy-prefix\n\nrequest-system\n\npolicy-suffix");
        messages[1]!["role"]!.GetValue<string>().ShouldBe("user");
    }

    [Fact]
    public async Task PromptPolicy_RawAndNonChatRequestTypesAreNeverInjected()
    {
        using var services = new ServiceCollection().BuildServiceProvider();
        var body = new JsonObject { ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "keep" }) };
        var request = new GatewayRequest { AppCallerCode = "demo.raw::generation", ModelType = "generation", RequestBody = body, Context = new GatewayRequestContext { TenantId = "tenant-a" } };

        var result = await GatewayPromptPolicyApplier.ApplyAsync(services, request, CancellationToken.None);

        result.Success.ShouldBeTrue();
        result.Request.ShouldBeSameAs(request);
        result.Request.Context!.PromptPolicyId.ShouldBeNull();
    }

    [Fact]
    public async Task PromptPolicy_UsesVerifiedTenantAndTeamAndOnlyStoresMetadataInContext()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.Context.Database.GetCollection<BsonDocument>("llmgw_prompt_policies").InsertOneAsync(new BsonDocument
        {
            { "_id", "policy-a" }, { "TenantId", "tenant-a" }, { "TeamId", "team-a" },
            { "AppCallerCode", "demo.chat::chat" }, { "RequestType", "chat" }, { "Enabled", true }, { "Version", 3 },
            { "SystemPromptPrefix", "tenant={{tenantId}}" }, { "SystemPromptSuffix", "caller={{appCallerCode}}" },
            { "AllowedVariables", new BsonArray { "tenantId", "appCallerCode" } }, { "MaxChars", 200 }, { "PolicyHash", "hash-a" },
        });
        using var services = new ServiceCollection().AddSingleton(scope.Context).BuildServiceProvider();
        var request = new GatewayRequest
        {
            AppCallerCode = "demo.chat::chat", ModelType = "chat",
            RequestBody = new JsonObject { ["messages"] = new JsonArray(new JsonObject { ["role"] = "system", ["content"] = "request" }) },
            Context = new GatewayRequestContext { TenantId = "tenant-a", TeamId = "team-a", SourceSystem = "external" },
        };

        var result = await GatewayPromptPolicyApplier.ApplyAsync(services, request, CancellationToken.None);

        result.Success.ShouldBeTrue();
        result.Request.RequestBody!["messages"]![0]!["content"]!.GetValue<string>().ShouldBe("tenant=tenant-a\n\nrequest\n\ncaller=demo.chat::chat");
        result.Request.Context!.PromptPolicyId.ShouldBe("policy-a");
        result.Request.Context.PromptPolicyVersion.ShouldBe(3);
        result.Request.Context.PromptPolicyHash.ShouldBe("hash-a");
        result.Request.Context.PromptPolicyChars.ShouldBe(37);
    }

    [Fact]
    public async Task PromptPolicy_LatestDisabledVersionDoesNotFallBackToOlderEnabledVersion()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var policies = scope.Context.Database.GetCollection<BsonDocument>("llmgw_prompt_policies");
        await policies.InsertManyAsync(new[]
        {
            new BsonDocument { { "_id", "old-enabled" }, { "TenantId", "tenant-a" }, { "AppCallerCode", "demo.chat::chat" }, { "RequestType", "chat" }, { "Enabled", true }, { "Version", 1 }, { "SystemPromptPrefix", "old" }, { "SystemPromptSuffix", "" }, { "AllowedVariables", new BsonArray() }, { "MaxChars", 200 }, { "PolicyHash", "old-hash" } },
            new BsonDocument { { "_id", "new-disabled" }, { "TenantId", "tenant-a" }, { "AppCallerCode", "demo.chat::chat" }, { "RequestType", "chat" }, { "Enabled", false }, { "Version", 2 }, { "SystemPromptPrefix", "disabled" }, { "SystemPromptSuffix", "" }, { "AllowedVariables", new BsonArray() }, { "MaxChars", 200 }, { "PolicyHash", "new-hash" } },
        });
        using var services = new ServiceCollection().AddSingleton(scope.Context).BuildServiceProvider();
        var request = new GatewayRequest { AppCallerCode = "demo.chat::chat", ModelType = "chat", RequestBody = new JsonObject { ["messages"] = new JsonArray() }, Context = new GatewayRequestContext { TenantId = "tenant-a" } };

        var result = await GatewayPromptPolicyApplier.ApplyAsync(services, request, CancellationToken.None);

        result.Request.ShouldBeSameAs(request);
        result.Request.Context!.PromptPolicyId.ShouldBeNull();
    }
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
        await scope.Context.Database.GetCollection<BsonDocument>("llmgw_tenants").InsertOneAsync(
            new BsonDocument { { "_id", "tenant-c" }, { "Name", "Tenant C" } });
        await scope.Context.Database.GetCollection<BsonDocument>("llmgw_request_executions").InsertOneAsync(
            new BsonDocument
            {
                { "_id", "execution-d" },
                { "TenantId", "tenant-d" },
                { "ExpiresAt", now.AddHours(1) },
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
        var discoveredTenantIds = await scope.Context.Database.GetCollection<GatewayLifecycleRunRecord>("llmgw_lifecycle_runs")
            .Distinct<string>("TenantId", FilterDefinition<GatewayLifecycleRunRecord>.Empty)
            .ToListAsync();
        discoveredTenantIds.ShouldContain("tenant-c");
        discoveredTenantIds.ShouldContain("tenant-d");
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
            ClientCode = "content-agent",
            Environment = "staging",
            KeyPrefix = "gwk_test",
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
            null,
            CancellationToken.None);
        var denied = await authorizer.AuthorizeAsync(
            key,
            "legacy-key",
            "external-system",
            "other-caller",
            "openai-compatible",
            "chat",
            null,
            CancellationToken.None);

        allowed.Allowed.ShouldBeTrue();
        allowed.TenantId.ShouldBe("tenant-a");
        allowed.KeyId.ShouldBe(keyRecord.Id);
        allowed.ClientCode.ShouldBe("content-agent");
        allowed.Environment.ShouldBe("staging");
        allowed.KeyPrefixSnapshot.ShouldBe("gwk_test");
        denied.Allowed.ShouldBeFalse();
        denied.Authenticated.ShouldBeTrue();
        denied.StatusCode.ShouldBe(403);
        var auditCount = await scope.Context.Database
            .GetCollection<BsonDocument>("llmgw_operation_audits")
            .CountDocumentsAsync(Builders<BsonDocument>.Filter.Eq("Action", "service_key.scope_denied"));
        auditCount.ShouldBe(1);
    }

    [Fact]
    public async Task LegacySharedKey_NeverAcceptsExternalSourceAndRecordsInventory()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var authorizer = new GatewayScopedKeyAuthorizer(scope.Context);

        var denied = await authorizer.AuthorizeAsync(
            "legacy-key", "legacy-key", "external", "outside.chat::chat",
            "openai-compatible", "invoke", null, CancellationToken.None);
        var allowed = await authorizer.AuthorizeAsync(
            "legacy-key", "legacy-key", "map", "map.chat::chat",
            "openai-compatible", "invoke", null, CancellationToken.None);

        denied.Allowed.ShouldBeFalse();
        denied.StatusCode.ShouldBe(403);
        denied.ErrorCode.ShouldBe("GATEWAY_LEGACY_KEY_EXTERNAL_FORBIDDEN");
        allowed.Allowed.ShouldBeTrue();
        allowed.LegacySharedKey.ShouldBeTrue();
        var usage = await scope.Context.Database.GetCollection<GatewayLegacyKeyUsageRecord>("llmgw_legacy_key_usage")
            .Find(_ => true)
            .ToListAsync();
        usage.Count.ShouldBe(2);
        usage.Sum(x => x.AllowedCount).ShouldBe(1);
        usage.Sum(x => x.RejectedCount).ShouldBe(1);
        usage.ShouldAllBe(x => x.TenantId == GatewayTenantDefaults.InternalTenantId);
    }

    [Fact]
    public async Task LegacySharedKey_DeadlineAndRevocationFailClosed()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.Context.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers")
            .InsertOneAsync(new GatewayLegacyKeyCutoverRecord
            {
                TenantId = GatewayTenantDefaults.InternalTenantId,
                Status = "observing",
                DeadlineAt = DateTime.UtcNow.AddMinutes(-1),
                AllowedAppCallerCodes = ["map.chat::chat"],
            });

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            "legacy-key", "legacy-key", "map", "map.chat::chat",
            "openai-compatible", "invoke", null, CancellationToken.None);

        result.Allowed.ShouldBeFalse();
        result.StatusCode.ShouldBe(401);
        result.ErrorCode.ShouldBe("GATEWAY_LEGACY_KEY_REVOKED");
    }

    [Fact]
    public async Task LegacySharedKey_ReadOnlyPreflightWorksDuringCutoverButHonorsDeadline()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var cutovers = scope.Context.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers");
        await cutovers.InsertOneAsync(new GatewayLegacyKeyCutoverRecord
        {
            TenantId = GatewayTenantDefaults.InternalTenantId,
            Status = "observing",
            DeadlineAt = DateTime.UtcNow.AddMinutes(5),
            AllowedAppCallerCodes = ["map.chat::chat"],
        });
        var authorizer = new GatewayScopedKeyAuthorizer(scope.Context);

        var routeProbe = await authorizer.AuthorizeAsync(
            "legacy-key", "legacy-key", "external", string.Empty,
            "gw-native", GatewayLegacyProbeScopes.Route, null, CancellationToken.None);

        routeProbe.Allowed.ShouldBeTrue();
        var usage = await scope.Context.Database.GetCollection<GatewayLegacyKeyUsageRecord>("llmgw_legacy_key_usage")
            .Find(_ => true)
            .SingleAsync();
        usage.SourceSystem.ShouldBe("map");
        usage.AppCallerCode.ShouldBe("llmgw.legacy-preflight::route");
        usage.LastDecision.ShouldBe("read-only-preflight-allowed");

        await cutovers.UpdateOneAsync(
            x => x.TenantId == GatewayTenantDefaults.InternalTenantId,
            Builders<GatewayLegacyKeyCutoverRecord>.Update.Set(x => x.DeadlineAt, DateTime.UtcNow.AddMinutes(-1)));
        var expiredProbe = await authorizer.AuthorizeAsync(
            "legacy-key", "legacy-key", "external", string.Empty,
            "gw-native", GatewayLegacyProbeScopes.Readiness, null, CancellationToken.None);

        expiredProbe.Allowed.ShouldBeFalse();
        expiredProbe.StatusCode.ShouldBe(401);
        expiredProbe.ErrorCode.ShouldBe("GATEWAY_LEGACY_KEY_REVOKED");
    }

    [Fact]
    public async Task ScopedMapKey_ReadOnlyPreflightUsesKeyIdentityAndNormalServiceKeyScope()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        const string key = "llmgw_scoped_route_probe_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "map-runtime-probe",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            KeyPrefix = "gwk_probe",
            SourceSystem = "map",
            ClientCode = "map-runtime",
            Environment = "production",
            Purpose = "runtime",
            AppCallerCodes = ["weekly-report::chat"],
            IngressProtocols = ["gw-native"],
            Scopes = ["route:read"],
        };
        await InsertServiceKeyAsync(scope.Context, record);

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key, "legacy-key", "external", string.Empty,
            "gw-native", GatewayLegacyProbeScopes.Route, null, CancellationToken.None);

        result.Allowed.ShouldBeTrue();
        result.LegacySharedKey.ShouldBeFalse();
    }

    [Fact]
    public async Task ScopedSuccessorKey_ReadOnlyPreflightDoesNotIncrementCutoverEvidence()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        const string key = "llmgw_scoped_successor_probe_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "map-runtime-probe",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            KeyPrefix = "gwk_probe",
            SourceSystem = "map",
            ClientCode = "map-runtime",
            Environment = "production",
            Purpose = "runtime",
            AppCallerCodes = ["weekly-report::chat"],
            IngressProtocols = ["gw-native"],
            Scopes = ["route:read"],
        };
        await InsertServiceKeyAsync(scope.Context, record);
        await scope.Context.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers")
            .InsertOneAsync(new GatewayLegacyKeyCutoverRecord
            {
                TenantId = "tenant-a",
                Status = "observing",
                AllowedAppCallerCodes = ["weekly-report::chat"],
                SuccessorServiceKeyIds = [record.Id],
                RequiredIngressProtocols = ["gw-native"],
                RequiredSuccessorObservations = 1,
            });

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key, "legacy-key", "map", "weekly-report::chat",
            "gw-native", GatewayLegacyProbeScopes.Route, null, CancellationToken.None);

        result.Allowed.ShouldBeTrue();
        var cutover = await scope.Context.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers")
            .Find(x => x.TenantId == "tenant-a")
            .SingleAsync();
        cutover.SuccessorObservedCount.ShouldBe(0);
        cutover.SuccessorObservationCounts.ContainsKey(record.Id).ShouldBeFalse();
        cutover.LastSuccessorUsedAt.ShouldBeNull();
    }

    [Fact]
    public async Task ScopedSuccessorKey_IncrementsDualKeyObservationWithoutChangingIdentity()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        const string key = "llmgw_successor_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "map-runtime",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            KeyPrefix = "gwk_success",
            SourceSystem = "map",
            ClientCode = "map-runtime",
            Environment = "production",
            Purpose = "runtime",
            AppCallerCodes = ["map.chat::chat"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
        };
        await InsertServiceKeyAsync(scope.Context, record);
        await scope.Context.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers")
            .InsertOneAsync(new GatewayLegacyKeyCutoverRecord
            {
                TenantId = "tenant-a",
                Status = "observing",
                AllowedAppCallerCodes = ["map.chat::chat"],
                SuccessorServiceKeyIds = [record.Id, "unused-successor"],
                RequiredIngressProtocols = ["openai-compatible"],
                RequiredSuccessorObservations = 2,
            });

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key, "legacy-key", "map", "map.chat::chat",
            "openai-compatible", "invoke", null, CancellationToken.None);
        result.Allowed.ShouldBeTrue();
        var deadline = DateTime.UtcNow.AddSeconds(2);
        GatewayLegacyKeyCutoverRecord? cutover;
        do
        {
            cutover = await scope.Context.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers")
                .Find(x => x.TenantId == "tenant-a")
                .SingleAsync();
            if (cutover.SuccessorObservedCount >= 1) break;
            await Task.Delay(20);
        } while (DateTime.UtcNow < deadline);
        cutover!.SuccessorObservedCount.ShouldBe(1);
        cutover.SuccessorObservationCounts[record.Id].ShouldBe(1);
        cutover.SuccessorObservationCounts.ContainsKey("unused-successor").ShouldBeFalse();
        cutover.LastSuccessorUsedAt.ShouldNotBeNull();
    }

    [Fact]
    public async Task NonProductionScopedKey_DoesNotIncrementLegacySuccessorObservation()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        const string key = "llmgw_nonprod_successor_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "map-test",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            KeyPrefix = "gwk_nonprod",
            SourceSystem = "map",
            ClientCode = "map-test",
            Environment = "test",
            Purpose = "runtime",
            AppCallerCodes = ["map.chat::chat"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
        };
        await InsertServiceKeyAsync(scope.Context, record);
        await scope.Context.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers")
            .InsertOneAsync(new GatewayLegacyKeyCutoverRecord
            {
                TenantId = "tenant-a",
                Status = "observing",
                AllowedAppCallerCodes = ["map.chat::chat"],
                SuccessorServiceKeyIds = [record.Id],
                RequiredIngressProtocols = ["openai-compatible"],
                RequiredSuccessorObservations = 1,
            });

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key, "legacy-key", "map", "map.chat::chat",
            "openai-compatible", "invoke", null, CancellationToken.None);

        result.Allowed.ShouldBeTrue();
        var cutover = await scope.Context.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers")
            .Find(x => x.TenantId == "tenant-a")
            .SingleAsync();
        cutover.SuccessorObservedCount.ShouldBe(0);
        cutover.SuccessorObservationCounts.ContainsKey(record.Id).ShouldBeFalse();
    }

    [Fact]
    public async Task ProductionCanaryKey_DoesNotIncrementRuntimeCutoverObservation()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        const string key = "llmgw_canary_successor_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "map-canary",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            KeyPrefix = "gwk_canary",
            SourceSystem = "map",
            ClientCode = "map-canary",
            Environment = "production",
            Purpose = "canary",
            AppCallerCodes = ["map.chat::chat"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
        };
        await InsertServiceKeyAsync(scope.Context, record);
        await scope.Context.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers")
            .InsertOneAsync(new GatewayLegacyKeyCutoverRecord
            {
                TenantId = "tenant-a",
                Status = "observing",
                AllowedAppCallerCodes = ["map.chat::chat"],
                SuccessorServiceKeyIds = [record.Id],
                RequiredIngressProtocols = ["openai-compatible"],
                RequiredSuccessorObservations = 1,
            });

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key, "legacy-key", "map", "map.chat::chat",
            "openai-compatible", "invoke", null, CancellationToken.None);

        result.Allowed.ShouldBeTrue();
        var cutover = await scope.Context.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers")
            .Find(x => x.TenantId == "tenant-a")
            .SingleAsync();
        cutover.SuccessorObservedCount.ShouldBe(0);
        cutover.SuccessorObservationCounts.ContainsKey(record.Id).ShouldBeFalse();
    }

    [Fact]
    public async Task SuccessorObservation_IgnoresTrafficOutsideLegacyCallerInventory()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        const string key = "llmgw_successor_unrelated_traffic_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "map-runtime",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            KeyPrefix = "gwk_success",
            SourceSystem = "map",
            ClientCode = "map-runtime",
            Environment = "production",
            Purpose = "runtime",
            AppCallerCodes = ["map.chat::chat", "map.unrelated::chat"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
        };
        await InsertServiceKeyAsync(scope.Context, record);
        await scope.Context.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers")
            .InsertOneAsync(new GatewayLegacyKeyCutoverRecord
            {
                TenantId = "tenant-a",
                Status = "observing",
                AllowedAppCallerCodes = ["map.chat::chat"],
                SuccessorServiceKeyIds = [record.Id],
                RequiredIngressProtocols = ["openai-compatible"],
                RequiredSuccessorObservations = 1,
            });

        var unrelated = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key, "legacy-key", "map", "map.unrelated::chat",
            "openai-compatible", "invoke", null, CancellationToken.None);

        unrelated.Allowed.ShouldBeTrue();
        var cutover = await scope.Context.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers")
            .Find(x => x.TenantId == "tenant-a")
            .SingleAsync();
        cutover.SuccessorObservedCount.ShouldBe(0);
        cutover.SuccessorObservationCounts.ContainsKey(record.Id).ShouldBeFalse();
    }

    [Fact]
    public async Task ScopedKey_RevokedKeyReturns401WithAuditIdentityButNoSecret()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_test_revoked_identity_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            TeamId = "team-a",
            Name = "revoked-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            KeyPrefix = "gwk_revoke",
            Enabled = false,
            SourceSystem = "external",
            ClientCode = "weekly-agent",
            Environment = "production",
            AppCallerCodes = ["weekly.generate::chat"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
        };
        await InsertServiceKeyAsync(scope.Context, record);

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key,
            "legacy-key",
            "external",
            "weekly.generate::chat",
            "openai-compatible",
            "invoke",
            null,
            CancellationToken.None);

        result.Allowed.ShouldBeFalse();
        result.Authenticated.ShouldBeTrue();
        result.StatusCode.ShouldBe(401);
        result.ErrorCode.ShouldBe("GATEWAY_KEY_INVALID");
        result.KeyId.ShouldBe(record.Id);
        result.TenantId.ShouldBe("tenant-a");
        result.TeamId.ShouldBe("team-a");
        result.ClientCode.ShouldBe("weekly-agent");
        result.Environment.ShouldBe("production");
        result.KeyPrefixSnapshot.ShouldBe("gwk_revoke");
        result.Detail.ShouldNotContain(key);
        result.Detail.ShouldNotContain(record.KeyHash);
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
            null,
            CancellationToken.None);

        denied.Allowed.ShouldBeFalse();
        denied.Authenticated.ShouldBeTrue();
        denied.StatusCode.ShouldBe(403);
    }

    [Fact]
    public async Task ScopedKey_TenantDisabledIsRejectedImmediately()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_test_disabled_tenant_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "disabled-tenant-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            SourceSystem = "external",
            AppCallerCodes = ["caller"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
        };
        await InsertServiceKeyAsync(scope.Context, record);
        await scope.Context.Database.GetCollection<BsonDocument>("llmgw_tenants").UpdateOneAsync(
            Builders<BsonDocument>.Filter.Eq("_id", record.TenantId),
            Builders<BsonDocument>.Update.Set("Status", "disabled"));

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key, "legacy-key", "external", "caller", "openai-compatible", "invoke", null, CancellationToken.None);

        result.Allowed.ShouldBeFalse();
        result.StatusCode.ShouldBe(403);
        result.ErrorCode.ShouldBe("GATEWAY_KEY_TENANT_INACTIVE");
    }

    [Fact]
    public async Task ScopedKey_TeamDisabledIsRejectedImmediately()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_test_disabled_team_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            TeamId = "team-a",
            Name = "disabled-team-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            SourceSystem = "external",
            AppCallerCodes = ["caller"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
        };
        await InsertServiceKeyAsync(scope.Context, record);
        await scope.Context.Database.GetCollection<BsonDocument>("llmgw_teams").UpdateOneAsync(
            Builders<BsonDocument>.Filter.Eq("_id", record.TeamId),
            Builders<BsonDocument>.Update.Set("Status", "disabled"));

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key, "legacy-key", "external", "caller", "openai-compatible", "invoke", null, CancellationToken.None);

        result.Allowed.ShouldBeFalse();
        result.StatusCode.ShouldBe(403);
        result.ErrorCode.ShouldBe("GATEWAY_KEY_TEAM_INACTIVE");
    }

    [Fact]
    public async Task ScopedKey_DisabledCreatorMembershipIsRejectedImmediately()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_test_disabled_owner_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            CreatedByUserId = "user-a",
            Name = "disabled-owner-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            SourceSystem = "external",
            AppCallerCodes = ["caller"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
        };
        await InsertServiceKeyAsync(scope.Context, record);
        await scope.Context.Database.GetCollection<BsonDocument>("llmgw_memberships").UpdateOneAsync(
            Builders<BsonDocument>.Filter.Eq("UserId", record.CreatedByUserId),
            Builders<BsonDocument>.Update.Set("Status", "disabled"));

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key, "legacy-key", "external", "caller", "openai-compatible", "invoke", null, CancellationToken.None);

        result.Allowed.ShouldBeFalse();
        result.StatusCode.ShouldBe(403);
        result.ErrorCode.ShouldBe("GATEWAY_KEY_OWNER_INACTIVE");
    }

    [Fact]
    public async Task ScopedKey_DeveloperRemovedFromTeamIsRejectedImmediately()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_test_removed_team_owner_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            TeamId = "team-a",
            CreatedByUserId = "user-a",
            Name = "removed-team-owner-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            SourceSystem = "external",
            AppCallerCodes = ["caller"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
        };
        await InsertServiceKeyAsync(scope.Context, record);
        await scope.Context.Database.GetCollection<BsonDocument>("llmgw_memberships").UpdateOneAsync(
            Builders<BsonDocument>.Filter.Eq("UserId", record.CreatedByUserId),
            Builders<BsonDocument>.Update.Set("TeamIds", new BsonArray()));

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key, "legacy-key", "external", "caller", "openai-compatible", "invoke", null, CancellationToken.None);

        result.Allowed.ShouldBeFalse();
        result.StatusCode.ShouldBe(403);
        result.ErrorCode.ShouldBe("GATEWAY_KEY_OWNER_TEAM_DENIED");
    }

    [Fact]
    public async Task ScopedKey_CreatorDowngradedToViewerIsRejectedImmediately()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_test_downgraded_owner_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            TeamId = "team-a",
            CreatedByUserId = "user-a",
            Name = "downgraded-owner-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            SourceSystem = "external",
            AppCallerCodes = ["caller"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
        };
        await InsertServiceKeyAsync(scope.Context, record);
        await scope.Context.Database.GetCollection<BsonDocument>("llmgw_memberships").UpdateOneAsync(
            Builders<BsonDocument>.Filter.Eq("UserId", record.CreatedByUserId),
            Builders<BsonDocument>.Update.Set("Role", "viewer"));

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key, "legacy-key", "external", "caller", "openai-compatible", "invoke", null, CancellationToken.None);

        result.Allowed.ShouldBeFalse();
        result.StatusCode.ShouldBe(403);
        result.ErrorCode.ShouldBe("GATEWAY_KEY_OWNER_ROLE_DENIED");
    }

    [Fact]
    public async Task ScopedKey_CannotInvokeAppCallerOwnedByAnotherTeam()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_test_cross_team_caller_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            TeamId = "team-a",
            Name = "team-a-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            SourceSystem = "external",
            AppCallerCodes = ["shared-caller"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
        };
        await InsertServiceKeyAsync(scope.Context, record);
        await scope.Context.Database.GetCollection<GatewayAppCallerRecord>("llmgw_app_callers").InsertOneAsync(
            new GatewayAppCallerRecord
            {
                TenantId = record.TenantId,
                TeamId = "team-b",
                AppCallerCode = "shared-caller",
                RequestType = "chat",
            });

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key, "legacy-key", "external", "shared-caller", "openai-compatible", "invoke", null, CancellationToken.None);

        result.Allowed.ShouldBeFalse();
        result.StatusCode.ShouldBe(403);
        result.ErrorCode.ShouldBe("GATEWAY_KEY_TEAM_MISMATCH");
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
            null,
            CancellationToken.None);

        denied.Allowed.ShouldBeFalse();
        denied.Authenticated.ShouldBeTrue();
        denied.StatusCode.ShouldBe(403);
    }

    [Fact]
    public async Task ScopedKey_EnforcesSourceCidrFromServerConnection()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_test_cidr_key";
        await InsertServiceKeyAsync(scope.Context, new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "cidr-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            SourceSystem = "external",
            AppCallerCodes = ["caller"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
            AllowedCidrs = ["10.20.0.0/16"],
        });
        var authorizer = new GatewayScopedKeyAuthorizer(scope.Context);

        var allowed = await authorizer.AuthorizeAsync(
            key, "legacy-key", "external", "caller", "openai-compatible", "invoke",
            System.Net.IPAddress.Parse("10.20.3.4"), CancellationToken.None);
        var denied = await authorizer.AuthorizeAsync(
            key, "legacy-key", "external", "caller", "openai-compatible", "invoke",
            System.Net.IPAddress.Parse("10.21.3.4"), CancellationToken.None);

        allowed.Allowed.ShouldBeTrue();
        denied.Allowed.ShouldBeFalse();
        denied.StatusCode.ShouldBe(403);
        denied.ErrorCode.ShouldBe("GATEWAY_KEY_SOURCE_IP_DENIED");
    }

    [Fact]
    public async Task ScopedKey_EnforcesTenantScopedPerMinuteLimit()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_test_rate_key";
        await InsertServiceKeyAsync(scope.Context, new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "rate-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            SourceSystem = "external",
            AppCallerCodes = ["caller"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
            RateLimitPerMinute = 1,
        });
        var authorizer = new GatewayScopedKeyAuthorizer(scope.Context);

        var first = await authorizer.AuthorizeAsync(
            key, "legacy-key", "external", "caller", "openai-compatible", "invoke",
            null, CancellationToken.None);
        var second = await authorizer.AuthorizeAsync(
            key, "legacy-key", "external", "caller", "openai-compatible", "invoke",
            null, CancellationToken.None);

        first.Allowed.ShouldBeTrue();
        second.Allowed.ShouldBeFalse();
        second.StatusCode.ShouldBe(429);
        second.ErrorCode.ShouldBe("GATEWAY_KEY_RATE_LIMITED");
        var window = await scope.Context.Database.GetCollection<GatewayServiceKeyRateWindowRecord>("llmgw_service_key_rate_windows")
            .Find(x => x.TenantId == "tenant-a" && x.ServiceKeyId != string.Empty)
            .SingleAsync();
        window.Count.ShouldBe(2);
    }

    [Fact]
    public async Task ScopedKey_FirstMinuteConcurrentRequests_DoNotFailWithDuplicateWindow()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_test_concurrent_rate_key";
        var keyRecord = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "concurrent-rate-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            SourceSystem = "external",
            AppCallerCodes = ["caller"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
            RateLimitPerMinute = 10,
        };
        await InsertServiceKeyAsync(scope.Context, keyRecord);
        var windows = scope.Context.Database.GetCollection<GatewayServiceKeyRateWindowRecord>("llmgw_service_key_rate_windows");
        await windows.Indexes.CreateOneAsync(new CreateIndexModel<GatewayServiceKeyRateWindowRecord>(
            Builders<GatewayServiceKeyRateWindowRecord>.IndexKeys
                .Ascending(x => x.TenantId)
                .Ascending(x => x.ServiceKeyId)
                .Ascending(x => x.WindowStart),
            new CreateIndexOptions { Unique = true }));
        var authorizer = new GatewayScopedKeyAuthorizer(scope.Context);

        var results = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => authorizer.AuthorizeAsync(
            key, "legacy-key", "external", "caller", "openai-compatible", "invoke",
            null, CancellationToken.None)));

        results.Count(x => x.Allowed).ShouldBe(10);
        results.Count(x => x.StatusCode == 429).ShouldBe(10);
        var window = await windows.Find(x => x.TenantId == "tenant-a" && x.ServiceKeyId == keyRecord.Id).SingleAsync();
        window.Count.ShouldBe(20);
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
        catch (Exception ex)
        {
            throw new Xunit.Sdk.XunitException($"MongoDB 行为测试依赖不可用：{ex.Message}");
        }
    }

    private static async Task InsertServiceKeyAsync(LlmGatewayDataContext context, GatewayServiceKeyRecord record)
    {
        await context.Database.GetCollection<BsonDocument>("llmgw_tenants").ReplaceOneAsync(
            Builders<BsonDocument>.Filter.Eq("_id", record.TenantId),
            new BsonDocument
            {
                { "_id", record.TenantId },
                { "Status", "active" },
            },
            new ReplaceOptions { IsUpsert = true });
        if (!string.IsNullOrWhiteSpace(record.TeamId))
        {
            await context.Database.GetCollection<BsonDocument>("llmgw_teams").ReplaceOneAsync(
                Builders<BsonDocument>.Filter.Eq("_id", record.TeamId),
                new BsonDocument
                {
                    { "_id", record.TeamId },
                    { "TenantId", record.TenantId },
                    { "Status", "active" },
                },
                new ReplaceOptions { IsUpsert = true });
        }
        if (!string.IsNullOrWhiteSpace(record.CreatedByUserId))
        {
            await context.Database.GetCollection<BsonDocument>("llmgw_memberships").InsertOneAsync(new BsonDocument
            {
                { "_id", Guid.NewGuid().ToString("N") },
                { "TenantId", record.TenantId },
                { "UserId", record.CreatedByUserId },
                { "Role", "developer" },
                { "TeamIds", string.IsNullOrWhiteSpace(record.TeamId) ? new BsonArray() : new BsonArray { record.TeamId } },
                { "Status", "active" },
            });
        }
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
