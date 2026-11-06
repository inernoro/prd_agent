using System.Collections.Concurrent;
using System.Net;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductScheduledNotificationLifecycleTests
{
    private const string TestUrl = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=unit-test-only";

    [Fact]
    public async Task FutureTaskWaitsAndDueSingleTaskSendsOnceAcrossConcurrentWorkers()
    {
        await using var fixture = new Fixture();
        var task = fixture.Task();
        task.NextRunAt = DateTime.UtcNow.AddHours(1);
        await fixture.Db.ProductScheduledNotifications.InsertOneAsync(task);
        await fixture.Worker().ProcessNextAsync(CancellationToken.None);
        Assert.Empty(fixture.Http.Bodies);
        Assert.True((await fixture.Saved(task.Id)).Enabled);

        await fixture.Db.ProductScheduledNotifications.UpdateOneAsync(x => x.Id == task.Id,
            Builders<ProductScheduledNotification>.Update.Set(x => x.NextRunAt, DateTime.UtcNow.AddMinutes(-1)));
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => fixture.Worker().ProcessNextAsync(CancellationToken.None)));
        await fixture.Worker().ProcessNextAsync(CancellationToken.None);

        var saved = await fixture.Saved(task.Id);
        Assert.True(saved.Enabled);
        Assert.Null(saved.NextRunAt);
        Assert.NotNull(saved.LastRunAt);
        Assert.Equal("sent", saved.LastResult);
        Assert.True(saved.HasCompletedOneTimeSchedule());
        using var body = JsonDocument.Parse(Assert.Single(fixture.Http.Bodies));
        Assert.Equal("@all", Assert.Single(body.RootElement.GetProperty("text").GetProperty("mentioned_list").EnumerateArray()).GetString());

        var controller = fixture.Controller();
        Assert.IsType<OkObjectResult>(await controller.SetScheduledNotificationEnabled(task.Id, new(false, saved.Revision), fixture.Configuration));
        var disabled = await fixture.Saved(task.Id);
        Assert.False(disabled.IsScheduleEnabled());
        Assert.IsType<OkObjectResult>(await controller.SetScheduledNotificationEnabled(task.Id, new(true, disabled.Revision), fixture.Configuration));
        var reenabled = await fixture.Saved(task.Id);
        Assert.True(reenabled.IsScheduleEnabled());
        Assert.Null(reenabled.NextRunAt);

        var unchanged = fixture.Input() with { Name = "只编辑标题", Revision = reenabled.Revision };
        Assert.IsType<OkObjectResult>(await controller.UpdateScheduledNotification(task.Id, unchanged, fixture.Protection, fixture.Configuration));
        var stillSent = await fixture.Saved(task.Id);
        Assert.Null(stillSent.NextRunAt);
        Assert.Equal(ProductNotificationOneTimeRunState.Sent, stillSent.GetOneTimeRunState());
        Assert.Single(fixture.Http.Bodies);

        var changed = unchanged with { Time = "19:30", Revision = stillSent.Revision };
        Assert.IsType<OkObjectResult>(await controller.UpdateScheduledNotification(task.Id, changed, fixture.Protection, fixture.Configuration));
        var rescheduled = await fixture.Saved(task.Id);
        Assert.True(rescheduled.NextRunAt > DateTime.UtcNow);
        Assert.Equal(ProductNotificationOneTimeRunState.Pending, rescheduled.GetOneTimeRunState());
        Assert.Equal("sent", rescheduled.LastResult);
        await fixture.Db.ProductScheduledNotifications.UpdateOneAsync(x => x.Id == task.Id,
            Builders<ProductScheduledNotification>.Update.Set(x => x.NextRunAt, DateTime.UtcNow.AddMinutes(-1)));
        await fixture.Worker().ProcessNextAsync(CancellationToken.None);
        Assert.Equal(2, fixture.Http.Bodies.Count);
        Assert.True((await fixture.Saved(task.Id)).IsScheduleEnabled());
    }

    [Fact]
    public async Task CopyInheritsProtectedWebhookAndCanReplaceItWithoutChangingTheOriginal()
    {
        await using var fixture = new Fixture();
        var source = fixture.Task();
        source.Enabled = false;
        source.NextRunAt = null;
        source.Date = DateTime.UtcNow.AddHours(8).AddDays(-1).ToString("yyyy-MM-dd");
        source.LastRunAt = DateTime.UtcNow.AddMinutes(-1);
        source.LastResult = "sent";
        var protector = fixture.Protection.CreateProtector(ProductScheduledNotificationTiming.ProtectionPurpose);
        source.ProtectedWebhooks = [source.ProtectedWebhook, protector.Protect(TestUrl + "-second")];
        await fixture.Db.ProductScheduledNotifications.InsertOneAsync(source);

        var created = Assert.IsType<OkObjectResult>(await fixture.Controller().CreateScheduledNotification(
            fixture.Input() with
            {
                SourceTaskId = source.Id, SourceRevision = source.Revision,
                Name = source.Name, Message = source.Message, Date = source.Date, Enabled = false,
                Webhooks = [new(0, null), new(1, null)],
            }, fixture.Protection, fixture.Configuration));
        var copy = await fixture.Db.ProductScheduledNotifications.Find(x => x.Id != source.Id).SingleAsync();
        Assert.NotEqual(source.Id, copy.Id);
        Assert.Equal(source.Name, copy.Name);
        Assert.Equal(source.Date, copy.Date);
        Assert.Equal(source.GetProtectedWebhooks(), copy.GetProtectedWebhooks());
        Assert.True(copy.Enabled);
        Assert.Null(copy.NextRunAt);
        Assert.Null(copy.LastRunAt);
        Assert.Null(copy.LastResult);
        Assert.Equal(ProductNotificationOneTimeRunState.Sent, copy.GetOneTimeRunState());
        var response = JsonSerializer.Serialize(created.Value);
        Assert.DoesNotContain(TestUrl, response);
        Assert.All(copy.GetProtectedWebhooks(), encrypted => Assert.DoesNotContain(encrypted, response));
        Assert.Contains("key=********", response);

        var replacement = TestUrl + "-replacement";
        var updated = fixture.Input() with { Date = copy.Date, Revision = copy.Revision, Webhooks = [new(0, null), new(null, replacement)] };
        Assert.IsType<OkObjectResult>(await fixture.Controller().UpdateScheduledNotification(copy.Id, updated, fixture.Protection, fixture.Configuration));
        var stored = await fixture.Saved(copy.Id);
        Assert.Equal(new[] { TestUrl, replacement }, stored.GetProtectedWebhooks().Select(value => protector.Unprotect(value)));
        Assert.Equal(source.GetProtectedWebhooks(), (await fixture.Saved(source.Id)).GetProtectedWebhooks());
        Assert.Empty(fixture.Http.Bodies);
    }

    [Fact]
    public async Task DisabledTaskWaitsThenSendsToEachDistinctWebhookAndRecordsPartialOutcome()
    {
        await using var fixture = new Fixture();
        var controller = fixture.Controller();
        var input = fixture.Input() with { Enabled = false, Webhooks = [new(null, TestUrl), new(null, TestUrl + "-failed"), new(null, TestUrl + "-unknown")] };
        Assert.IsType<BadRequestObjectResult>(await controller.CreateScheduledNotification(input with
        {
            Webhooks = [new(null, TestUrl), new(null, TestUrl.Replace("weixin.qq.com", "weixin.qq.com:443"))],
        }, fixture.Protection, fixture.Configuration));
        Assert.IsType<OkObjectResult>(await controller.CreateScheduledNotification(input, fixture.Protection, fixture.Configuration));
        var saved = await fixture.Db.ProductScheduledNotifications.Find(FilterDefinition<ProductScheduledNotification>.Empty).SingleAsync();
        Assert.Null(saved.NextRunAt);
        await fixture.Worker().ProcessNextAsync(CancellationToken.None);
        Assert.Empty(fixture.Http.Urls);

        Assert.IsType<OkObjectResult>(await controller.SetScheduledNotificationEnabled(saved.Id, new(true, saved.Revision), fixture.Configuration));
        Assert.True((await fixture.Saved(saved.Id)).NextRunAt > DateTime.UtcNow);
        await fixture.Db.ProductScheduledNotifications.UpdateOneAsync(x => x.Id == saved.Id,
            Builders<ProductScheduledNotification>.Update.Set(x => x.NextRunAt, DateTime.UtcNow.AddMinutes(-1)));
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => fixture.Worker().ProcessNextAsync(CancellationToken.None)));
        Assert.Equal(new[] { TestUrl, TestUrl + "-failed", TestUrl + "-unknown" }, fixture.Http.Urls.OrderBy(x => x, StringComparer.Ordinal));
        var completed = await fixture.Saved(saved.Id);
        Assert.Equal("partial", completed.LastResult);
        Assert.Equal(new ProductNotificationDelivery(1, 1, 1), completed.LastDelivery);
        Assert.True(completed.HasCompletedOneTimeSchedule());
    }

    [Fact]
    public async Task ExpiredTaskCanBeEnabledAndCopiedAfterExplicitDisableWithoutSending()
    {
        await using var fixture = new Fixture();
        var controller = fixture.Controller();
        var input = fixture.Input() with
        {
            Date = DateTime.UtcNow.AddHours(8).AddDays(-1).ToString("yyyy-MM-dd"), Enabled = false, WebhookUrl = TestUrl,
        };
        Assert.IsType<OkObjectResult>(await controller.CreateScheduledNotification(input, fixture.Protection, fixture.Configuration));
        var task = await fixture.Db.ProductScheduledNotifications.Find(FilterDefinition<ProductScheduledNotification>.Empty).SingleAsync();
        Assert.IsType<OkObjectResult>(await controller.SetScheduledNotificationEnabled(task.Id, new(true, task.Revision), fixture.Configuration));
        var enabled = await fixture.Saved(task.Id);
        Assert.True(enabled.IsScheduleEnabled());
        Assert.Null(enabled.NextRunAt);
        Assert.IsType<OkObjectResult>(await controller.SetScheduledNotificationEnabled(task.Id, new(false, enabled.Revision), fixture.Configuration));
        var disabled = await fixture.Saved(task.Id);
        Assert.IsType<OkObjectResult>(await controller.CreateScheduledNotification(input with
        {
            Enabled = true, SourceTaskId = task.Id, SourceRevision = disabled.Revision, WebhookUrl = null,
        }, fixture.Protection, fixture.Configuration));
        var copy = await fixture.Db.ProductScheduledNotifications.Find(x => x.Id != task.Id).SingleAsync();
        Assert.False(copy.IsScheduleEnabled());
        await fixture.Worker().ProcessNextAsync(CancellationToken.None);
        Assert.Empty(fixture.Http.Bodies);
    }

    [Fact]
    public async Task SavedGroupSelectionKeepsOriginalNameAndDestinationWhenDirectoryChanges()
    {
        await using var fixture = new Fixture();
        var controller = fixture.Controller();
        var created = Assert.IsType<OkObjectResult>(await controller.CreateNotificationGroup(
            new("运营群", TestUrl, null), fixture.Protection, fixture.Configuration));
        Assert.DoesNotContain(TestUrl, JsonSerializer.Serialize(created.Value));
        var settings = await fixture.Db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).SingleAsync();
        var group = Assert.Single(settings.ScheduledNotificationGroups!.Items);
        Assert.DoesNotContain(TestUrl, group.ProtectedWebhook);

        var input = fixture.Input() with { Webhooks = [new(null, null, group.Id, group.Revision)] };
        Assert.IsType<OkObjectResult>(await controller.CreateScheduledNotification(input, fixture.Protection, fixture.Configuration));
        var saved = await fixture.Db.ProductScheduledNotifications.Find(FilterDefinition<ProductScheduledNotification>.Empty).SingleAsync();
        Assert.Equal("运营群", Assert.Single(saved.WebhookGroupNames!));
        Assert.Equal(group.ProtectedWebhook, Assert.Single(saved.GetProtectedWebhooks()));

        var replacement = TestUrl + "-replacement";
        Assert.IsType<OkObjectResult>(await controller.UpdateNotificationGroup(group.Id,
            new("运营新群", replacement, group.Revision), fixture.Protection, fixture.Configuration));
        Assert.IsType<ConflictObjectResult>(await controller.CreateScheduledNotification(input, fixture.Protection, fixture.Configuration));
        var latest = await fixture.Db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).SingleAsync();
        var latestGroup = Assert.Single(latest.ScheduledNotificationGroups!.Items);
        Assert.IsType<OkObjectResult>(await controller.RemoveNotificationGroup(group.Id, latestGroup.Revision, fixture.Configuration));

        var copied = fixture.Input() with
        {
            SourceTaskId = saved.Id, SourceRevision = saved.Revision, Webhooks = [new(0, null)],
        };
        Assert.IsType<OkObjectResult>(await controller.CreateScheduledNotification(copied, fixture.Protection, fixture.Configuration));
        var copy = await fixture.Db.ProductScheduledNotifications.Find(x => x.Id != saved.Id).SingleAsync();
        Assert.Equal("运营群", Assert.Single(copy.WebhookGroupNames!));
        Assert.Equal(group.ProtectedWebhook, Assert.Single(copy.GetProtectedWebhooks()));

        await fixture.Db.ProductScheduledNotifications.UpdateOneAsync(x => x.Id == saved.Id,
            Builders<ProductScheduledNotification>.Update.Set(x => x.NextRunAt, DateTime.UtcNow.AddMinutes(-1)));
        await fixture.Worker().ProcessNextAsync(CancellationToken.None);
        Assert.Equal(TestUrl, Assert.Single(fixture.Http.Urls));
    }

    [Fact]
    public async Task ExpiredInFlightSingleTaskBecomesUnknownWithoutAutomaticDuplicateDelivery()
    {
        await using var fixture = new Fixture();
        var task = fixture.Task();
        task.Enabled = false;
        task.NextRunAt = null;
        task.LastRunAt = DateTime.UtcNow.AddMinutes(-5);
        task.LastResult = "sending";
        task.LeaseId = "previous-worker";
        task.LeaseUntil = DateTime.UtcNow.AddMinutes(-3);
        await fixture.Db.ProductScheduledNotifications.InsertOneAsync(task);
        await fixture.Worker().ProcessNextAsync(CancellationToken.None);
        var saved = await fixture.Saved(task.Id);
        Assert.Equal("unknown", saved.LastResult);
        Assert.True(saved.HasCompletedOneTimeSchedule());
        Assert.Empty(fixture.Http.Bodies);
    }

    [Fact]
    public async Task DebugUsesFixedGroupAndPreservesScheduleWithIdempotentRequests()
    {
        await using var fixture = new Fixture();
        var task = fixture.Task();
        task.NextRunAt = DateTime.UtcNow.AddHours(1);
        await fixture.Db.ProductScheduledNotifications.InsertOneAsync(task);
        var debugUrl = TestUrl + "-debug-group";
        var controller = fixture.Controller();
        Assert.IsType<OkObjectResult>(await controller.SaveNotificationDebugSettings(
            new(debugUrl), fixture.Protection, fixture.Configuration));
        var settings = await fixture.Db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).SingleAsync();
        Assert.DoesNotContain(debugUrl, settings.ScheduledNotificationDebugWebhook!);
        var visible = Assert.IsType<OkObjectResult>(await controller.GetNotificationDebugSettings(fixture.Configuration));
        Assert.DoesNotContain(debugUrl, JsonSerializer.Serialize(visible.Value));
        Assert.Contains("key=********", JsonSerializer.Serialize(visible.Value));

        var request = new ProductAgentController.NotificationDebugRequest(Guid.NewGuid().ToString("N"));
        Assert.IsType<OkObjectResult>(await controller.DebugScheduledNotification(
            task.Id, request, fixture.Protection, fixture.Configuration, fixture.Http));
        Assert.IsType<OkObjectResult>(await controller.DebugScheduledNotification(
            task.Id, request, fixture.Protection, fixture.Configuration, fixture.Http));
        var afterDebug = await fixture.Saved(task.Id);
        Assert.True(afterDebug.Enabled);
        Assert.NotNull(afterDebug.NextRunAt);
        Assert.Null(afterDebug.LastRunAt);
        Assert.Null(afterDebug.LastResult);
        Assert.Equal("sent", afterDebug.DebugRun?.Status);
        Assert.Equal(debugUrl, Assert.Single(fixture.Http.Urls));

        await fixture.Db.ProductScheduledNotifications.UpdateOneAsync(x => x.Id == task.Id,
            Builders<ProductScheduledNotification>.Update.Set(x => x.NextRunAt, DateTime.UtcNow.AddMinutes(-1)));
        await fixture.Worker().ProcessNextAsync(CancellationToken.None);
        Assert.Equal(new[] { debugUrl, TestUrl }, fixture.Http.Urls.ToArray());
        var completed = await fixture.Saved(task.Id);
        Assert.Equal("sent", completed.LastResult);
        Assert.Equal("sent", completed.DebugRun?.Status);
        Assert.IsType<ConflictObjectResult>(await controller.DebugScheduledNotification(task.Id,
            new(Guid.NewGuid().ToString("N")), fixture.Protection, fixture.Configuration, fixture.Http));
        Assert.Equal(2, fixture.Http.Bodies.Count);
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly MongoClient client;
        private readonly string database = "scheduled_notification_test_" + Guid.NewGuid().ToString("N");
        public MongoDbContext Db { get; }
        public IDataProtectionProvider Protection { get; } = new EphemeralDataProtectionProvider();
        public FakeHttp Http { get; } = new();
        public IConfiguration Configuration { get; } = new ConfigurationBuilder().Build();

        public Fixture()
        {
            var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018";
            client = new MongoClient(connection);
            Db = new MongoDbContext(connection, database);
        }

        public ProductScheduledNotification Task() => new()
        {
            Name = "定时通知自测",
            Message = "测试消息",
            Frequency = "once",
            Date = DateTime.UtcNow.AddHours(8).AddDays(1).ToString("yyyy-MM-dd"),
            Time = "18:30",
            Enabled = true,
            MentionAll = true,
            NextRunAt = DateTime.UtcNow.AddMinutes(-1),
            ProtectedWebhook = Protection.CreateProtector(ProductScheduledNotificationTiming.ProtectionPurpose).Protect(TestUrl),
        };

        public ProductAgentController.ScheduledNotificationRequest Input() =>
            new("新任务", "测试消息", "once", "18:30",
                DateTime.UtcNow.AddHours(8).AddDays(1).ToString("yyyy-MM-dd"), null, true, null, null, true);

        public Task<ProductScheduledNotification> Saved(string id) =>
            Db.ProductScheduledNotifications.Find(x => x.Id == id).SingleAsync();

        public ProductScheduledNotificationWorker Worker() =>
            new(Db, Protection, Http, Configuration, NullLogger<ProductScheduledNotificationWorker>.Instance);

        public ProductAgentController Controller() => new(Db, NullLogger<ProductAgentController>.Instance,
            null!, null!, null!, null!, null!, null!)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(new[] {
                        new Claim("sub", "admin"), new Claim("permissions", "product-agent.admin"),
                    }, "test")),
                },
            },
        };

        public async ValueTask DisposeAsync()
        {
            await client.DropDatabaseAsync(database);
            Http.Dispose();
        }
    }

    private sealed class FakeHttp : HttpMessageHandler, IHttpClientFactory
    {
        public ConcurrentQueue<string> Bodies { get; } = new();
        public ConcurrentQueue<string> Urls { get; } = new();
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            Urls.Enqueue(uri.ToString());
            Bodies.Enqueue(await request.Content!.ReadAsStringAsync(cancellationToken));
            if (uri.Query.EndsWith("-unknown", StringComparison.Ordinal))
                return new HttpResponseMessage(HttpStatusCode.BadGateway);
            if (uri.Query.EndsWith("-failed", StringComparison.Ordinal))
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"errcode\":40031}") };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"errcode\":0}") };
        }
    }
}
