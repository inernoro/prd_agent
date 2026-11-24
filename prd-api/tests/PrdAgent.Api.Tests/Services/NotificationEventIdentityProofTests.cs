using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class NotificationEventIdentityProofTests
{
    [Fact]
    public async Task SameBusinessKey_MustNotMoveNotificationBetweenRecipients()
    {
        await using var db = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        await db.Context.Users.InsertManyAsync(new[] {
            new User { UserId = "u1", Username = "first", Status = UserStatus.Active, UserType = UserType.Human },
            new User { UserId = "u2", Username = "second", Status = UserStatus.Active, UserType = UserType.Human },
        });
        var service = new AdminNotificationEventService(db.Context, new AdminPushDispatchSignal(), NullLogger<AdminNotificationEventService>.Instance);
        AdminNotificationEventRequest Request(string target) => new() {
            Source = "report-agent", TargetUserId = target, Title = "审核周报", DedupKey = "report-42",
        };
        var first = await service.CreateAsync(Request("u1"), "actor", CancellationToken.None);
        var second = await service.CreateAsync(Request("u2"), "actor", CancellationToken.None);
        Assert.NotEqual(first.Notification.Id, second.Notification.Id);
        Assert.Equal("u1", (await db.Context.AdminNotifications.Find(n => n.Id == first.Notification.Id).SingleAsync()).TargetUserId);
        Assert.Equal(2, await db.Context.AdminNotifications.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task RepeatedSameEvent_MustNotUndoAcknowledgement()
    {
        await using var db = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        var service = new AdminNotificationEventService(db.Context, new AdminPushDispatchSignal(), NullLogger<AdminNotificationEventService>.Instance);
        var request = new AdminNotificationEventRequest { Source = "uptime-alert", Title = "服务不可达", DedupKey = "incident-42" };
        var first = await service.CreateAsync(request, "actor", CancellationToken.None);
        await db.Context.AdminNotifications.UpdateOneAsync(n => n.Id == first.Notification.Id,
            Builders<AdminNotification>.Update.Set(n => n.Status, "handled").Set(n => n.HandledAt, DateTime.UtcNow));
        var repeated = await service.CreateAsync(request, "actor", CancellationToken.None);
        Assert.Equal("handled", repeated.Notification.Status);
        Assert.NotNull(repeated.Notification.HandledAt);
        Assert.Equal(1, await db.Context.AdminNotifications.CountDocumentsAsync(_ => true));
    }
}
