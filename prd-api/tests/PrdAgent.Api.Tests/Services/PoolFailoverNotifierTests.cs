using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.ModelPool;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class PoolFailoverNotifierTests
{
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
                Builders<AdminNotification>.Update.Unset(x => x.Section));
            await notifier.NotifyQuotaExceededAsync("fixture-platform", "fixture-model");
        }

        var stored = await testDb.Context.AdminNotifications.Find(_ => true).SingleAsync();
        stored.Section.ShouldBe(AdminNotificationSections.Admin);
        stored.TargetUserId.ShouldBeNull();
        stored.Id.ShouldBe(original.Id);
        stored.Key.ShouldBe(original.Key);
        stored.Source.ShouldBe("llm-gateway-quota");
        stored.Message.ShouldBe(original.Message);
        var storedMessage = stored.Message;
        Assert.NotNull(storedMessage);
        storedMessage.ShouldContain("fixture-platform");
        storedMessage.ShouldContain("fixture-model");
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
