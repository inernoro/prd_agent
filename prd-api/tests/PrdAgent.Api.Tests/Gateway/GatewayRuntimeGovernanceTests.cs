using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.DependencyInjection;
using System.Text.Json.Nodes;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.LlmGw.Costs;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.MdToPpt;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayRuntimeGovernanceTests
{
    [Fact]
    public async Task TaskBudget_ActivationRejectsOrdinaryCallerBeforeDatabaseAccess()
    {
        var controller = new DesignArtifactRuntimeBudgetController(
            null!,
            new ConfigurationBuilder().Build(),
            NullLogger<DesignArtifactRuntimeBudgetController>.Instance)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        [new Claim(ClaimTypes.NameIdentifier, "user-a")],
                        "test")),
                },
            },
        };

        var result = await controller.Activate(new ActivateDesignArtifactRuntimeBudgetRequest(), CancellationToken.None);

        result.ShouldBeOfType<ForbidResult>();
    }

    [Fact]
    public void TaskBudget_ActivationRequiresFrozenRouteTieredRatesAndExactOutputCap()
    {
        var request = new ActivateDesignArtifactRuntimeBudgetRequest
        {
            SourcePlanHash = new string('a', 64), ImmutableCarryUsd = 34.493745m, AuthorizedLimitUsd = 50m,
            InputUsdPerMillion = 4m, OutputUsdPerMillion = 20m,
            LongContextThresholdTokens = 272_000, LongContextInputUsdPerMillion = 8m,
            LongContextOutputUsdPerMillion = 30m, MaxOutputTokens = 8192,
            ExpectedLogicalModelPublicId = "default-chat-curated", ExpectedProvider = "apiyi-openai",
            ExpectedModel = "gpt-5.6-sol", ExpiresAt = DateTime.UtcNow.AddDays(1),
            PptCompletion = CompletionRequest(),
        };

        DesignArtifactRuntimeBudgetController.Validate(request).ShouldBeNull();
        request.MaxOutputTokens = 8193;
        DesignArtifactRuntimeBudgetController.Validate(request).ShouldBe("输出硬上限必须为 8192");
        request.MaxOutputTokens = 8192;
        request.LongContextThresholdTokens = 0;
        DesignArtifactRuntimeBudgetController.Validate(request).ShouldBe("长上下文估算费率无效");
        request.LongContextThresholdTokens = 272_000;
        request.ExpectedProvider = string.Empty;
        DesignArtifactRuntimeBudgetController.Validate(request).ShouldBe("任务物理路由无效");
        request.ExpectedProvider = "apiyi-openai";
        request.PptCompletion = null;
        DesignArtifactRuntimeBudgetController.Validate(request).ShouldBe("PPT 完成阶段预算合同不能为空");
        request.PptCompletion = CompletionRequest();
        request.ImmutableCarryUsd = 49m;
        DesignArtifactRuntimeBudgetController.Validate(request)
            .ShouldBe("PPT 完成阶段联合包络超过授权总额");
    }

    [Fact]
    public async Task TaskBudget_ConcurrentRunsShareOneAtomicCapAndUnknownUsageIsNotFree()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var budgets = scope.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        var record = BudgetScope("scope-a", authorized: 50m, generationRunId: "run-shared");
        record.PptCompletion!.GenerationAndRepairs.MaxPhysicalCalls = 1;
        record.PptCompletion.GenerationAndRepairs.MaxBodyUtf8Bytes = 10_000;
        record.PptCompletion.GenerationAndRepairs.PerCallUpperUsd = 0.220224m;
        record.PptCompletion.FutureHeldUsd = 0.220224m;
        await budgets.InsertOneAsync(record);
        var counter = new GatewayRuntimeGrantCallCounter(scope.Context);
        var grants = new[]
        {
            ProtectedGrant("grant-a", "run-shared", "scope-a"),
            ProtectedGrant("grant-b", "run-shared", "scope-a"),
        };
        await scope.Context.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .InsertManyAsync(grants);

        var decisions = await Task.WhenAll(grants.Select((grant, index) => counter.TryReserveAsync(
            grant,
            new GatewayRuntimeGrantCallRequest(
                $"request-{index}", 10_000, 8_192,
                "default-chat-curated", "apiyi-openai", "gpt-5.6-sol"),
            CancellationToken.None)));

        decisions.Count(item => item.Allowed).ShouldBe(1);
        decisions.Count(item => item.ErrorCode == "GATEWAY_RUNTIME_TASK_BUDGET_EXCEEDED").ShouldBe(1);
        var winner = decisions.Select((item, index) => (item, index)).Single(x => x.item.Allowed);
        await counter.FinalizeAsync(grants[winner.index], $"request-{winner.index}", null, "transport-failed", CancellationToken.None);
        var stored = await budgets.Find(x => x.Id == "scope-a").SingleAsync();
        stored.ReservedUsd.ShouldBe(0m);
        stored.SpentUsd.ShouldBe(34.220224m);
        stored.PptCompletion!.FutureHeldUsd.ShouldBe(0m);
        stored.PptCompletion.GenerationAndRepairs.UsedPhysicalCalls.ShouldBe(1);
        stored.Reservations.Single().Status.ShouldBe("settled-unknown");
    }

    [Theory]
    [InlineData(0)]
    [InlineData(100)]
    public async Task TaskBudget_UnboundGrantKeepsExistingCallOnlyBehavior(int maxOutputTokens)
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var grant = new GatewayRuntimeGrantRecord
        {
            Id = "unbound", KeyHash = "hash-unbound", TenantId = "tenant-a", RunId = "run-a",
            AppCallerCode = "generate-html::chat", MaxCalls = 1, ExpiresAt = DateTime.UtcNow.AddHours(1),
        };
        var grants = scope.Context.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants");
        await grants.InsertOneAsync(grant);
        var counter = new GatewayRuntimeGrantCallCounter(scope.Context);

        var decision = await counter.TryReserveAsync(
            grant, new GatewayRuntimeGrantCallRequest("request-a", 100, maxOutputTokens), CancellationToken.None);

        decision.Allowed.ShouldBeTrue();
        (await grants.Find(item => item.Id == grant.Id).SingleAsync()).CallCount.ShouldBe(1);
        var exhausted = await counter.TryReserveAsync(
            grant, new GatewayRuntimeGrantCallRequest("request-b", 100, maxOutputTokens), CancellationToken.None);
        exhausted.Allowed.ShouldBeFalse();
        exhausted.ErrorCode.ShouldBe("GATEWAY_RUNTIME_GRANT_EXHAUSTED");
        (await grants.Find(item => item.Id == grant.Id).SingleAsync()).CallCount.ShouldBe(1);
        (await scope.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes")
            .CountDocumentsAsync(_ => true)).ShouldBe(0);
    }

    [Fact]
    public async Task TaskBudget_BoundGrantStillRequiresOutputLimitBeforeDatabaseAccess()
    {
        var counter = new GatewayRuntimeGrantCallCounter(null!);
        var grant = ProtectedGrant("grant-requires-output", "run-requires-output", "scope-requires-output");

        var decision = await counter.TryReserveAsync(
            grant, new GatewayRuntimeGrantCallRequest("request-a", 100, 0), CancellationToken.None);

        decision.Allowed.ShouldBeFalse();
        decision.StatusCode.ShouldBe(400);
        decision.ErrorCode.ShouldBe("GATEWAY_RUNTIME_TASK_BUDGET_INPUT_INVALID");
    }

    [Theory]
    [InlineData("", 100)]
    [InlineData("request-a", 0)]
    public async Task TaskBudget_GrantStillRequiresRequestIdentityAndBodyBeforeDatabaseAccess(string requestId, int bodyBytes)
    {
        var counter = new GatewayRuntimeGrantCallCounter(null!);
        var grant = new GatewayRuntimeGrantRecord { Id = "unbound-invalid-input" };

        var decision = await counter.TryReserveAsync(
            grant, new GatewayRuntimeGrantCallRequest(requestId, bodyBytes, 0), CancellationToken.None);

        decision.Allowed.ShouldBeFalse();
        decision.StatusCode.ShouldBe(400);
        decision.ErrorCode.ShouldBe("GATEWAY_RUNTIME_TASK_BUDGET_INPUT_INVALID");
    }

    [Fact]
    public async Task TaskBudget_UnboundGrantWithoutOutputLimitStillEnforcesExpiry()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var grant = new GatewayRuntimeGrantRecord
        {
            Id = "expired-unbound", KeyHash = "hash-expired-unbound", TenantId = "tenant-a", RunId = "run-a",
            AppCallerCode = "generate-html::chat", MaxCalls = 1, ExpiresAt = DateTime.UtcNow.AddMinutes(-1),
        };
        var grants = scope.Context.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants");
        await grants.InsertOneAsync(grant);
        var counter = new GatewayRuntimeGrantCallCounter(scope.Context);

        var decision = await counter.TryReserveAsync(
            grant, new GatewayRuntimeGrantCallRequest("request-a", 100, 0), CancellationToken.None);

        decision.Allowed.ShouldBeFalse();
        decision.StatusCode.ShouldBe(401);
        decision.ErrorCode.ShouldBe("GATEWAY_KEY_INVALID");
        (await grants.Find(item => item.Id == grant.Id).SingleAsync()).CallCount.ShouldBe(0);
    }

    [Fact]
    public async Task TaskBudget_BoundPptGrantWithoutCompletionContractIsRejectedBeforeCallCount()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var record = BudgetScope("scope-old-bound", authorized: 50m, generationRunId: "run-old-bound");
        record.PptCompletion = null;
        await scope.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes")
            .InsertOneAsync(record);
        var grant = ProtectedGrant("grant-old-bound", "run-old-bound", record.Id);
        grant.PptCompletionId = null;
        grant.PptCompletionPhase = null;
        var grants = scope.Context.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants");
        await grants.InsertOneAsync(grant);
        var counter = new GatewayRuntimeGrantCallCounter(scope.Context);

        var decision = await counter.TryReserveAsync(
            grant,
            new GatewayRuntimeGrantCallRequest(
                "request-old-bound", 10_000, 8192,
                "default-chat-curated", "apiyi-openai", "gpt-5.6-sol"),
            CancellationToken.None);

        decision.Allowed.ShouldBeFalse();
        decision.ErrorCode.ShouldBe("GATEWAY_RUNTIME_TASK_COMPLETION_CONTRACT_REQUIRED");
        (await grants.Find(item => item.Id == grant.Id).SingleAsync()).CallCount.ShouldBe(0);
        (await scope.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes")
            .Find(item => item.Id == record.Id).SingleAsync()).Reservations.ShouldBeEmpty();
    }

    [Fact]
    public async Task TaskBudget_DeterministicGrantRejectionRestoresFutureHoldAndCallSlot()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var record = BudgetScope("scope-release", authorized: 50m, generationRunId: "run-release");
        var originalHold = record.PptCompletion!.FutureHeldUsd;
        await scope.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes")
            .InsertOneAsync(record);
        var grant = ProtectedGrant("grant-release", "run-release", record.Id);
        grant.MaxCalls = 0;
        var grants = scope.Context.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants");
        await grants.InsertOneAsync(grant);
        var counter = new GatewayRuntimeGrantCallCounter(scope.Context);

        var decision = await counter.TryReserveAsync(
            grant,
            new GatewayRuntimeGrantCallRequest(
                "request-release", 10_000, 8192,
                "default-chat-curated", "apiyi-openai", "gpt-5.6-sol"),
            CancellationToken.None);

        decision.Allowed.ShouldBeFalse();
        decision.ErrorCode.ShouldBe("GATEWAY_RUNTIME_GRANT_EXHAUSTED");
        var stored = await scope.Context.Database
            .GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes")
            .Find(item => item.Id == record.Id)
            .SingleAsync();
        stored.ReservedUsd.ShouldBe(0m);
        stored.PptCompletion!.FutureHeldUsd.ShouldBe(originalHold);
        stored.PptCompletion.GenerationAndRepairs.UsedPhysicalCalls.ShouldBe(0);
        stored.Reservations.Single().Status.ShouldBe("released-before-send");
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task TaskBudget_ConfirmedBeforeSendRejectionReleasesMoneyButUnknownOutcomeDoesNot(bool rejectedBeforeSend)
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var database = testDatabase;
        var record = BudgetScope("scope-revoked", authorized: 50m, generationRunId: "run-revoked");
        var originalHold = record.PptCompletion!.FutureHeldUsd;
        var budgets = database.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        await budgets.InsertOneAsync(record);
        var grant = ProtectedGrant("grant-revoked", "run-revoked", record.Id);
        var grants = database.Context.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants");
        await grants.InsertOneAsync(grant);
        var counter = new GatewayRuntimeGrantCallCounter(database.Context);
        (await counter.TryReserveAsync(grant, new GatewayRuntimeGrantCallRequest(
            "request-revoked", 10_000, 8192, "default-chat-curated", "apiyi-openai", "gpt-5.6-sol"),
            CancellationToken.None)).Allowed.ShouldBeTrue();
        var before = await budgets.Find(item => item.Id == record.Id).SingleAsync();
        before.ReservedUsd.ShouldBeGreaterThan(0m);
        await counter.FinalizeAsync(grant, "request-revoked", null,
            rejectedBeforeSend ? GatewayTaskBudgetOutcomes.RejectedBeforeSend : "TASK_EXECUTION_LEASE_INVALID",
            CancellationToken.None);
        // 重复结算不得再释放；已按未知结算的记录也不能被迟到的释放改写。
        await counter.FinalizeAsync(grant, "request-revoked", null,
            GatewayTaskBudgetOutcomes.RejectedBeforeSend, CancellationToken.None);

        var stored = await budgets.Find(item => item.Id == record.Id).SingleAsync();
        stored.ReservedUsd.ShouldBe(0m);
        stored.SpentUsd.ShouldBe(rejectedBeforeSend ? record.SpentUsd : record.SpentUsd + before.ReservedUsd);
        stored.PptCompletion!.FutureHeldUsd.ShouldBe(rejectedBeforeSend
            ? originalHold : originalHold - record.PptCompletion.GenerationAndRepairs.PerCallUpperUsd);
        stored.PptCompletion.GenerationAndRepairs.UsedPhysicalCalls.ShouldBe(rejectedBeforeSend ? 0 : 1);
        stored.Reservations.Single().Status.ShouldBe(rejectedBeforeSend ? "released-before-send" : "settled-unknown");
        (await grants.Find(item => item.Id == grant.Id).SingleAsync()).CallCount.ShouldBe(1);
    }

    [Fact]
    public async Task TaskBudget_FutureHoldCannotBeStolenByOutlineButBoundGenerationCanConsumeIt()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var record = BudgetScope("scope-held", authorized: 50m, generationRunId: "run-held");
        record.PptCompletion!.FutureHeldUsd = 16m;
        await scope.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes")
            .InsertOneAsync(record);
        var counter = new GatewayRuntimeGrantCallCounter(scope.Context);
        var outline = new GatewayTaskBudgetRequest(
            record.Id, record.TenantId, record.UserId, record.RootOutlineRunId,
            AppCallerRegistry.MdToPptAgent.Generation.Outline,
            "outline", "request-held-outline", 1_000, 8192,
            "default-chat-curated", "apiyi-openai", "gpt-5.6-sol", null);

        var outlineDecision = await counter.TryReserveTaskAsync(outline, CancellationToken.None);
        outlineDecision.Allowed.ShouldBeFalse();
        outlineDecision.ErrorCode.ShouldBe("GATEWAY_RUNTIME_TASK_BUDGET_EXCEEDED");

        var grant = ProtectedGrant("grant-held", "run-held", record.Id);
        await scope.Context.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .InsertOneAsync(grant);
        var generationDecision = await counter.TryReserveAsync(
            grant,
            new GatewayRuntimeGrantCallRequest(
                "request-held-generation", 10_000, 8192,
                "default-chat-curated", "apiyi-openai", "gpt-5.6-sol"),
            CancellationToken.None);

        generationDecision.Allowed.ShouldBeTrue();
        var stored = await scope.Context.Database
            .GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes")
            .Find(item => item.Id == record.Id)
            .SingleAsync();
        stored.Reservations.Select(item => item.RequestId).ShouldBe(["request-held-generation"]);
        stored.PptCompletion!.FutureHeldUsd.ShouldBe(
            16m - stored.PptCompletion.GenerationAndRepairs.PerCallUpperUsd);
    }

    [Fact]
    public async Task TaskBudget_ExpiredCompletionRejectsBeforeGrantCall()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var record = BudgetScope("scope-expired-completion", authorized: 50m, generationRunId: "run-expired");
        record.PptCompletion!.ExpiresAt = DateTime.UtcNow.AddMinutes(-1);
        await scope.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes")
            .InsertOneAsync(record);
        var grant = ProtectedGrant("grant-expired", "run-expired", record.Id);
        var grants = scope.Context.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants");
        await grants.InsertOneAsync(grant);
        var counter = new GatewayRuntimeGrantCallCounter(scope.Context);

        var decision = await counter.TryReserveAsync(
            grant,
            new GatewayRuntimeGrantCallRequest(
                "request-expired", 10_000, 8192,
                "default-chat-curated", "apiyi-openai", "gpt-5.6-sol"),
            CancellationToken.None);

        decision.Allowed.ShouldBeFalse();
        decision.ErrorCode.ShouldBe("GATEWAY_RUNTIME_TASK_COMPLETION_ENVELOPE_EXCEEDED");
        (await grants.Find(item => item.Id == grant.Id).SingleAsync()).CallCount.ShouldBe(0);
    }

    [Fact]
    public async Task TaskBudget_FreshOutlineClaimsExactSourceAndRejectsMismatchBeforeGatewayRequest()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var now = DateTime.UtcNow;
        var budgets = scope.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        var exact = Plan("# 发布资料\n\n必须保留完整条件。");
        var other = Plan("# 另一份资料\n\n不得认领本任务额度。");
        var expiredPlan = Plan("# 已过期资料\n\n额度作用域已过期。");
        var closedPlan = Plan("# 已关闭资料\n\n历史任务已关闭。");
        await budgets.InsertManyAsync(new[]
        {
            PendingScope("scope-exact", "owner-a", exact.Fingerprint, now.AddHours(1)),
            PendingScope("scope-other", "owner-a", other.Fingerprint, now.AddHours(1)),
            PendingScope("scope-expired", "owner-b", expiredPlan.Fingerprint, now.AddMinutes(-1)),
            PendingScope("scope-closed", "owner-c", closedPlan.Fingerprint, now.AddHours(1), "closed"),
        });

        var outline = Outline("outline-a", "owner-a", exact.Json);
        (await MdToPptController.ClaimPendingTaskBudgetAsync(
            budgets, "tenant-a", outline, now, CancellationToken.None)).ShouldBe("scope-exact");
        // 同一 run 在进程重启后重进认领逻辑仍返回原 scope，不会退成无保护发送。
        (await MdToPptController.ClaimPendingTaskBudgetAsync(
            budgets, "tenant-a", outline, now, CancellationToken.None)).ShouldBe("scope-exact");

        var mismatch = await Should.ThrowAsync<MdToPptSourcePlanException>(() =>
            MdToPptController.ClaimPendingTaskBudgetAsync(
                budgets,
                "tenant-a",
                Outline("outline-mismatch", "owner-a", Plan("# 未授权资料\n\n指纹必须不一致。").Json),
                now,
                CancellationToken.None));
        mismatch.Code.ShouldBe("task_budget_source_mismatch");

        var expired = await Should.ThrowAsync<MdToPptSourcePlanException>(() =>
            MdToPptController.ClaimPendingTaskBudgetAsync(
                budgets,
                "tenant-a",
                Outline("outline-expired", "owner-b", expiredPlan.Json),
                now,
                CancellationToken.None));
        expired.Code.ShouldBe("task_budget_inactive");

        // 已显式关闭的旧 scope 不会永久挂住同一用户的以后任务；其他 owner 也不受影响。
        (await MdToPptController.ClaimPendingTaskBudgetAsync(
            budgets,
            "tenant-a",
            Outline("outline-closed", "owner-c", closedPlan.Json),
            now,
            CancellationToken.None)).ShouldBeNull();
        (await MdToPptController.ClaimPendingTaskBudgetAsync(
            budgets,
            "tenant-a",
            Outline("outline-unrelated", "owner-z", Plan("# 普通未绑定任务\n\n保持既有路径。").Json),
            now,
            CancellationToken.None)).ShouldBeNull();

        var invalid = await Should.ThrowAsync<MdToPptSourcePlanException>(() =>
            MdToPptController.ClaimPendingTaskBudgetAsync(
                budgets,
                "tenant-a",
                new MdToPptRun
                {
                    Id = "outline-invalid", UserId = "owner-a", Op = "outline",
                    SourcePlanVersion = MdToPptSourcePlan.Version,
                    SourcePlanHash = MdToPptSourcePlan.Hash("{}"), SourcePlanJson = "{}",
                },
                now,
                CancellationToken.None));
        invalid.Code.ShouldBe("source_plan_invalid");

        var missing = await Should.ThrowAsync<MdToPptSourcePlanException>(() =>
            MdToPptController.ClaimPendingTaskBudgetAsync(
                budgets,
                "tenant-a",
                new MdToPptRun
                {
                    Id = "outline-missing", UserId = "owner-a", Op = "outline",
                    SourcePlanVersion = MdToPptSourcePlan.Version,
                    SourcePlanHash = new string('f', 64), SourcePlanJson = null,
                },
                now,
                CancellationToken.None));
        missing.Code.ShouldBe("source_plan_missing");

        var tampered = Outline("outline-tampered", "owner-a", exact.Json);
        tampered.SourcePlanHash = new string('0', 64);
        var bindingMismatch = await Should.ThrowAsync<MdToPptSourcePlanException>(() =>
            MdToPptController.ClaimPendingTaskBudgetAsync(
                budgets, "tenant-a", tampered, now, CancellationToken.None));
        bindingMismatch.Code.ShouldBe("source_plan_binding_mismatch");
        (await scope.Context.LlmRequestLogs.CountDocumentsAsync(_ => true)).ShouldBe(0);

        static (string Json, string Fingerprint) Plan(string markdown)
        {
            var plan = MdToPptSourcePlan.Create(markdown, Array.Empty<DesignKnowledgeSnapshot>());
            return (plan.SerializeCatalog(), plan.Fingerprint);
        }

        static MdToPptRun Outline(string id, string owner, string json) => new()
        {
            Id = id, UserId = owner, Op = "outline", SourcePlanVersion = MdToPptSourcePlan.Version,
            SourcePlanHash = MdToPptSourcePlan.Hash(json), SourcePlanJson = json,
        };

        static GatewayRuntimeBudgetScopeRecord PendingScope(
            string id, string owner, string hash, DateTime expiry, string status = "active") => new()
        {
            Id = id, TenantId = "tenant-a", UserId = owner, SourcePlanHash = hash,
            RootOutlineRunId = string.Empty, Status = status, ExpiresAt = expiry,
        };
    }

    [Fact]
    public async Task TaskBudget_LongContextUsesHigherTierAndTrustedUsageSettlesWithoutCacheDiscount()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var budgets = scope.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        await budgets.InsertOneAsync(BudgetScope("scope-long", authorized: 50m));
        var grants = scope.Context.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants");
        var grant = ProtectedGrant("grant-long", "run-long", "scope-long");
        await grants.InsertOneAsync(grant);
        var counter = new GatewayRuntimeGrantCallCounter(scope.Context);

        var admission = await counter.TryReserveAsync(
            grant,
            new GatewayRuntimeGrantCallRequest(
                "request-long", 272_001, 8192,
                "default-chat-curated", "apiyi-openai", "gpt-5.6-sol"),
            CancellationToken.None);

        admission.Allowed.ShouldBeTrue();
        var reserved = await budgets.Find(item => item.Id == "scope-long").SingleAsync();
        reserved.Reservations.Single().PricingTier.ShouldBe("long-context");
        reserved.Reservations.Single().InputTokenUpperBound.ShouldBe(276_097);
        reserved.Reservations.Single().ReservedUsd.ShouldBe(2.454536m);

        await counter.FinalizeAsync(
            grant,
            "request-long",
            new GatewayTokenUsage { InputTokens = 50_858, CacheReadInputTokens = 50_000, OutputTokens = 6_432 },
            "succeeded",
            CancellationToken.None);
        var settled = await budgets.Find(item => item.Id == "scope-long").SingleAsync();
        settled.ReservedUsd.ShouldBe(0m);
        // 可靠 usage 按实际 50,858 输入落回标准档；cached input 不享额外折扣，也不重复计费。
        settled.SpentUsd.ShouldBe(34.332072m);
        settled.Reservations.Single().SettledUsd.ShouldBe(0.332072m);
        settled.Reservations.Single().Status.ShouldBe("settled");
    }

    [Fact]
    public async Task TaskBudget_OutlineConvertAndManualShareScopeAndEachRetryNeedsANewReservation()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var budgets = scope.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        var chainScope = BudgetScope("scope-chain", authorized: 50m, generationRunId: "convert-a");
        await budgets.InsertOneAsync(chainScope);
        var grants = scope.Context.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants");
        var convert = ProtectedGrant("grant-convert", "convert-a", "scope-chain");
        var manual = ProtectedGrant("grant-manual", "manual-a", "scope-chain");
        manual.AppCallerCode = AppCallerRegistry.MdToPptAgent.Generation.Patch;
        manual.PptCompletionPhase = GatewayPptCompletionPhases.ManualSave;
        await grants.InsertManyAsync(new[] { convert, manual });
        var counter = new GatewayRuntimeGrantCallCounter(scope.Context);
        var outlineRequest = new GatewayTaskBudgetRequest(
            "scope-chain", "tenant-a", "user-a", "outline-a",
            AppCallerRegistry.MdToPptAgent.Generation.Outline, "outline:outline-a", "request-outline",
            20_000, 8192, "default-chat-curated", "apiyi-openai", "gpt-5.6-sol", "offering-a");

        (await counter.TryReserveTaskAsync(outlineRequest, CancellationToken.None)).Allowed.ShouldBeTrue();
        await counter.FinalizeTaskAsync(
            outlineRequest, new GatewayTokenUsage { InputTokens = 10_000, OutputTokens = 1_000 },
            "succeeded", CancellationToken.None);
        (await counter.TryReserveAsync(convert,
            new GatewayRuntimeGrantCallRequest(
                "request-convert", 30_000, 8192,
                "default-chat-curated", "apiyi-openai", "gpt-5.6-sol"),
            CancellationToken.None)).Allowed.ShouldBeTrue();
        await counter.FinalizeAsync(convert, "request-convert", null, "failed", CancellationToken.None);
        await budgets.UpdateOneAsync(
            item => item.Id == "scope-chain",
            Builders<GatewayRuntimeBudgetScopeRecord>.Update
                .Set("PptCompletion.Status", GatewayPptCompletionStatuses.ManualActive)
                .Set("PptCompletion.ManualRunId", "manual-a")
                .Set("PptCompletion.FutureHeldUsd",
                    chainScope.PptCompletion!.ManualSave.MaxPhysicalCalls
                    * chainScope.PptCompletion.ManualSave.PerCallUpperUsd));
        (await counter.TryReserveAsync(manual,
            new GatewayRuntimeGrantCallRequest(
                "request-manual", 25_000, 8192,
                "default-chat-curated", "apiyi-openai", "gpt-5.6-sol"),
            CancellationToken.None)).Allowed.ShouldBeTrue();
        await counter.FinalizeAsync(manual, "request-manual", null, "cancelled", CancellationToken.None);

        var duplicate = await counter.TryReserveAsync(manual,
            new GatewayRuntimeGrantCallRequest(
                "request-manual", 25_000, 8192,
                "default-chat-curated", "apiyi-openai", "gpt-5.6-sol"),
            CancellationToken.None);
        duplicate.Allowed.ShouldBeFalse();
        duplicate.ErrorCode.ShouldBe("GATEWAY_RUNTIME_TASK_REQUEST_DUPLICATE");
        var retry = await counter.TryReserveAsync(manual,
            new GatewayRuntimeGrantCallRequest(
                "request-manual-retry", 25_000, 8192,
                "default-chat-curated", "apiyi-openai", "gpt-5.6-sol"),
            CancellationToken.None);
        retry.Allowed.ShouldBeTrue();

        var stored = await budgets.Find(item => item.Id == "scope-chain").SingleAsync();
        stored.Reservations.Select(item => item.RequestId).ShouldBe(new[]
        {
            "request-outline", "request-convert", "request-manual", "request-manual-retry",
        });
        stored.Reservations.Single(item => item.RequestId == "request-convert").Status.ShouldBe("settled-unknown");
        stored.Reservations.Single(item => item.RequestId == "request-manual").Status.ShouldBe("settled-unknown");
        stored.ReservedUsd.ShouldBeGreaterThan(0m);
    }

    [Fact]
    public async Task TaskBudget_RouteMismatchIsRejectedBeforeReservation()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var budgets = scope.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        await budgets.InsertOneAsync(BudgetScope("scope-route", authorized: 50m, generationRunId: "convert-route"));
        var grants = scope.Context.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants");
        var grant = ProtectedGrant("grant-route", "convert-route", "scope-route");
        await grants.InsertOneAsync(grant);
        var counter = new GatewayRuntimeGrantCallCounter(scope.Context);

        var admission = await counter.TryReserveAsync(
            grant,
            new GatewayRuntimeGrantCallRequest(
                "request-wrong-route", 30_000, 8192,
                "default-chat-curated", "other-provider", "gpt-5.6-sol"),
            CancellationToken.None);

        admission.Allowed.ShouldBeFalse();
        admission.ErrorCode.ShouldBe("GATEWAY_RUNTIME_TASK_ROUTE_MISMATCH");
        var bodyTooLarge = await counter.TryReserveAsync(
            grant,
            new GatewayRuntimeGrantCallRequest(
                "request-body-too-large", 300_001, 8192,
                "default-chat-curated", "apiyi-openai", "gpt-5.6-sol"),
            CancellationToken.None);
        bodyTooLarge.Allowed.ShouldBeFalse();
        bodyTooLarge.ErrorCode.ShouldBe("GATEWAY_RUNTIME_TASK_COMPLETION_ENVELOPE_EXCEEDED");
        var outputTooLarge = await counter.TryReserveAsync(
            grant,
            new GatewayRuntimeGrantCallRequest(
                "request-output-too-large", 30_000, 8193,
                "default-chat-curated", "apiyi-openai", "gpt-5.6-sol"),
            CancellationToken.None);
        outputTooLarge.Allowed.ShouldBeFalse();
        outputTooLarge.ErrorCode.ShouldBe("GATEWAY_RUNTIME_TASK_OUTPUT_CAP_INVALID");
        var stored = await budgets.Find(item => item.Id == "scope-route").SingleAsync();
        stored.Reservations.ShouldBeEmpty();
        stored.ReservedUsd.ShouldBe(0m);
        (await grants.Find(item => item.Id == grant.Id).SingleAsync()).CallCount.ShouldBe(0);
    }

    [Fact]
    public async Task TaskBudget_CloseRefusesInflightAndPreservesSpentAndUnknownSettlements()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var budgets = scope.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        var record = BudgetScope("scope-close", authorized: 50m);
        record.ReservedUsd = 1.25m;
        record.Reservations.Add(new GatewayRuntimeBudgetReservationRecord
        {
            RequestId = "request-running", GrantId = "grant", Status = "reserved", ReservedUsd = 1.25m,
        });
        await budgets.InsertOneAsync(record);

        (await DesignArtifactRuntimeBudgetController.CloseScopeAsync(
            budgets, "scope-close", "user-a", DateTime.UtcNow, CancellationToken.None)).ShouldBeNull();
        await budgets.UpdateOneAsync(
            item => item.Id == "scope-close",
            Builders<GatewayRuntimeBudgetScopeRecord>.Update
                .Set(item => item.ReservedUsd, 0m)
                .Set("Reservations.0.Status", "settled-unknown")
                .Set("Reservations.0.SettledUsd", 1.25m)
                .Set(item => item.SpentUsd, 35.25m));

        var closedAt = DateTime.UtcNow;
        var closed = await DesignArtifactRuntimeBudgetController.CloseScopeAsync(
            budgets, "scope-close", "user-a", closedAt, CancellationToken.None);

        closed.ShouldNotBeNull();
        closed!.Status.ShouldBe("closed");
        closed.SpentUsd.ShouldBe(35.25m);
        closed.PptCompletion!.FutureHeldUsd.ShouldBe(0m);
        closed.PptCompletion.Status.ShouldBe(GatewayPptCompletionStatuses.Closed);
        closed.Reservations.Single().Status.ShouldBe("settled-unknown");
        closed.Reservations.Single().SettledUsd.ShouldBe(1.25m);
        closed.ClosedByUserId.ShouldBe("user-a");
        (await DesignArtifactRuntimeBudgetController.CloseScopeAsync(
            budgets, "scope-close", "other-user", DateTime.UtcNow, CancellationToken.None)).ShouldBeNull();
    }

    [Fact]
    public async Task TaskBudget_CloseLegacyNullCompletionDoesNotWriteChildPath()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var budgets = scope.Context.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        var legacy = BudgetScope("scope-legacy-close", authorized: 50m);
        legacy.PptCompletion = null;
        legacy.SpentUsd = 41.25m;
        await budgets.InsertOneAsync(legacy);

        var closed = await DesignArtifactRuntimeBudgetController.CloseScopeAsync(
            budgets, legacy.Id, legacy.UserId, DateTime.UtcNow, CancellationToken.None);

        closed.ShouldNotBeNull();
        closed!.Status.ShouldBe("closed");
        closed.PptCompletion.ShouldBeNull();
        closed.SpentUsd.ShouldBe(41.25m);
    }

    private static GatewayRuntimeBudgetScopeRecord BudgetScope(
        string id,
        decimal authorized,
        string generationRunId = "run-long",
        string? manualRunId = null,
        string status = GatewayPptCompletionStatuses.GenerationActive)
    {
        var record = new GatewayRuntimeBudgetScopeRecord
        {
            Id = id, TenantId = "tenant-a", RootOutlineRunId = "outline-a", UserId = "user-a",
            SourcePlanHash = new string('a', 64), ImmutableCarryUsd = 34m, AuthorizedLimitUsd = authorized,
            SpentUsd = 34m, InputUsdPerMillion = 4m, OutputUsdPerMillion = 20m,
            LongContextThresholdTokens = 272_000, LongContextInputUsdPerMillion = 8m,
            LongContextOutputUsdPerMillion = 30m, InputByteTokenMultiplier = 1, MaxOutputTokens = 8192,
            ExpectedLogicalModelPublicId = "default-chat-curated", ExpectedProvider = "apiyi-openai",
            ExpectedModel = "gpt-5.6-sol", ExpiresAt = DateTime.UtcNow.AddHours(1),
        };
        var generation = new GatewayPptCompletionStageBudgetRecord
        {
            MaxPhysicalCalls = 4,
            MaxBodyUtf8Bytes = 300_000,
            MaxOutputTokens = 8192,
        };
        var manual = new GatewayPptCompletionStageBudgetRecord
        {
            MaxPhysicalCalls = 2,
            MaxBodyUtf8Bytes = 200_000,
            MaxOutputTokens = 8192,
        };
        generation.PerCallUpperUsd = GatewayPptCompletionBudgetMath.PerCallUpper(
            record, generation.MaxBodyUtf8Bytes, generation.MaxOutputTokens);
        manual.PerCallUpperUsd = GatewayPptCompletionBudgetMath.PerCallUpper(
            record, manual.MaxBodyUtf8Bytes, manual.MaxOutputTokens);
        record.PptCompletion = new GatewayPptCompletionBudgetRecord
        {
            Id = $"pptc-{id}", ContractHash = new string('c', 64), CandidateCommit = TrustedCommit(),
            RootOutlineRunId = record.RootOutlineRunId, StableSourceHash = record.SourcePlanHash,
            GenerationRunId = generationRunId, ManualRunId = manualRunId ?? string.Empty,
            Status = status,
            FutureHeldUsd = GatewayPptCompletionBudgetMath.FullEnvelope(generation, manual, 0m),
            GenerationAndRepairs = generation, ManualSave = manual,
            ExpiresAt = record.ExpiresAt,
        };
        return record;
    }

    private static GatewayRuntimeGrantRecord ProtectedGrant(string id, string runId, string scopeId) => new()
    {
        Id = id, KeyHash = $"hash-{id}", TenantId = "tenant-a", RunId = runId,
        UserId = "user-a", AppCallerCode = AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate,
        MaxCalls = 256, ExpiresAt = DateTime.UtcNow.AddHours(1), BudgetScopeId = scopeId,
        BudgetMaxOutputTokens = 8192, PptCompletionId = $"pptc-{scopeId}",
        PptCompletionPhase = GatewayPptCompletionPhases.Generation,
    };

    private static ActivatePptCompletionBudgetRequest CompletionRequest() => new()
    {
        CandidateCommit = TrustedCommit(),
        GenerationAndRepairs = new ActivatePptCompletionStageBudgetRequest
        {
            MaxPhysicalCalls = 2, MaxBodyUtf8Bytes = 300_000, MaxOutputTokens = 8192,
        },
        ManualSave = new ActivatePptCompletionStageBudgetRequest
        {
            MaxPhysicalCalls = 1, MaxBodyUtf8Bytes = 200_000, MaxOutputTokens = 8192,
        },
    };

    private static string TrustedCommit()
        => DesignArtifactRuntimeBudgetController.ActualRuntimeCommit() ?? new string('a', 40);
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
    public async Task ConcurrentTenantBudgetReservations_AggregateAcrossAppCallers()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.CreateGovernanceIndexesAsync();
        await scope.Context.Database.GetCollection<GatewayTenantGovernanceRecord>("llmgw_tenants")
            .InsertOneAsync(new GatewayTenantGovernanceRecord
            {
                Id = "tenant-a",
                MonthlyBudgetUsd = 1m,
                BudgetReservationUsd = 0.25m,
            });
        var callers = new[]
        {
            new GatewayAppCallerRecord { TenantId = "tenant-a", AppCallerCode = "client-a::chat", RequestType = "chat" },
            new GatewayAppCallerRecord { TenantId = "tenant-a", AppCallerCode = "client-b::chat", RequestType = "chat" },
        };
        var coordinators = Enumerable.Range(0, 20)
            .Select(_ => new GatewayBudgetCoordinator(scope.Context, NullLogger<GatewayBudgetCoordinator>.Instance))
            .ToArray();

        var admissions = await Task.WhenAll(coordinators.Select((coordinator, index) =>
            coordinator.ReserveAsync(callers[index % callers.Length], $"tenant-budget-{index}", CancellationToken.None)));

        admissions.Count(x => x.Allowed).ShouldBe(4);
        admissions.Count(x => x.ErrorCode == "TENANT_MONTHLY_BUDGET_EXCEEDED").ShouldBe(16);
        var month = await scope.Context.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months")
            .Find(x => x.TenantId == "tenant-a"
                       && x.AppCallerCode == GatewayBudgetCoordinator.TenantAggregateAppCallerCode
                       && x.RequestType == GatewayBudgetCoordinator.TenantAggregateRequestType)
            .SingleAsync();
        month.ReservedUsd.ShouldBe(1m);
        admissions.Where(x => x.Allowed).All(x => x.Scope == "tenant").ShouldBeTrue();
    }

    [Fact]
    public async Task TenantBudgetReservations_AreIndependentAcrossTenants()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.CreateGovernanceIndexesAsync();
        await scope.Context.Database.GetCollection<GatewayTenantGovernanceRecord>("llmgw_tenants")
            .InsertManyAsync(new[]
            {
                new GatewayTenantGovernanceRecord { Id = "tenant-a", MonthlyBudgetUsd = 1m, BudgetReservationUsd = 0.5m },
                new GatewayTenantGovernanceRecord { Id = "tenant-b", MonthlyBudgetUsd = 1m, BudgetReservationUsd = 0.5m },
            });
        var coordinator = new GatewayBudgetCoordinator(scope.Context, NullLogger<GatewayBudgetCoordinator>.Instance);

        var admissions = await Task.WhenAll(
            Enumerable.Range(0, 6).Select(index => coordinator.ReserveAsync(
                new GatewayAppCallerRecord { TenantId = "tenant-a", AppCallerCode = "shared::chat", RequestType = "chat" },
                $"tenant-a-{index}",
                CancellationToken.None))
            .Concat(Enumerable.Range(0, 6).Select(index => coordinator.ReserveAsync(
                new GatewayAppCallerRecord { TenantId = "tenant-b", AppCallerCode = "shared::chat", RequestType = "chat" },
                $"tenant-b-{index}",
                CancellationToken.None))));

        admissions.Count(x => x.Allowed).ShouldBe(4);
        var months = await scope.Context.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months")
            .Find(x => x.AppCallerCode == GatewayBudgetCoordinator.TenantAggregateAppCallerCode)
            .ToListAsync();
        months.Count.ShouldBe(2);
        months.Single(x => x.TenantId == "tenant-a").ReservedUsd.ShouldBe(1m);
        months.Single(x => x.TenantId == "tenant-b").ReservedUsd.ShouldBe(1m);
    }

    [Fact]
    public async Task AppCallerBudgetRejection_ReleasesTenantAggregateReservation()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.CreateGovernanceIndexesAsync();
        await scope.Context.Database.GetCollection<GatewayTenantGovernanceRecord>("llmgw_tenants")
            .InsertOneAsync(new GatewayTenantGovernanceRecord
            {
                Id = "tenant-a",
                MonthlyBudgetUsd = 2m,
                BudgetReservationUsd = 0.5m,
            });
        var caller = new GatewayAppCallerRecord
        {
            TenantId = "tenant-a",
            AppCallerCode = "limited-client::chat",
            RequestType = "chat",
            MonthlyBudgetUsd = 0.5m,
            BudgetReservationUsd = 0.5m,
        };
        var coordinator = new GatewayBudgetCoordinator(scope.Context, NullLogger<GatewayBudgetCoordinator>.Instance);

        var first = await coordinator.ReserveAsync(caller, "layered-first", CancellationToken.None);
        var second = await coordinator.ReserveAsync(caller, "layered-second", CancellationToken.None);

        first.Allowed.ShouldBeTrue();
        first.Lease.ShouldNotBeNull();
        first.Lease!.ReservationIds.Count.ShouldBe(2);
        second.Allowed.ShouldBeFalse();
        second.ErrorCode.ShouldBe("APP_CALLER_MONTHLY_BUDGET_EXCEEDED");
        var tenantMonth = await scope.Context.Database.GetCollection<GatewayBudgetMonthRecord>("llmgw_budget_months")
            .Find(x => x.TenantId == "tenant-a" && x.AppCallerCode == GatewayBudgetCoordinator.TenantAggregateAppCallerCode)
            .SingleAsync();
        tenantMonth.ReservedUsd.ShouldBe(0.5m);
        var compensated = await scope.Context.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations")
            .Find(x => x.TenantId == "tenant-a"
                       && x.AppCallerCode == GatewayBudgetCoordinator.TenantAggregateAppCallerCode
                       && x.RequestId == "layered-second")
            .SingleAsync();
        compensated.Status.ShouldBe("released");
        compensated.Detail.ShouldBe("app-caller-budget-rejected");
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
    public async Task ScopedKey_CanInferItsOnlyAppCallerForHeaderlessCompatibleClients()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string key = "llmgw_headerless_client_key";
        var keyRecord = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "cherry-studio",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            SourceSystem = "external",
            ClientCode = "cherry-studio",
            Environment = "production",
            Purpose = "external-platform",
            KeyPrefix = "gwk_cherry",
            AppCallerCodes = ["cherry-studio.desktop::chat"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke", "stream:invoke"],
        };
        await InsertServiceKeyAsync(scope.Context, keyRecord);

        var result = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key,
            "legacy-key",
            "external",
            AppCallerRegistry.PageAgent.Generate,
            "openai-compatible",
            "invoke",
            null,
            CancellationToken.None,
            allowSingleAppCallerInference: true);

        result.Allowed.ShouldBeTrue();
        result.ResolvedAppCallerCode.ShouldBe("cherry-studio.desktop::chat");
        result.TenantId.ShouldBe("tenant-a");

        var streamed = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key,
            "legacy-key",
            "external",
            AppCallerRegistry.PageAgent.Generate,
            "openai-compatible",
            "stream:invoke",
            null,
            CancellationToken.None,
            allowSingleAppCallerInference: true);

        streamed.Allowed.ShouldBeTrue();
        streamed.ResolvedAppCallerCode.ShouldBe("cherry-studio.desktop::chat");

        const string ambiguousKey = "llmgw_ambiguous_client_key";
        await InsertServiceKeyAsync(scope.Context, new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "shared-client",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(ambiguousKey),
            SourceSystem = "external",
            ClientCode = "shared-client",
            Environment = "production",
            Purpose = "external-platform",
            KeyPrefix = "gwk_shared",
            AppCallerCodes = ["client.one::chat", "client.two::chat"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
        });
        var ambiguous = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            ambiguousKey,
            "legacy-key",
            "external",
            AppCallerRegistry.PageAgent.Generate,
            "openai-compatible",
            "invoke",
            null,
            CancellationToken.None,
            allowSingleAppCallerInference: true);

        ambiguous.Allowed.ShouldBeFalse();
        ambiguous.ErrorCode.ShouldBe("GATEWAY_KEY_SCOPE_DENIED");

        const string wildcardKey = "llmgw_wildcard_client_key";
        await InsertServiceKeyAsync(scope.Context, new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "wildcard-client",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(wildcardKey),
            SourceSystem = "external",
            ClientCode = "wildcard-client",
            Environment = "production",
            Purpose = "external-platform",
            KeyPrefix = "gwk_wildcard",
            AppCallerCodes = ["*", "client.one::chat"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
        });
        var wildcard = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            wildcardKey,
            "legacy-key",
            "external",
            AppCallerRegistry.PageAgent.Generate,
            "openai-compatible",
            "invoke",
            null,
            CancellationToken.None,
            allowSingleAppCallerInference: true);

        wildcard.Allowed.ShouldBeTrue();
        wildcard.ResolvedAppCallerCode.ShouldBe(AppCallerRegistry.PageAgent.Generate);
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
    public async Task ScopedSuccessorKey_ReadOnlyPreflightAndOrdinaryRouteDoNotIncrementCutoverEvidence()
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
        var ordinaryRoute = await new GatewayScopedKeyAuthorizer(scope.Context).AuthorizeAsync(
            key, "legacy-key", "map", "weekly-report::chat",
            "gw-native", "route:read", null, CancellationToken.None);

        result.Allowed.ShouldBeTrue();
        ordinaryRoute.Allowed.ShouldBeTrue();
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
    public async Task ProductionCanaryKey_IsRejectedFromOrdinaryRuntimeDataPlane()
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

        result.Allowed.ShouldBeFalse();
        result.StatusCode.ShouldBe(403);
        result.ErrorCode.ShouldBe("GATEWAY_KEY_PURPOSE_DENIED");
        var cutover = await scope.Context.Database.GetCollection<GatewayLegacyKeyCutoverRecord>("llmgw_legacy_key_cutovers")
            .Find(x => x.TenantId == "tenant-a")
            .SingleAsync();
        cutover.SuccessorObservedCount.ShouldBe(0);
        cutover.SuccessorObservationCounts.ContainsKey(record.Id).ShouldBeFalse();
    }

    [Fact]
    public async Task ReleaseGateKey_AllowsOnlyReadOnlyPreflight()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        const string key = "llmgw_release_gate_key";
        var record = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "map-release-gate",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(key),
            KeyPrefix = "gwk_gate",
            SourceSystem = "map",
            ClientCode = "map-release-gate",
            Environment = "production",
            Purpose = "release-gate",
            AppCallerCodes = ["map.chat::chat"],
            IngressProtocols = ["gw-native"],
            Scopes = ["invoke", "route:read"],
        };
        await InsertServiceKeyAsync(scope.Context, record);
        var authorizer = new GatewayScopedKeyAuthorizer(scope.Context);

        var runtime = await authorizer.AuthorizeAsync(
            key, "legacy-key", "map", "map.chat::chat",
            "gw-native", "invoke", null, CancellationToken.None);
        var preflight = await authorizer.AuthorizeAsync(
            key, "legacy-key", "external", string.Empty,
            "gw-native", GatewayLegacyProbeScopes.Route, null, CancellationToken.None);

        runtime.Allowed.ShouldBeFalse();
        runtime.ErrorCode.ShouldBe("GATEWAY_KEY_PURPOSE_DENIED");
        preflight.Allowed.ShouldBeTrue();
    }

    [Fact]
    public async Task CostImportScopeLock_SerializesTenantProviderTeamAndReleasesForRetry()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var locks = scope.Context.Database.GetCollection<BsonDocument>("llmgw_cost_import_scope_locks");
        await locks.Indexes.CreateOneAsync(new CreateIndexModel<BsonDocument>(
            Builders<BsonDocument>.IndexKeys.Ascending("TenantId").Ascending("Provider").Ascending("TeamId"),
            new CreateIndexOptions { Unique = true }));

        var contenders = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ =>
            CostImportScopeLock.TryAcquireAsync(
                locks, "tenant-a", "provider-a", "team-a", CancellationToken.None)));

        contenders.Count(x => x is not null).ShouldBe(1);
        var winner = contenders.Single(x => x is not null)!;
        (await CostImportScopeLock.TryRenewAsync(locks, winner, CancellationToken.None)).ShouldBeTrue();
        var otherTenant = await CostImportScopeLock.TryAcquireAsync(
            locks, "tenant-b", "provider-a", "team-a", CancellationToken.None);
        otherTenant.ShouldNotBeNull();

        await CostImportScopeLock.ReleaseAsync(locks, winner, CancellationToken.None);
        var retry = await CostImportScopeLock.TryAcquireAsync(
            locks, "tenant-a", "provider-a", "team-a", CancellationToken.None);
        retry.ShouldNotBeNull();

        await CostImportScopeLock.ReleaseAsync(locks, retry!, CancellationToken.None);
        await CostImportScopeLock.ReleaseAsync(locks, otherTenant!, CancellationToken.None);
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

        // 限流窗口按墙钟分钟取键：这组请求跨过分钟边界就会插出第二条窗口、计数从头算，
        // 下面的 SingleAsync() 与精确计数都会假红。判据见 RateWindowTiming。
        //
        // **等待必须紧贴着被保护的那批请求**：原来它排在建库、插 key 之前，
        // 那段准备工作要花多久没人知道（建库、建索引都会走网络），等于刚买到的
        // 那点余量在真正发请求之前就被花掉了——判据取的是「等待那一刻」的时钟，
        // 保护的却是几秒之后的请求（形状 5：判据与被判据对象的时序对不上）。
        // 顺带：跳过用例时不再白等一次。
        await Task.Delay(RateWindowTiming.DelayUntilFreshWindow(DateTime.UtcNow, TimeSpan.FromSeconds(5)));

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

        // 等待紧贴被保护的那批请求，不排在建库建索引之前（同上，形状 5）。
        await Task.Delay(RateWindowTiming.DelayUntilFreshWindow(DateTime.UtcNow, TimeSpan.FromSeconds(10)));

        var results = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => authorizer.AuthorizeAsync(
            key, "legacy-key", "external", "caller", "openai-compatible", "invoke",
            null, CancellationToken.None)));

        results.Count(x => x.Allowed).ShouldBe(10);
        results.Count(x => x.StatusCode == 429).ShouldBe(10);
        var window = await windows.Find(x => x.TenantId == "tenant-a" && x.ServiceKeyId == keyRecord.Id).SingleAsync();
        window.Count.ShouldBe(20);
    }

    [Fact]
    public async Task ScopedKey_ConcurrentLimitsAreIndependentAcrossTenantsAndAuditsKeepTenantId()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        const string keyA = "llmgw_test_tenant_a_concurrent_key";
        const string keyB = "llmgw_test_tenant_b_concurrent_key";
        var recordA = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-a",
            Name = "tenant-a-concurrent-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(keyA),
            SourceSystem = "external",
            AppCallerCodes = ["caller"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
            RateLimitPerMinute = 5,
        };
        var recordB = new GatewayServiceKeyRecord
        {
            TenantId = "tenant-b",
            Name = "tenant-b-concurrent-key",
            KeyHash = GatewayScopedKeyAuthorizer.Sha256Hex(keyB),
            SourceSystem = "external",
            AppCallerCodes = ["caller"],
            IngressProtocols = ["openai-compatible"],
            Scopes = ["invoke"],
            RateLimitPerMinute = 5,
        };
        await InsertServiceKeyAsync(scope.Context, recordA);
        await InsertServiceKeyAsync(scope.Context, recordB);
        var windows = scope.Context.Database.GetCollection<GatewayServiceKeyRateWindowRecord>("llmgw_service_key_rate_windows");
        await windows.Indexes.CreateOneAsync(new CreateIndexModel<GatewayServiceKeyRateWindowRecord>(
            Builders<GatewayServiceKeyRateWindowRecord>.IndexKeys
                .Ascending(x => x.TenantId)
                .Ascending(x => x.ServiceKeyId)
                .Ascending(x => x.WindowStart),
            new CreateIndexOptions { Unique = true }));
        var authorizer = new GatewayScopedKeyAuthorizer(scope.Context);

        async Task<(string TenantId, GatewayKeyAuthorization Result)> AuthorizeAsync(string tenantId, string key)
            => (tenantId, await authorizer.AuthorizeAsync(
                key, "legacy-key", "external", "caller", "openai-compatible", "invoke",
                null, CancellationToken.None));

        // 等待紧贴被保护的那批请求，不排在建库建索引之前（同上，形状 5）。
        await Task.Delay(RateWindowTiming.DelayUntilFreshWindow(DateTime.UtcNow, TimeSpan.FromSeconds(10)));

        var results = await Task.WhenAll(
            Enumerable.Range(0, 20).Select(_ => AuthorizeAsync("tenant-a", keyA))
                .Concat(Enumerable.Range(0, 20).Select(_ => AuthorizeAsync("tenant-b", keyB))));

        results.Count(x => x.Result.Allowed).ShouldBe(10);
        results.Count(x => x.Result.StatusCode == 429).ShouldBe(30);
        results.Count(x => x.TenantId == "tenant-a" && x.Result.Allowed).ShouldBe(5);
        results.Count(x => x.TenantId == "tenant-b" && x.Result.Allowed).ShouldBe(5);

        var persistedWindows = await windows.Find(_ => true).ToListAsync();
        persistedWindows.Count.ShouldBe(2);
        persistedWindows.Single(x => x.TenantId == "tenant-a").Count.ShouldBe(20);
        persistedWindows.Single(x => x.TenantId == "tenant-b").Count.ShouldBe(20);

        var audits = await scope.Context.Database.GetCollection<BsonDocument>("llmgw_operation_audits")
            .Find(Builders<BsonDocument>.Filter.Eq("Action", "service_key.rate_limited"))
            .ToListAsync();
        audits.Count.ShouldBe(30);
        audits.Count(x => x["TenantId"] == "tenant-a").ShouldBe(15);
        audits.Count(x => x["TenantId"] == "tenant-b").ShouldBe(15);
    }

    [Fact]
    public async Task RuntimeGrant_IsRunScopedAtomicAndBoundToGatewayIdentity()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        const string key = "gwrg_runtime_test_secret";
        const string caller = "prd-agent-web.web-hosting.generate-html::chat";
        var grants = scope.Context.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants");
        await grants.InsertOneAsync(new GatewayRuntimeGrantRecord
        {
            Id = "grant-1",
            TenantId = GatewayTenantDefaults.InternalTenantId,
            KeyPrefix = "gwrg_runtime",
            KeyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant(),
            RunId = "run-1",
            UserId = "user-1",
            AppCallerCode = caller,
            Environment = "test",
            Model = "default-chat-curated",
            MaxCalls = 1,
            ExpiresAt = DateTime.UtcNow.AddMinutes(10),
            CreatedAt = DateTime.UtcNow,
        });
        var authorizer = new GatewayScopedKeyAuthorizer(scope.Context);

        var inactiveTenant = await authorizer.AuthorizeAsync(
            key, "different-legacy-key", "map", caller, "gw-native", "invoke", null, CancellationToken.None,
            requestPath: "/gw/v1/responses");
        inactiveTenant.StatusCode.ShouldBe(403);
        inactiveTenant.ErrorCode.ShouldBe("GATEWAY_RUNTIME_GRANT_TENANT_INACTIVE");
        await scope.Context.Database.GetCollection<BsonDocument>("llmgw_tenants").InsertOneAsync(new BsonDocument
        {
            { "_id", GatewayTenantDefaults.InternalTenantId },
            { "Status", "active" },
        });

        var wrongCaller = await authorizer.AuthorizeAsync(
            key, "different-legacy-key", "map", "other::chat", "gw-native", "invoke", null, CancellationToken.None,
            requestPath: "/gw/v1/responses");
        var wrongRoute = await authorizer.AuthorizeAsync(
            key, "different-legacy-key", "map", caller, "gw-native", "invoke", null, CancellationToken.None,
            requestPath: "/gw/v1/chat/completions");
        var allowed = await authorizer.AuthorizeAsync(
            key, "different-legacy-key", "map", caller, "gw-native", "invoke", null, CancellationToken.None,
            requestPath: "/gw/v1/responses");
        (await grants.Find(x => x.Id == "grant-1").SingleAsync()).CallCount.ShouldBe(0);
        var counter = new GatewayRuntimeGrantCallCounter(scope.Context);
        var reserved = await counter.TryReserveAsync(
            allowed.RuntimeGrant!,
            new GatewayRuntimeGrantCallRequest("runtime-request-1", 128, 8_192),
            CancellationToken.None);
        var exhausted = await authorizer.AuthorizeAsync(
            key, "different-legacy-key", "map", caller, "gw-native", "invoke", null, CancellationToken.None,
            requestPath: "/gw/v1/responses");

        wrongCaller.StatusCode.ShouldBe(403);
        wrongCaller.ErrorCode.ShouldBe("GATEWAY_RUNTIME_GRANT_SCOPE_DENIED");
        wrongRoute.StatusCode.ShouldBe(403);
        wrongRoute.ErrorCode.ShouldBe("GATEWAY_RUNTIME_GRANT_ROUTE_DENIED");
        allowed.Allowed.ShouldBeTrue();
        allowed.RuntimeGrant.ShouldNotBeNull();
        allowed.RuntimeGrant!.RunId.ShouldBe("run-1");
        allowed.RuntimeGrant.UserId.ShouldBe("user-1");
        reserved.Allowed.ShouldBeTrue();
        exhausted.StatusCode.ShouldBe(429);
        exhausted.ErrorCode.ShouldBe("GATEWAY_RUNTIME_GRANT_EXHAUSTED");
        (await grants.Find(x => x.Id == "grant-1").SingleAsync()).CallCount.ShouldBe(1);
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
                    .Ascending(x => x.TenantId)
                    .Ascending(x => x.AppCallerCode)
                    .Ascending(x => x.RequestType)
                    .Ascending(x => x.MonthStart),
                new CreateIndexOptions { Unique = true }));
            var reservations = Context.Database.GetCollection<GatewayBudgetReservationRecord>("llmgw_budget_reservations");
            await reservations.Indexes.CreateOneAsync(new CreateIndexModel<GatewayBudgetReservationRecord>(
                Builders<GatewayBudgetReservationRecord>.IndexKeys
                    .Ascending(x => x.TenantId)
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
