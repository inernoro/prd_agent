using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.ModelPool;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class PoolFailoverNotifierTests
{
    [Theory]
    [InlineData(false, "pool-a")]
    [InlineData(true, "pool-a")]
    [InlineData(false, null)]
    [InlineData(true, null)]
    public async Task ResolutionFailure_PreservesKnownPoolThroughGatewayAndScopedRecovery(bool stream, string? failedPoolId)
    {
        await using var testDb = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        var notifier = new PoolFailoverNotifier(testDb.Context, NullLogger<PoolFailoverNotifier>.Instance);
        // Actual factory shape used by production ApplyCatalogGateAsync: success fields stay unset.
        var failed = ModelResolutionResult.NotFound(null, "模型当前不可用", GatewayRouteFailure.ModelNotInCatalog,
            "model-catalog", "notification.proof::chat", modelPoolId: failedPoolId);
        failed.OriginalPoolId.ShouldBeNull();
        failed.ModelGroupId.ShouldBeNull();
        failed.FailureModelPoolId.ShouldBe(failedPoolId);
        var resolver = new Moq.Mock<IModelResolver>(Moq.MockBehavior.Strict);
        resolver.Setup(x => x.ResolveAsync(Moq.It.IsAny<string>(), Moq.It.IsAny<string>(), Moq.It.IsAny<string?>(),
                Moq.It.IsAny<string?>(), Moq.It.IsAny<string?>(), Moq.It.IsAny<CancellationToken>())).Returns(Task.FromResult(failed));
        var http = new Moq.Mock<IHttpClientFactory>(Moq.MockBehavior.Strict);
        var gateway = new LlmGateway(resolver.Object, http.Object, NullLogger<LlmGateway>.Instance,
            failoverNotifier: notifier);
        var request = new GatewayRequest {
            AppCallerCode = "notification.proof::chat", ModelType = "chat",
            Context = new GatewayRequestContext { UserId = "fixture-user" }
        };
        if (stream)
        {
            var chunks = new List<GatewayStreamChunk>();
            await foreach (var chunk in gateway.StreamAsync(request)) chunks.Add(chunk);
            chunks.ShouldNotBeEmpty();
        }
        else
        {
            var response = await gateway.SendAsync(request);
            response.Success.ShouldBeFalse();
            response.ErrorCode.ShouldBe(GatewayRouteFailure.ModelNotInCatalog);
        }
        http.Verify(x => x.CreateClient(Moq.It.IsAny<string>()), Moq.Times.Never);
        var fault = await testDb.Context.AdminNotifications.Find(x => x.TargetUserId == "fixture-user").SingleAsync();
        fault.IncidentId.ShouldBe(failedPoolId is null ? null : "model-pool:pool-a");
        fault.IncidentState.ShouldBe(failedPoolId is null ? "unknown" : "active");
        fault.RequestOutcome.ShouldBe("request_failed");
        fault.OccurrenceCount.ShouldBe(1);
        await notifier.CloseUserFailureNotificationsAsync("chat", poolId: "pool-b");
        (await testDb.Context.AdminNotifications.Find(x => x.Id == fault.Id).SingleAsync()).Status.ShouldBe("open");
        await notifier.CloseUserFailureNotificationsAsync("chat", poolId: "pool-a");
        var current = await testDb.Context.AdminNotifications.Find(x => x.Id == fault.Id).SingleAsync();
        current.Status.ShouldBe(failedPoolId is null ? "open" : "closed");
        current.IncidentState.ShouldBe(failedPoolId is null ? "unknown" : "recovered");
        var recoveries = await testDb.Context.AdminNotifications.Find(x => x.Level == "success").ToListAsync();
        recoveries.Count.ShouldBe(failedPoolId is null ? 0 : 1);
        if (failedPoolId is not null)
        {
            recoveries[0].IncidentId.ShouldBe(fault.IncidentId);
            recoveries[0].TargetUserId.ShouldBe("fixture-user");
            recoveries[0].RequestOutcome.ShouldBe("unknown"); // Pool health does not redo the failed request.
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task QuotaNotification_ShouldPersistAdminSectionOnInsertAndLegacyUpdate(bool legacyUpdate)
    {
        await using var testDb = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        var notifier = new PoolFailoverNotifier(testDb.Context, NullLogger<PoolFailoverNotifier>.Instance);
        await notifier.NotifyQuotaExceededAsync("fixture-platform", "fixture-model");
        var original = await testDb.Context.AdminNotifications.Find(_ => true).SingleAsync();
        if (legacyUpdate)
        {
            await testDb.Context.AdminNotifications.UpdateOneAsync(x => x.Id == original.Id,
                Builders<AdminNotification>.Update.Unset(x => x.Section)
                    .Unset(x => x.IncidentId).Unset(x => x.IncidentState).Unset(x => x.RequestOutcome)
                    .Unset(x => x.FirstOccurredAt).Unset(x => x.LastOccurredAt)
                    .Set(x => x.OccurrenceCount, 182).Set(x => x.CreatedAt, DateTime.UtcNow.AddDays(-10)));
            await notifier.NotifyQuotaExceededAsync("fixture-platform", "fixture-model");
        }

        var stored = await testDb.Context.AdminNotifications.Find(_ => true).SingleAsync();
        stored.Section.ShouldBe(AdminNotificationSections.Admin);
        stored.TargetUserId.ShouldBeNull();
        stored.Id.ShouldBe(original.Id);
        stored.Key.ShouldBe(original.Key);
        stored.Source.ShouldBe("llm-gateway-quota");
        stored.Title.ShouldBe("fixture-platform · fixture-model：上游额度不足");
        stored.IncidentId.ShouldBe(stored.Key);
        stored.IncidentState.ShouldBe("active");
        stored.RequestOutcome.ShouldBe("unknown");
        stored.OccurrenceCount.ShouldBe(1);
        stored.FirstOccurredAt.ShouldNotBeNull();
        stored.LastOccurredAt.ShouldBe(stored.FirstOccurredAt);
        if (legacyUpdate) Assert.True(stored.FirstOccurredAt > stored.CreatedAt);
        stored.Message.ShouldBe(original.Message);
        var storedMessage = stored.Message;
        Assert.NotNull(storedMessage);
        storedMessage.ShouldContain("fixture-platform");
        storedMessage.ShouldContain("fixture-model");
        storedMessage.ShouldContain("整次请求结果尚未确认");
        storedMessage.ShouldNotContain("本次 AI 创作未完成");
        await notifier.NotifyQuotaExceededAsync("fixture-platform", "fixture-model");
        var repeated = await testDb.Context.AdminNotifications.Find(x => x.Id == stored.Id).SingleAsync();
        repeated.OccurrenceCount.ShouldBe(2);
        repeated.FirstOccurredAt.ShouldBe(stored.FirstOccurredAt);
        Assert.True(repeated.LastOccurredAt >= stored.LastOccurredAt);
    }

    [Theory]
    [InlineData(null, "fixture-model")]
    [InlineData("Bearer sk-fixture-secret", "fixture-model")]
    public async Task QuotaNotification_WithoutSafeObjectEvidence_KeepsIdentityAndOutcomeUnknown(string? platform, string model)
    {
        await using var testDb = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        var notifier = new PoolFailoverNotifier(testDb.Context, NullLogger<PoolFailoverNotifier>.Instance);
        await notifier.NotifyQuotaExceededAsync(platform, model);
        var stored = await testDb.Context.AdminNotifications.Find(_ => true).SingleAsync();
        stored.IncidentId.ShouldBeNull();
        stored.IncidentState.ShouldBe("unknown");
        stored.RequestOutcome.ShouldBe("unknown");
        stored.FirstOccurredAt.ShouldBeNull();
        Assert.DoesNotContain("sk-fixture-secret", stored.Title + stored.Message);
    }

    [Theory]
    [InlineData("same-pool", true)]
    [InlineData("other-pool", true)]
    [InlineData("before-failure", true)]
    [InlineData("expired-recovery", true)]
    [InlineData("handled", false)]
    public async Task Review_LegacyClosedPool_ReopensOnNewConfirmedFailureButHandledDoesNot(string evidence, bool reopen)
    {
        await using var testDb = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        var notifier = new PoolFailoverNotifier(testDb.Context, NullLogger<PoolFailoverNotifier>.Instance);
        var created = DateTime.UtcNow.AddMinutes(-10);
        var legacy = new AdminNotification {
            Id = "legacy-pool-fault", Key = "pool-exhausted:pool-a", Source = "model-pool-probe",
            Section = AdminNotificationSections.Admin, Status = evidence == "handled" ? "handled" : "closed", Level = "warning",
            CreatedAt = created, UpdatedAt = created.AddMinutes(1), HandledAt = created.AddMinutes(1), ExpiresAt = null,
        };
        await testDb.Context.AdminNotifications.InsertOneAsync(legacy);
        if (evidence is not "expired-recovery" and not "handled")
            await testDb.Context.AdminNotifications.InsertOneAsync(new AdminNotification {
                Key = evidence == "other-pool" ? "pool-recovered:pool-b" : "pool-recovered:pool-a",
                Source = "model-pool-probe", Level = "success", Status = "open",
                CreatedAt = evidence == "before-failure" ? created.AddMinutes(-1) : created.AddMinutes(1),
                UpdatedAt = evidence == "before-failure" ? created.AddMinutes(-1) : created.AddMinutes(1),
            });
        await notifier.NotifyPoolExhaustedAsync(new ModelGroup { Id = "pool-a", Name = "所选模型池", ModelType = "image" });
        var current = await testDb.Context.AdminNotifications.Find(x => x.Id == legacy.Id).SingleAsync();
        current.Status.ShouldBe(reopen ? "open" : "handled");
        current.PushEpisode.ShouldBe(reopen ? 1 : 0);
        current.IncidentState.ShouldBe("active");
        current.RecoveredAt.ShouldBeNull();
        current.OccurrenceCount.ShouldBe(1);
    }

    [Fact]
    public async Task UserFailureAndRecovery_ShouldKeepPersonalTargetAcrossUpdates()
    {
        await using var testDb = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        var notifier = new PoolFailoverNotifier(testDb.Context, NullLogger<PoolFailoverNotifier>.Instance);
        await notifier.NotifyUserFailureAsync("u1", "image", "fixture-pool", poolId: "fixture-pool-id");
        var original = await testDb.Context.AdminNotifications.Find(_ => true).SingleAsync();
        AdminNotificationSourceCatalog.ResolveSection(original.Source, original.Section).ShouldBe(AdminNotificationSections.Personal);
        original.TargetUserId.ShouldBe("u1");
        original.ActionUrl.ShouldBeNull();
        await testDb.Context.AdminNotifications.UpdateOneAsync(x => x.Id == original.Id,
            Builders<AdminNotification>.Update.Set(x => x.Section, AdminNotificationSections.Personal));
        await notifier.NotifyUserFailureAsync("u1", "image", "fixture-pool", poolId: "fixture-pool-id");
        var updated = await testDb.Context.AdminNotifications.Find(_ => true).SingleAsync();
        updated.Id.ShouldBe(original.Id);
        updated.Section.ShouldBe(AdminNotificationSections.Personal);
        updated.TargetUserId.ShouldBe("u1");
        updated.Message.ShouldBe(original.Message);
        await notifier.CloseUserFailureNotificationsAsync("image", poolId: "fixture-pool-id");
        var recovery = await testDb.Context.AdminNotifications.Find(x => x.Level == "success" && x.TargetUserId == "u1").SingleAsync();
        recovery.TargetUserId.ShouldBe("u1");
        recovery.RequestOutcome.ShouldBe("unknown");
        recovery.IncidentState.ShouldBe("recovered");
        recovery.OccurrenceCount.ShouldBe(updated.OccurrenceCount);
        recovery.FirstOccurredAt.ShouldBe(updated.FirstOccurredAt);
        recovery.LastOccurredAt.ShouldBe(updated.LastOccurredAt);
        AdminNotificationSourceCatalog.ResolveSection(recovery.Source, recovery.Section).ShouldBe(AdminNotificationSections.Personal);
        (await testDb.Context.AdminNotifications.Find(x => x.Id == original.Id).SingleAsync()).Status.ShouldBe("closed");
    }

    [Fact]
    public async Task ConcurrentFailuresAfterRecovery_OpenOnlyOneEpisodeAndCountEveryFailure()
    {
        await using var testDb = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        var notifier = new PoolFailoverNotifier(testDb.Context, NullLogger<PoolFailoverNotifier>.Instance);
        await notifier.NotifyUserFailureAsync("u1", "image", "所选模型", poolId: "pool-a");
        var original = await testDb.Context.AdminNotifications.Find(x => x.IncidentState == "active").SingleAsync();
        await notifier.CloseUserFailureNotificationsAsync("image", poolId: "pool-a");
        const int newFailures = 24;
        await Task.WhenAll(Enumerable.Range(0, newFailures)
            .Select(_ => notifier.NotifyUserFailureAsync("u1", "image", "所选模型", poolId: "pool-a")));
        var current = await testDb.Context.AdminNotifications.Find(x => x.Id == original.Id).SingleAsync();
        current.PushEpisode.ShouldBe(1);
        current.OccurrenceCount.ShouldBe(1 + newFailures);
        current.Status.ShouldBe("open");
        current.IncidentState.ShouldBe("active");
        current.RecoveredAt.ShouldBeNull();
    }

    [Fact]
    public async Task RecoveryOfOnePool_CannotCloseOtherPoolOrUnattributedLegacyFailure()
    {
        await using var testDb = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        var notifier = new PoolFailoverNotifier(testDb.Context, NullLogger<PoolFailoverNotifier>.Instance);
        await notifier.NotifyUserFailureAsync("u1", "image", "模型甲", poolId: "pool-a");
        await notifier.NotifyUserFailureAsync("u1", "image", "模型乙", poolId: "pool-b");
        await notifier.NotifyUserFailureAsync("u1", "image", "历史模型");
        await notifier.CloseUserFailureNotificationsAsync("image", poolId: "pool-a");
        var notices = await testDb.Context.AdminNotifications.Find(_ => true).ToListAsync();
        var recovered = notices.Single(x => x.IncidentId == "model-pool:pool-a" && x.Level == "warning");
        recovered.IncidentState.ShouldBe("recovered");
        recovered.Status.ShouldBe("closed");
        recovered.RecoveredAt.ShouldNotBeNull();
        var other = notices.Single(x => x.IncidentId == "model-pool:pool-b");
        other.IncidentState.ShouldBe("active");
        other.Status.ShouldBe("open");
        other.RecoveredAt.ShouldBeNull();
        notices.Single(x => x.IncidentId == null).Status.ShouldBe("open");
        await notifier.CloseUserFailureNotificationsAsync("image");
        (await testDb.Context.AdminNotifications.Find(x => x.Id == other.Id).SingleAsync()).Status.ShouldBe("open");
    }

    [Fact]
    public async Task GlobalPoolHealthNotifications_AreAdminOnlyAndKeepRecoveryEvidence()
    {
        await using var testDb = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        var notifier = new PoolFailoverNotifier(testDb.Context, NullLogger<PoolFailoverNotifier>.Instance);
        var pool = new ModelGroup { Id = "future-pool", Name = "未来模型池", ModelType = "image" };
        await notifier.NotifyPoolExhaustedAsync(pool);
        var fault = await testDb.Context.AdminNotifications.Find(x => x.Level == "warning").SingleAsync();
        fault.Section.ShouldBe(AdminNotificationSections.Admin);
        fault.IncidentState.ShouldBe("active");
        fault.ActionUrl.ShouldBe("/logs?modelPoolId=future-pool");
        fault.ActionKind.ShouldBe("llm-gateway");
        Assert.NotNull(fault.Message);
        fault.Message.ShouldNotContain("全部失败");
        await notifier.NotifyPoolRecoveredAsync(pool, "future-model-z", TimeSpan.Zero);
        fault = await testDb.Context.AdminNotifications.Find(x => x.Id == fault.Id).SingleAsync();
        fault.IncidentState.ShouldBe("recovered");
        var recovery = await testDb.Context.AdminNotifications.Find(x => x.Level == "success").SingleAsync();
        recovery.Section.ShouldBe(AdminNotificationSections.Admin);
        recovery.ActionUrl.ShouldBe("/logs?modelPoolId=future-pool");
        recovery.ActionLabel.ShouldBe("查看线路日志");
        recovery.RecoveredAt.ShouldNotBeNull();
        Assert.NotNull(recovery.Message);
        recovery.Message.ShouldContain("完整故障持续时间未确认");
    }

    [Fact]
    public void QuotaAlert_CdsPreview_IncludesBranchEnvironmentModelAndPlatform()
    {
        var values = new Dictionary<string, string?>
        {
            ["CDS_PROJECT_ID"] = "project-1",
            ["VITE_GIT_BRANCH"] = "fix/quota-alert",
            ["ASPNETCORE_ENVIRONMENT"] = "Production",
        };

        var environment = PoolFailoverNotifier.ResolveQuotaEnvironment(
            name => values.GetValueOrDefault(name));
        var message = PoolFailoverNotifier.BuildQuotaNotificationMessage(
            environment.Label,
            "OpenRouter",
            "anthropic/claude-sonnet");

        environment.Label.ShouldBe("CDS 预览环境（分支：fix/quota-alert）");
        message.ShouldContain("环境：CDS 预览环境（分支：fix/quota-alert）");
        message.ShouldContain("模型：anthropic/claude-sonnet");
        message.ShouldContain("平台：OpenRouter");
        message.ShouldNotContain("Key limit exceeded");
    }

    [Fact]
    public void QuotaAlert_Production_UsesFormalEnvironmentLabel()
    {
        var values = new Dictionary<string, string?>
        {
            ["ASPNETCORE_ENVIRONMENT"] = "Production",
        };

        var environment = PoolFailoverNotifier.ResolveQuotaEnvironment(
            name => values.GetValueOrDefault(name));

        environment.Label.ShouldBe("正式环境");
        environment.Identity.ShouldBe("production");
    }

    [Fact]
    public void QuotaAlert_DedupKey_IsolatedByEnvironmentAndModel()
    {
        var first = PoolFailoverNotifier.BuildQuotaNotificationKey(
            "cds:project-1:branch-a",
            "OpenRouter",
            "model-a");
        var otherModel = PoolFailoverNotifier.BuildQuotaNotificationKey(
            "cds:project-1:branch-a",
            "OpenRouter",
            "model-b");
        var otherEnvironment = PoolFailoverNotifier.BuildQuotaNotificationKey(
            "production",
            "OpenRouter",
            "model-a");

        first.ShouldStartWith("llm-quota-exceeded:v2:");
        otherModel.ShouldNotBe(first);
        otherEnvironment.ShouldNotBe(first);
    }
}
