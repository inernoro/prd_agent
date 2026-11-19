using MongoDB.Bson;
using MongoDB.Driver;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed partial class GatewayIncidentEpisodeDeliveryTests
{
    [Fact]
    public async Task IncidentFollowUp_KeepsOwnerAcrossEscalation_ArchivesEvidenceAndResetsOnRecurrence()
    {
        await using var f = await Fixture.CreateAsync();
        await f.Db.Users.InsertManyAsync(new[] {
            new User { UserId = "on-call-a", DisplayName = "值班甲", Status = UserStatus.Active, UserType = UserType.Human },
            new User { UserId = "on-call-b", DisplayName = "值班乙", Status = UserStatus.Active, UserType = UserType.Human },
        });
        NotificationsController Controller(string userId, bool gateway, bool admin = true)
        {
            var permissions = new Mock<IAdminPermissionService>();
            permissions.Setup(x => x.GetEffectivePermissionsAsync(userId, false, It.IsAny<CancellationToken>()))
                .ReturnsAsync(gateway ? [AdminPermissionCatalog.SettingsWrite, AdminPermissionCatalog.LlmGatewayAccess]
                    : new[] { AdminPermissionCatalog.SettingsWrite });
            return new NotificationsController(f.Db, null!, null!, new ConfigurationBuilder().Build(), permissions.Object)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(
                    new[] { new Claim("sub", userId), new Claim(ClaimTypes.Role, admin ? "ADMIN" : "DEV") }, "fixture")) } },
            };
        }
        static JsonElement Data(IActionResult response) => JsonSerializer.SerializeToElement(
            Assert.IsType<OkObjectResult>(response).Value, new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("data");
        await f.LogRouteAsync("fallback", -240, fallback: true);
        await f.SweepAsync();
        var fault = await f.Db.AdminNotifications.Find(x => x.IncidentState == "active").SingleAsync();
        Assert.Equal("warning", fault.Level);
        Assert.Equal("fallback_succeeded", Assert.Single(fault.IncidentEvidence!).Outcome);
        var a = Controller("on-call-a", gateway: true);
        var b = Controller("on-call-b", gateway: false);
        var take = new IncidentAssignmentRequest { Episode = 0, Claim = true };
        var attempts = await Task.WhenAll(a.AssignIncident(fault.Id, take, default), b.AssignIncident(fault.Id, take, default));
        Assert.Single(attempts.OfType<OkObjectResult>());
        Assert.Single(attempts.OfType<ConflictObjectResult>());
        var winner = attempts[0] is OkObjectResult ? a : b;
        var watcher = attempts[0] is OkObjectResult ? b : a;
        var owner = winner == a ? "on-call-a" : "on-call-b";
        Assert.IsType<ConflictObjectResult>(await watcher.AssignIncident(fault.Id, new() { Episode = 0, Claim = false }, default));
        Assert.IsType<OkObjectResult>(await winner.Handle(fault.Id));
        var handled = Assert.Single(Data(await winner.List(state: "incidents")).GetProperty("items").EnumerateArray());
        Assert.Equal("handled", handled.GetProperty("status").GetString());
        var redacted = Assert.Single(Data(await b.List(state: "incidents")).GetProperty("items").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, redacted.GetProperty("incidentFollowUp").GetProperty("evidence")[0].GetProperty("requestId").ValueKind);
        var hidden = Data(await Controller("on-call-a", gateway: false, admin: false).List(state: "incidents"));
        Assert.Empty(hidden.GetProperty("items").EnumerateArray());

        await f.LogRouteAsync("failed", -180, failed: true);
        await f.SweepAsync();
        var escalated = await f.FaultAsync();
        Assert.Equal(1, escalated.PushEpisode);
        Assert.Equal(0, escalated.IncidentEpisode);
        Assert.Equal(owner, escalated.IncidentOwnerUserId);
        Assert.Equal(new[] { "fallback", "failed" }, escalated.IncidentEvidence!.Select(x => x.RequestId));

        await f.LogRouteAsync("recovered", -120);
        await f.SweepAsync();
        var restored = Assert.Single(Data(await a.List(state: "incidents")).GetProperty("items").EnumerateArray());
        Assert.Equal("recovered", restored.GetProperty("incidentState").GetString());
        Assert.Equal("recovered", restored.GetProperty("incidentFollowUp").GetProperty("evidence")[2].GetProperty("outcome").GetString());
        Assert.IsType<ConflictObjectResult>(await winner.AssignIncident(fault.Id, new() { Episode = 0, Claim = false }, default));

        await f.LogRouteAsync("recurrence", -60, failed: true);
        await f.SweepAsync();
        var next = await f.FaultAsync();
        Assert.Equal(fault.Id, next.Id);
        Assert.Equal(2, next.IncidentEpisode);
        Assert.Null(next.IncidentOwnerUserId);
        Assert.Equal("recurrence", Assert.Single(next.IncidentEvidence!).RequestId);
        var history = await f.Db.AdminNotifications.Find(x => x.Level == "success").SingleAsync();
        Assert.Equal(owner, history.IncidentOwnerUserId);
        Assert.Equal(new[] { "fallback", "failed", "recovered" }, history.IncidentEvidence!.Select(x => x.RequestId));
        Assert.IsType<ConflictObjectResult>(await winner.AssignIncident(fault.Id, take, default));
        Assert.IsType<OkObjectResult>(await winner.AssignIncident(fault.Id, new() { Episode = 2, Claim = true }, default));
        Assert.IsType<OkObjectResult>(await winner.AssignIncident(fault.Id, new() { Episode = 2, Claim = false }, default));
        Assert.Equal("active", (await f.FaultAsync()).IncidentState);
    }

    [Fact]
    public async Task Integration_ReopenedGatewayEpisodeUsesUrgentBudgetAfterOrdinaryBudgetExhaustion()
    {
        await using var f = await Fixture.CreateAsync();
        for (var i = 0; i < 2; i++)
        {
            await f.Db.AdminNotifications.InsertOneAsync(new AdminNotification {
                Id = "ordinary-" + i, Key = "ordinary-" + i, Level = "warning", Source = "gateway-alert",
                Title = "普通通知", Message = "已有普通配额", Status = "open",
                CreatedAt = f.Clock.GetUtcNow().UtcDateTime.AddMinutes(-1),
            });
            await f.DispatchAsync();
            f.Clock.Advance(TimeSpan.FromSeconds(61));
        }
        Assert.Equal(2, f.Http.Calls);
        await f.LogAsync("episode-zero", "failed", -180); await f.SweepAsync(); await f.DispatchAsync();
        Assert.Equal(3, f.Http.Calls);
        var original = await f.FaultAsync();
        await f.LogAsync("recovery", "succeeded", -120); await f.SweepAsync();
        await f.LogAsync("recurrence", "failed", -60); await f.SweepAsync();
        var reopened = await f.FaultAsync();
        Assert.Equal(original.Id, reopened.Id);
        Assert.Equal(original.PushEpisode + 1, reopened.PushEpisode);
        f.Clock.Advance(TimeSpan.FromSeconds(61));
        await f.DispatchAsync();
        Assert.Equal(4, f.Http.Calls);
        var budget = await f.Db.Database.GetCollection<BsonDocument>("admin_push_dispatch_state")
            .Find(_ => true).SingleAsync();
        var attempts = budget["attemptHistory"].AsBsonArray;
        Assert.Equal(2, attempts.Count(x => !x["urgent"].AsBoolean));
        Assert.Equal(2, attempts.Count(x => x["urgent"].AsBoolean));
        Assert.True(attempts.Count <= 7);
        Assert.True(await f.Db.AdminPushDeliveryLogs.Find(x => x.Success
            && x.CoveredNotificationDeliveryKeys.Contains(reopened.Id + ":episode:" + reopened.PushEpisode)).AnyAsync());
        await f.DispatchAsync();
        Assert.Equal(4, f.Http.Calls);
    }

    [Fact]
    public void Integration_LongFailureIsNotHiddenByLaterStartedEarlierCompletedSuccess()
    {
        var now = DateTime.UtcNow;
        LlmRequestLog Log(string id, string status, DateTime started, DateTime ended) => new() {
            Id = id, RequestId = id, Status = status, StatusCode = status == "failed" ? 502 : 200,
            TenantId = "completion-fixture", Provider = "fixture", Model = "fixture-model",
            StartedAt = started, EndedAt = ended,
        };
        var signal = Assert.Single(PrdAgent.Api.Services.LlmGatewayIncidentPolicy.BuildSignals([
            Log("long-failure", "failed", now.AddMinutes(-2), now),
            Log("short-success", "succeeded", now.AddMinutes(-1), now.AddSeconds(-30)),
        ]));
        Assert.True(signal.IsFailure);
        Assert.Equal("long-failure", signal.RequestId);
    }
}
