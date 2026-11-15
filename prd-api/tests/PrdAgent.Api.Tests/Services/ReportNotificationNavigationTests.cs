using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Services.ReportAgent;
using System.Reflection;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class ReportNotificationNavigationTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ReportSchedule_RespectsExistingDeploymentAuthority(bool preview)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["CDS_PROJECT_ID"] = preview ? "memory-preview" : null,
            ["Deployment:Identity"] = "memory-authority",
            ["Deployment:SharedScheduledWorkEnabled"] = preview ? "false" : "true",
            ["PlatformKeyIntegrity:ManageGlobalNotification"] = "true"
        }).Build();
        using var services = new ServiceCollection().AddSingleton<IConfiguration>(config).BuildServiceProvider();
        using var worker = new ReportAutoGenerateWorker(services.GetRequiredService<IServiceScopeFactory>(), NullLogger<ReportAutoGenerateWorker>.Instance);
        await worker.StartAsync(CancellationToken.None);
        try { Assert.Equal(preview, worker.ExecuteTask?.IsCompletedSuccessfully == true); }
        finally { await worker.StopAsync(CancellationToken.None); }
    }

    [Theory]
    [InlineData("report-auto-gen:owner:2026-W46", "/report-agent?tab=report&weekYear=2026&weekNumber=46")]
    [InlineData("report-agent:deadline:owner:2026-46", "/report-agent?tab=report&weekYear=2026&weekNumber=46")]
    [InlineData("report-agent:overdue:owner:2026-45", "/report-agent?tab=report&weekYear=2026&weekNumber=45")]
    [InlineData("report-agent:draft:report-id", "/report-agent?tab=report&report=report-id")]
    [InlineData("report-agent:submitted:report-id", "/report-agent/report/report-id")]
    public void RealDto_UsesKnownIdentity_NotDefaultLandingPreference(string key, string expected)
    {
        var notification = new AdminNotification
        {
            Source = "report-agent", TargetUserId = "owner", Key = key,
            ActionUrl = "/report-agent", Title = "标题不决定对象"
        };
        var method = typeof(NotificationsController).GetMethod("ToNotificationDto", BindingFlags.Static | BindingFlags.NonPublic)!;
        var dto = method.Invoke(null, new object[] { notification, false })!;
        Assert.Equal(expected, dto.GetType().GetProperty("actionUrl")!.GetValue(dto));
        Assert.Equal("open", notification.Status);
        Assert.Null(notification.HandledAt);
    }

    [Theory]
    [InlineData("report-auto-gen:someone-else:2026-W46")]
    [InlineData("report-agent:deadline:owner:2026-99")]
    [InlineData("report-agent:deadline:owner:2025-53")]
    [InlineData("unidentified-key")]
    public void LegacyWithoutReliableIdentity_IsNotGuessedFromTitle(string key)
    {
        var notification = new AdminNotification { Source = "report-agent", TargetUserId = "owner", Key = key, ActionUrl = "/report-agent", Title = "2026年第46周的报告" };
        Assert.Equal("/report-agent", ReportNotificationNavigation.Resolve(notification));
        notification.ActionUrl = "/report-agent/monthly/explicit-id";
        Assert.Equal(notification.ActionUrl, ReportNotificationNavigation.Resolve(notification));
    }
}
