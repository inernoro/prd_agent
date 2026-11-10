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
        await notifier.NotifyUserFailureAsync("u1", "image", "fixture-pool");
        var original = await testDb.Context.AdminNotifications.Find(_ => true).SingleAsync();
        AdminNotificationSourceCatalog.ResolveSection(original.Source, original.Section).ShouldBe(AdminNotificationSections.Personal);
        original.TargetUserId.ShouldBe("u1");
        await testDb.Context.AdminNotifications.UpdateOneAsync(x => x.Id == original.Id,
            Builders<AdminNotification>.Update.Set(x => x.Section, AdminNotificationSections.Personal));
        await notifier.NotifyUserFailureAsync("u1", "image", "fixture-pool");
        var updated = await testDb.Context.AdminNotifications.Find(_ => true).SingleAsync();
        updated.Id.ShouldBe(original.Id);
        updated.Section.ShouldBe(AdminNotificationSections.Personal);
        updated.TargetUserId.ShouldBe("u1");
        updated.Message.ShouldBe(original.Message);
        await notifier.CloseUserFailureNotificationsAsync("image");
        var recovery = await testDb.Context.AdminNotifications.Find(x => x.Key == "pool-recovered-user:u1:image").SingleAsync();
        recovery.TargetUserId.ShouldBe("u1");
        AdminNotificationSourceCatalog.ResolveSection(recovery.Source, recovery.Section).ShouldBe(AdminNotificationSections.Personal);
        (await testDb.Context.AdminNotifications.Find(x => x.Id == original.Id).SingleAsync()).Status.ShouldBe("closed");
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
