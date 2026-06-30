using System.Net;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class AdminPushNotificationServiceTests
{
    [Fact]
    public async Task DispatchPendingAsync_DeliversOpenNotificationOnce()
    {
        var testDb = await AdminPushTestDatabase.TryCreateAsync();
        if (testDb == null) return;

        try
        {
            var http = new RecordingHttpClientFactory(HttpStatusCode.OK);
            var service = CreateService(testDb.Context, http);

            await testDb.Context.AdminPushSubscriptions.InsertOneAsync(new AdminPushSubscription
            {
                UserId = "u1",
                TopicKey = "defect-management",
                Enabled = true,
                ChannelType = "url",
                Method = "GET",
                UrlTemplate = "https://example.com/push/{{message}}",
            });
            await testDb.Context.AdminNotifications.InsertOneAsync(new AdminNotification
            {
                Id = "n1",
                Key = "k1",
                Title = "缺陷提醒",
                Message = "需要处理",
                Source = "defect-agent",
                Status = "open",
                TargetUserId = "u1",
                CreatedAt = DateTime.UtcNow,
            });

            await service.DispatchPendingAsync(CancellationToken.None);
            await service.DispatchPendingAsync(CancellationToken.None);

            Assert.Single(http.Requests);
            Assert.Equal("https://example.com/push/%E9%9C%80%E8%A6%81%E5%A4%84%E7%90%86", http.Requests[0].Uri.AbsoluteUri);
            var logs = await testDb.Context.AdminPushDeliveryLogs.Find(x => true).ToListAsync();
            Assert.Single(logs);
            Assert.True(logs[0].Success);
        }
        finally
        {
            await testDb.DisposeAsync();
        }
    }

    [Fact]
    public async Task DispatchPendingAsync_RetriesAfterOldFailedDelivery()
    {
        var testDb = await AdminPushTestDatabase.TryCreateAsync();
        if (testDb == null) return;

        try
        {
            var http = new RecordingHttpClientFactory(HttpStatusCode.OK);
            var service = CreateService(testDb.Context, http);

            var subscription = new AdminPushSubscription
            {
                UserId = "u1",
                TopicKey = "defect-management",
                Enabled = true,
                ChannelType = "url",
                Method = "GET",
                UrlTemplate = "https://example.com/push/{{notificationId}}",
            };
            await testDb.Context.AdminPushSubscriptions.InsertOneAsync(subscription);
            await testDb.Context.AdminNotifications.InsertOneAsync(new AdminNotification
            {
                Id = "n1",
                Key = "k1",
                Title = "缺陷提醒",
                Message = "需要处理",
                Source = "defect-agent",
                Status = "open",
                TargetUserId = "u1",
                CreatedAt = DateTime.UtcNow,
            });
            await testDb.Context.AdminPushDeliveryLogs.InsertOneAsync(new AdminPushDeliveryLog
            {
                UserId = "u1",
                SubscriptionId = subscription.Id,
                TopicKey = "defect-management",
                NotificationId = "n1",
                ChannelType = "url",
                Method = "GET",
                RequestUrl = "https://example.com/push/n1",
                Success = false,
                CreatedAt = DateTime.UtcNow.AddMinutes(-11),
            });

            await service.DispatchPendingAsync(CancellationToken.None);

            Assert.Single(http.Requests);
            var logs = await testDb.Context.AdminPushDeliveryLogs.Find(x => x.NotificationId == "n1").ToListAsync();
            Assert.Equal(2, logs.Count);
            Assert.Contains(logs, x => x.Success);
        }
        finally
        {
            await testDb.DisposeAsync();
        }
    }

    [Fact]
    public async Task SendTestAsync_BarkQueryUsesPlainPlaceholderValues()
    {
        var testDb = await AdminPushTestDatabase.TryCreateAsync();
        if (testDb == null) return;

        try
        {
            var http = new RecordingHttpClientFactory(HttpStatusCode.OK);
            var service = CreateService(testDb.Context, http);

            var result = await service.SendTestAsync("u1", new AdminPushSubscriptionUpsertRequest
            {
                TopicKey = "defect-management",
                Enabled = true,
                ChannelType = "bark",
                BarkKey = "test-key",
                BarkServerUrl = "https://example.com",
                BarkGroup = "MAP System-{{appname}}",
                BarkIcon = "{{source}}",
                BarkUrlTemplate = "https://example.com/open?from={{source}}",
            }, CancellationToken.None);

            Assert.True(result.Success);
            var request = Assert.Single(http.Requests);
            var query = QueryHelpers.ParseQuery(request.Uri.Query);
            Assert.Equal("MAP System-缺陷管理", query["group"]);
            Assert.Equal("defect-agent", query["icon"]);
            Assert.Equal("https://example.com/open?from=defect-agent", query["url"]);
        }
        finally
        {
            await testDb.DisposeAsync();
        }
    }

    private static AdminPushNotificationService CreateService(MongoDbContext db, RecordingHttpClientFactory http)
    {
        return new AdminPushNotificationService(
            db,
            http,
            new AllowAllUrlValidator(),
            NullLogger<AdminPushNotificationService>.Instance);
    }

    private sealed class AdminPushTestDatabase : IAsyncDisposable
    {
        private AdminPushTestDatabase(MongoClient client, string databaseName, MongoDbContext context)
        {
            Client = client;
            DatabaseName = databaseName;
            Context = context;
        }

        public MongoClient Client { get; }
        public string DatabaseName { get; }
        public MongoDbContext Context { get; }

        public static async Task<AdminPushTestDatabase?> TryCreateAsync()
        {
            var uri = Environment.GetEnvironmentVariable("ADMIN_PUSH_TEST_MONGO_URI");
            if (string.IsNullOrWhiteSpace(uri)) uri = "mongodb://localhost:27018";

            var databaseName = "prdagent_admin_push_test_" + Guid.NewGuid().ToString("N");
            try
            {
                var client = new MongoClient(uri);
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                await client.GetDatabase("admin").RunCommandAsync((Command<MongoDB.Bson.BsonDocument>)"{ping:1}", cancellationToken: cts.Token);
                return new AdminPushTestDatabase(client, databaseName, new MongoDbContext(uri, databaseName));
            }
            catch
            {
                return null;
            }
        }

        public async ValueTask DisposeAsync()
        {
            await Client.DropDatabaseAsync(DatabaseName);
        }
    }

    private sealed class AllowAllUrlValidator : ISafeOutboundUrlValidator
    {
        public Task<Uri> EnsureSafeHttpUrlAsync(string? url, string purpose, CancellationToken ct = default)
        {
            return Task.FromResult(new Uri(url ?? string.Empty));
        }

        public bool IsSafeAddress(IPAddress address) => true;
    }

    private sealed class RecordingHttpClientFactory : IHttpClientFactory
    {
        private readonly Queue<HttpStatusCode> _statuses;

        public RecordingHttpClientFactory(params HttpStatusCode[] statuses)
        {
            _statuses = new Queue<HttpStatusCode>(statuses.Length == 0 ? [HttpStatusCode.OK] : statuses);
        }

        public List<RecordedRequest> Requests { get; } = [];

        public HttpClient CreateClient(string name)
        {
            return new HttpClient(new RecordingHandler(Requests, _statuses));
        }
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        private readonly List<RecordedRequest> _requests;
        private readonly Queue<HttpStatusCode> _statuses;

        public RecordingHandler(List<RecordedRequest> requests, Queue<HttpStatusCode> statuses)
        {
            _requests = requests;
            _statuses = statuses;
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            _requests.Add(new RecordedRequest(
                request.Method,
                request.RequestUri ?? new Uri("https://example.com"),
                request.Content == null ? null : await request.Content.ReadAsStringAsync(cancellationToken)));

            var status = _statuses.Count > 1 ? _statuses.Dequeue() : _statuses.Peek();
            return new HttpResponseMessage(status)
            {
                Content = new StringContent(status == HttpStatusCode.OK ? "ok" : "failed"),
            };
        }
    }

    private sealed record RecordedRequest(HttpMethod Method, Uri Uri, string? Body);
}
