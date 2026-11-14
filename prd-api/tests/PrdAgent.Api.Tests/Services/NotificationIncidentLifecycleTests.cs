using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class NotificationIncidentLifecycleTests
{
    [Fact]
    public void Digest_DistinguishesNotificationsKnownIncidentsAndOccurrences()
    {
        var digest = AdminPushNotificationService.BuildDigest(new[] {
            new AdminNotification { IncidentId = "quota", Source = "gateway-alert", OccurrenceCount = 182, Title = "线路甲余额不足" },
            new AdminNotification { IncidentId = "quota", Source = "gateway-alert", OccurrenceCount = 182, Title = "同一故障的重复记录" },
            new AdminNotification { IncidentId = "connection", Source = "gateway-alert", OccurrenceCount = 3, Title = "线路乙连接异常" },
            new AdminNotification { Title = "历史告警" },
        }, "u1", DateTime.UtcNow, false);
        Assert.Contains("4 条通知，2 个已识别故障、1 条未分类通知", digest.Title);
        Assert.Contains("185 次", digest.Message);
        Assert.Contains("不代表失败请求数", digest.Message);
    }

    [Fact]
    public async Task ExternalAudience_RequiresActiveHumanAdministratorAndCurrentPermission()
    {
        await using var db = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        await db.Context.Users.InsertManyAsync(new[] {
            new User { UserId = "member", Role = UserRole.DEV, Status = UserStatus.Active, UserType = UserType.Human },
            new User { UserId = "admin", Role = UserRole.ADMIN, Status = UserStatus.Active, UserType = UserType.Human },
        });
        var allow = true;
        var permissions = new Mock<IAdminPermissionService>();
        permissions.Setup(p => p.GetEffectivePermissionsAsync(It.IsAny<string>(), false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(() => allow ? new[] { AdminPermissionCatalog.SettingsWrite } : Array.Empty<string>());
        var audience = new AdminNotificationAudience(db.Context, permissions.Object);
        Assert.False(await audience.CanReceiveAdminAsync("member", default));
        Assert.True(await audience.CanReceiveAdminAsync("admin", default));
        allow = false;
        Assert.False(await audience.CanReceiveAdminAsync("admin", default));
        allow = true;
        await db.Context.Users.UpdateOneAsync(u => u.UserId == "admin", Builders<User>.Update.Set(u => u.Status, UserStatus.Disabled));
        Assert.False(await audience.CanReceiveAdminAsync("admin", default));
    }

    [Fact]
    public async Task DuplicateSnapshots_KeepCountsAndAcknowledgement_RecoveryAndRecurrenceReopen()
    {
        await using var db = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        var service = new AdminNotificationEventService(db.Context, new AdminPushDispatchSignal(), NullLogger<AdminNotificationEventService>.Instance);
        var start = DateTime.UtcNow.AddHours(-1);
        AdminNotificationEventRequest Request(string state, DateTime last, long count, DateTime? recovery = null) => new() {
            Source = "uptime-alert", Title = "预览应用健康检查", IncidentId = "cds-A/project-1/prod/api/check-failed",
            IncidentState = state, FirstOccurredAt = start, LastOccurredAt = last,
            OccurrenceCount = count, RecoveredAt = recovery, Level = "error", RequestOutcome = "unknown",
        };
        var first = await service.CreateAsync(Request("active", start, 1), "actor", CancellationToken.None);
        await db.Context.AdminNotifications.UpdateOneAsync(n => n.Id == first.Notification.Id,
            Builders<AdminNotification>.Update.Set(n => n.Status, "handled"));
        var latest = start.AddMinutes(10);
        for (var i = 0; i < 3; i++)
        {
            var repeated = await service.CreateAsync(Request("active", latest, 182), "actor", CancellationToken.None);
            Assert.Equal(182, repeated.Notification.OccurrenceCount);
            Assert.Equal("handled", repeated.Notification.Status);
            Assert.Equal("active", repeated.Notification.IncidentState);
            Assert.Equal(0, repeated.Notification.PushEpisode);
        }
        var recovered = await service.CreateAsync(Request("recovered", latest, 182, latest.AddMinutes(10)), "actor", CancellationToken.None);
        Assert.Equal("recovered", recovered.Notification.IncidentState);
        Assert.Equal("open", recovered.Notification.Status);
        Assert.Equal(1, recovered.Notification.PushEpisode);
        var lateFailure = await service.CreateAsync(Request("active", latest, 999), "actor", CancellationToken.None);
        Assert.Equal("recovered", lateFailure.Notification.IncidentState);
        Assert.Equal(182, lateFailure.Notification.OccurrenceCount);
        var recurrent = await service.CreateAsync(Request("active", latest.AddMinutes(20), 183), "actor", CancellationToken.None);
        Assert.Equal("active", recurrent.Notification.IncidentState);
        Assert.Null(recurrent.Notification.RecoveredAt);
        Assert.Equal(2, recurrent.Notification.PushEpisode);
        var stale = await service.CreateAsync(Request("recovered", latest, 182, latest.AddMinutes(10)), "actor", CancellationToken.None);
        Assert.Equal("active", stale.Notification.IncidentState);
        Assert.Equal(183, stale.Notification.OccurrenceCount);
        Assert.Equal(1, await db.Context.AdminNotifications.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task RecoveryWithoutEvidence_IsRejected()
    {
        await using var db = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        var service = new AdminNotificationEventService(db.Context, new AdminPushDispatchSignal(), NullLogger<AdminNotificationEventService>.Instance);
        var now = DateTime.UtcNow;
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.CreateAsync(new() {
            Source = "uptime-alert", Title = "恢复", IncidentId = "target", IncidentState = "recovered",
            FirstOccurredAt = now, LastOccurredAt = now,
        }, "actor", CancellationToken.None));
        Assert.Equal(0, await db.Context.AdminNotifications.CountDocumentsAsync(_ => true));
    }

    [Fact]
    public async Task Batch_UsesSnapshotAndLivePermission_ReportsPartialFailure_LeavesIncidentActive()
    {
        await using var db = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        var now = DateTime.UtcNow.AddMinutes(-1);
        now = new DateTime(now.Ticks / TimeSpan.TicksPerMillisecond * TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);
        await db.Context.AdminNotifications.InsertManyAsync(new[] {
            new AdminNotification { Id = "mine", TargetUserId = "u1", Source = "report-agent", UpdatedAt = now, IncidentState = "active" },
            new AdminNotification { Id = "changed", TargetUserId = "u1", Source = "report-agent", UpdatedAt = now.AddSeconds(1), PushEpisode = 1 },
            new AdminNotification { Id = "admin", Source = "gateway-alert", UpdatedAt = now },
            new AdminNotification { Id = "new-after-list", TargetUserId = "u1", Source = "report-agent", UpdatedAt = now },
        });
        var permissions = new Mock<IAdminPermissionService>();
        permissions.Setup(p => p.GetEffectivePermissionsAsync(It.IsAny<string>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(Array.Empty<string>());
        var controller = new NotificationsController(db.Context, null!, null!, new ConfigurationBuilder().Build(), permissions.Object) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(new[] {
                new Claim("sub", "u1"), new Claim(ClaimTypes.Role, "ADMIN"),
                new Claim("permissions", AdminPermissionCatalog.SettingsWrite),
            }, "test")) } },
        };
        var result = Assert.IsType<OkObjectResult>(await controller.HandleBatch(new() { Items = new() {
            new() { Id = "mine", UpdatedAt = now }, new() { Id = "changed", UpdatedAt = now }, new() { Id = "admin", UpdatedAt = now },
        } }));
        var json = JsonSerializer.SerializeToElement(result.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("data");
        Assert.Equal(3, json.GetProperty("requested").GetInt32());
        Assert.Equal(1, json.GetProperty("handled").GetInt32());
        Assert.Equal(2, json.GetProperty("failed").GetInt32());
        var mine = await db.Context.AdminNotifications.Find(n => n.Id == "mine").SingleAsync();
        Assert.Equal("handled", mine.Status);
        Assert.Equal("active", mine.IncidentState);
        Assert.Equal(3, await db.Context.AdminNotifications.CountDocumentsAsync(n => n.Status == "open"));
    }

    [Fact]
    public async Task LegacyGlobalPoolNotifications_RemainAdministratorOnly_EvenWithOldPersonalSection()
    {
        await using var db = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        await db.Context.AdminNotifications.InsertManyAsync(new[] {
            new AdminNotification { Id = "global-pool", Source = "model-pool-probe", Section = "personal" },
            new AdminNotification { Id = "personal-pool", Source = "model-pool-probe", TargetUserId = "u1" },
        });
        var permissions = new Mock<IAdminPermissionService>();
        permissions.Setup(p => p.GetEffectivePermissionsAsync(It.IsAny<string>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(Array.Empty<string>());
        var controller = new NotificationsController(db.Context, null!, null!, new ConfigurationBuilder().Build(), permissions.Object) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(new[] {
                new Claim("sub", "u1"), new Claim(ClaimTypes.Role, "DEV"),
            }, "test")) } },
        };
        var result = Assert.IsType<OkObjectResult>(await controller.List());
        var items = JsonSerializer.SerializeToElement(result.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            .GetProperty("data").GetProperty("items");
        Assert.Equal("personal-pool", Assert.Single(items.EnumerateArray()).GetProperty("id").GetString());
        Assert.IsType<NotFoundObjectResult>(await controller.Handle("global-pool"));
        Assert.Equal("admin", AdminNotificationSourceCatalog.ResolveSection("model-pool-probe", "personal", null));
        Assert.Equal("personal", AdminNotificationSourceCatalog.ResolveSection("model-pool-probe", null, "u1"));
    }

    [Fact]
    public async Task OperationalPermission_DoesNotExposeGatewayObjectsOrActions_WithoutGatewayPermission()
    {
        await using var db = await AdminPushNotificationServiceTests.AdminPushTestDatabase.TryCreateAsync();
        await db.Context.AdminNotifications.InsertOneAsync(new AdminNotification {
            Id = "restricted-gateway", Source = "gateway-alert", Section = "admin", IncidentId = "fixture-route",
            Title = "私有供应商甲 · 模型甲余额不足", Message = "供应商内部诊断", IncidentState = "active",
            RequestOutcome = "fallback_succeeded", EvidenceRequestId = "fixture-request",
            ActionKind = "llm-gateway", ActionUrl = "/logs?requestId=fixture-request",
        });
        var canEnterGateway = false;
        var permissions = new Mock<IAdminPermissionService>();
        permissions.Setup(p => p.GetEffectivePermissionsAsync(It.IsAny<string>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(() => canEnterGateway
                ? new[] { AdminPermissionCatalog.SettingsWrite, AdminPermissionCatalog.LlmGatewayAccess }
                : new[] { AdminPermissionCatalog.SettingsWrite });
        var controller = new NotificationsController(db.Context, null!, null!, new ConfigurationBuilder().Build(), permissions.Object) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(new[] {
                new Claim("sub", "u1"), new Claim(ClaimTypes.Role, "ADMIN"),
            }, "test")) } },
        };
        async Task<JsonElement> Item()
        {
            var result = Assert.IsType<OkObjectResult>(await controller.List());
            return JsonSerializer.SerializeToElement(result.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web))
                .GetProperty("data").GetProperty("items")[0];
        }
        var restricted = await Item();
        Assert.DoesNotContain("私有供应商", restricted.GetProperty("title").GetString());
        Assert.Contains("备用线路成功完成", restricted.GetProperty("message").GetString());
        Assert.Equal(JsonValueKind.Null, restricted.GetProperty("actionUrl").ValueKind);
        Assert.Equal(JsonValueKind.Null, restricted.GetProperty("evidenceRequestId").ValueKind);
        canEnterGateway = true;
        var allowed = await Item();
        Assert.Contains("私有供应商甲", allowed.GetProperty("title").GetString());
        Assert.Equal("/logs?requestId=fixture-request", allowed.GetProperty("actionUrl").GetString());
    }
}
