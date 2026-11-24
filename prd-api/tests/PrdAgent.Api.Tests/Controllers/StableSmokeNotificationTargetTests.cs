using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class StableSmokeNotificationTargetTests
{
    [Fact]
    public void SignedNotification_AllowsOnlyConfiguredUsername()
    {
        var request = new AdminNotificationEventRequest { TargetUsername = "admin" };

        Assert.True(NotificationsController.IsStableSmokeNotificationTargetAllowed(request, "admin"));
        Assert.False(NotificationsController.IsStableSmokeNotificationTargetAllowed(request, "another-user"));
    }

    [Fact]
    public void SignedNotification_RejectsDirectAndMissingTargets()
    {
        Assert.False(NotificationsController.IsStableSmokeNotificationTargetAllowed(
            new AdminNotificationEventRequest { TargetUserId = "user-1" },
            "admin"));
        Assert.False(NotificationsController.IsStableSmokeNotificationTargetAllowed(
            new AdminNotificationEventRequest(),
            "admin"));
        Assert.False(NotificationsController.IsStableSmokeNotificationTargetAllowed(
            new AdminNotificationEventRequest { TargetUsername = "admin", TargetUserId = "user-1" },
            "admin"));
    }
}
