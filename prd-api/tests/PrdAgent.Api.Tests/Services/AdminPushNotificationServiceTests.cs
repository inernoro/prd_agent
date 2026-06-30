using System.Net;
using Microsoft.Extensions.Configuration;
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

    [Fact]
    public async Task DispatchPendingAsync_BarkUsesNotificationImageAttachment()
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
                ChannelType = "bark",
                BarkKey = "test-key",
                BarkServerUrl = "https://example.com",
                BarkImageTemplate = "{{imageUrl}}",
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
                Attachments =
                [
                    new NotificationAttachment
                    {
                        Name = "snapshot.png",
                        Url = "https://example.com/defect-image.png",
                        MimeType = "image/png",
                    },
                ],
                CreatedAt = DateTime.UtcNow,
            });

            await service.DispatchPendingAsync(CancellationToken.None);

            var request = Assert.Single(http.Requests);
            var query = QueryHelpers.ParseQuery(request.Uri.Query);
            Assert.Equal("https://example.com/defect-image.png", query["image"]);
            Assert.Equal("https://placehold.co/256x256/e11d48/ffffff/png?text=DEF", query["icon"]);
        }
        finally
        {
            await testDb.DisposeAsync();
        }
    }

    [Fact]
    public async Task DispatchPendingAsync_DoesNotPushDefectReminderNotifications()
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
                UrlTemplate = "https://example.com/push/{{title}}/{{message}}",
            });
            await testDb.Context.AdminNotifications.InsertManyAsync(
            [
                new AdminNotification
                {
                    Id = "n1",
                    Key = "defect-submitted:n1",
                    Title = "收到新缺陷：DEF-2026-0106",
                    Message = "用户提交了带截图的新缺陷",
                    Source = "defect-agent",
                    Status = "open",
                    TargetUserId = "u1",
                    CreatedAt = DateTime.UtcNow,
                },
                new AdminNotification
                {
                    Id = "n2",
                    Key = "defect-escalation:n2",
                    Title = "缺陷催办：DEF-2026-0082",
                    Message = "缺陷「产品方案文档中截图这里实际上是有个图片的，但是在这里不显示」已超时 2185 小时未处理，请尽快跟进",
                    Source = "defect-agent",
                    Status = "open",
                    TargetUserId = "u1",
                    CreatedAt = DateTime.UtcNow.AddSeconds(1),
                },
            ]);

            await service.DispatchPendingAsync(CancellationToken.None);

            var request = Assert.Single(http.Requests);
            Assert.Contains("DEF-2026-0106", WebUtility.UrlDecode(request.Uri.AbsoluteUri), StringComparison.Ordinal);
            Assert.DoesNotContain("DEF-2026-0082", WebUtility.UrlDecode(request.Uri.AbsoluteUri), StringComparison.Ordinal);

            var logs = await testDb.Context.AdminPushDeliveryLogs.Find(x => true).ToListAsync();
            Assert.Single(logs);
            Assert.Equal("n1", logs[0].NotificationId);
        }
        finally
        {
            await testDb.DisposeAsync();
        }
    }

    [Fact]
    public async Task DispatchPendingAsync_RoutesUserVoiceAndApiAlertsToDedicatedTopics()
    {
        var testDb = await AdminPushTestDatabase.TryCreateAsync();
        if (testDb == null) return;

        try
        {
            var http = new RecordingHttpClientFactory(HttpStatusCode.OK);
            var service = CreateService(testDb.Context, http);

            await testDb.Context.AdminPushSubscriptions.InsertManyAsync(
            [
                new AdminPushSubscription
                {
                    UserId = "u1",
                    TopicKey = "user-voice",
                    Enabled = true,
                    ChannelType = "bark",
                    BarkKey = "test-key",
                    BarkServerUrl = "https://example.com",
                },
                new AdminPushSubscription
                {
                    UserId = "u1",
                    TopicKey = "api-request-alert",
                    Enabled = true,
                    ChannelType = "bark",
                    BarkKey = "test-key",
                    BarkServerUrl = "https://example.com",
                },
            ]);
            await testDb.Context.AdminNotifications.InsertManyAsync(
            [
                new AdminNotification
                {
                    Id = "n1",
                    Key = "voice-1",
                    Title = "用户之声",
                    Message = "用户反馈关键路径有阻塞",
                    Source = "user-voice",
                    Status = "open",
                    TargetUserId = "u1",
                    CreatedAt = DateTime.UtcNow,
                },
                new AdminNotification
                {
                    Id = "n2",
                    Key = "api-1",
                    Title = "API 请求问题",
                    Message = "接口错误率超过阈值",
                    Source = "api-request-alert",
                    Status = "open",
                    TargetUserId = "u1",
                    CreatedAt = DateTime.UtcNow,
                },
            ]);

            await service.DispatchPendingAsync(CancellationToken.None);

            Assert.Equal(2, http.Requests.Count);
            var icons = http.Requests
                .Select(x => QueryHelpers.ParseQuery(x.Uri.Query)["icon"].ToString())
                .ToList();
            Assert.Contains(icons, icon => icon.Contains("text=VOC", StringComparison.Ordinal));
            Assert.Contains(icons, icon => icon.Contains("text=API", StringComparison.Ordinal));
        }
        finally
        {
            await testDb.DisposeAsync();
        }
    }

    [Fact]
    public async Task EventService_CreatesInfrastructureEventsForDedicatedPushTopics()
    {
        var testDb = await AdminPushTestDatabase.TryCreateAsync();
        if (testDb == null) return;

        try
        {
            var http = new RecordingHttpClientFactory(HttpStatusCode.OK);
            var push = CreateService(testDb.Context, http);
            var events = new AdminNotificationEventService(testDb.Context, NullLogger<AdminNotificationEventService>.Instance);

            await testDb.Context.AdminPushSubscriptions.InsertManyAsync(
            [
                new AdminPushSubscription
                {
                    UserId = "u1",
                    TopicKey = "admin-message",
                    Enabled = true,
                    ChannelType = "bark",
                    BarkKey = "test-key",
                    BarkServerUrl = "https://example.com",
                    BarkGroup = "MAP System-{{appname}}",
                    BarkIcon = "{{iconUrl}}",
                },
                new AdminPushSubscription
                {
                    UserId = "u1",
                    TopicKey = "user-voice",
                    Enabled = true,
                    ChannelType = "bark",
                    BarkKey = "test-key",
                    BarkServerUrl = "https://example.com",
                    BarkGroup = "MAP System-{{appname}}",
                    BarkIcon = "{{iconUrl}}",
                },
                new AdminPushSubscription
                {
                    UserId = "u1",
                    TopicKey = "api-request-alert",
                    Enabled = true,
                    ChannelType = "bark",
                    BarkKey = "test-key",
                    BarkServerUrl = "https://example.com",
                    BarkGroup = "MAP System-{{appname}}",
                    BarkIcon = "{{iconUrl}}",
                },
                new AdminPushSubscription
                {
                    UserId = "u1",
                    TopicKey = "system-alert",
                    Enabled = true,
                    ChannelType = "bark",
                    BarkKey = "test-key",
                    BarkServerUrl = "https://example.com",
                    BarkGroup = "MAP System-{{appname}}",
                    BarkIcon = "{{iconUrl}}",
                },
            ]);

            var imageUrl = "https://example.com/voice-snapshot.png";
            await events.CreateAsync(new AdminNotificationEventRequest
            {
                Source = "server-expiry",
                Title = "服务器到期提醒",
                Message = "测试服务器将在 7 天后到期",
                Level = "warning",
                TargetUserId = "u1",
                DedupKey = "server-1",
            }, "admin", CancellationToken.None);
            await events.CreateAsync(new AdminNotificationEventRequest
            {
                Source = "user-voice",
                Title = "用户之声",
                Message = "用户反馈关键路径有阻塞",
                Level = "info",
                TargetUserId = "u1",
                DedupKey = "voice-1",
                Attachments =
                [
                    new AdminNotificationEventAttachmentRequest
                    {
                        Name = "snapshot.png",
                        Url = imageUrl,
                        MimeType = "image/png",
                    },
                ],
            }, "admin", CancellationToken.None);
            await events.CreateAsync(new AdminNotificationEventRequest
            {
                Source = "api-request-alert",
                Title = "API 请求问题",
                Message = "接口错误率超过阈值",
                Level = "error",
                TargetUserId = "u1",
                DedupKey = "api-1",
            }, "admin", CancellationToken.None);
            await events.CreateAsync(new AdminNotificationEventRequest
            {
                Source = "platform-key-integrity",
                Title = "系统预警",
                Message = "平台密钥配置需要检查",
                Level = "warning",
                TargetUserId = "u1",
                DedupKey = "system-1",
            }, "admin", CancellationToken.None);

            await push.DispatchPendingAsync(CancellationToken.None);

            Assert.Equal(4, http.Requests.Count);
            var groups = http.Requests
                .Select(x => QueryHelpers.ParseQuery(x.Uri.Query)["group"].ToString())
                .ToList();
            Assert.Contains("MAP System-服务器到期", groups);
            Assert.Contains("MAP System-用户之声", groups);
            Assert.Contains("MAP System-API 请求问题", groups);
            Assert.Contains("MAP System-系统预警", groups);

            var voice = http.Requests.Single(x => QueryHelpers.ParseQuery(x.Uri.Query)["group"] == "MAP System-用户之声");
            Assert.Equal(imageUrl, QueryHelpers.ParseQuery(voice.Uri.Query)["image"]);
        }
        finally
        {
            await testDb.DisposeAsync();
        }
    }

    [Fact]
    public async Task RealBarkSmoke_CreatesDefectsForInernoroAndSendsDifferentImages_WhenKeyIsConfigured()
    {
        var key = Environment.GetEnvironmentVariable("REAL_BARK_KEY");
        if (string.IsNullOrWhiteSpace(key)) return;

        var testDb = await AdminPushTestDatabase.TryCreateAsync();
        if (testDb == null) return;

        try
        {
            var service = CreateService(testDb.Context, new DirectHttpClientFactory());
            var now = DateTime.UtcNow;
            var images = new[]
            {
                "https://picsum.photos/seed/prd-agent-bark-defect-a/960/540",
                "https://picsum.photos/seed/prd-agent-bark-defect-b/960/540",
            };

            await testDb.Context.AdminPushSubscriptions.InsertOneAsync(new AdminPushSubscription
            {
                UserId = "inernoro",
                TopicKey = "defect-management",
                Enabled = true,
                ChannelType = "bark",
                BarkKey = key,
                BarkServerUrl = "https://api.day.app",
                BarkGroup = "MAP System-{{appname}}",
                BarkIcon = images[0],
                BarkImageTemplate = "{{imageUrl}}",
                BarkUrlTemplate = "https://admin-push-bark-protocol-codex-prd-agent.miduo.org/defect-agent?id={{notificationId}}",
            });

            for (var i = 0; i < images.Length; i++)
            {
                var defect = new DefectReport
                {
                    Id = Guid.NewGuid().ToString("N"),
                    DefectNo = $"LOCAL-BARK-{now:HHmmss}-{i + 1}",
                    Title = $"本地 Bark 图片推送验收缺陷 {i + 1}",
                    RawContent = "用于验证管理员推送 Bark 协议 image 参数，不写入真实 key。",
                    Status = DefectStatus.Submitted,
                    Severity = i == 0 ? DefectSeverity.Major : DefectSeverity.Minor,
                    Priority = DefectPriority.Medium,
                    ReporterId = "codex-local",
                    ReporterName = "Codex Local",
                    AssigneeId = "inernoro",
                    AssigneeName = "inernoro",
                    CreatedAt = now.AddSeconds(i),
                    UpdatedAt = now.AddSeconds(i),
                };
                await testDb.Context.DefectReports.InsertOneAsync(defect);

                await testDb.Context.AdminNotifications.InsertOneAsync(new AdminNotification
                {
                    Id = defect.Id,
                    Key = $"real-bark-defect:{defect.Id}",
                    TargetUserId = "inernoro",
                    Title = $"收到新缺陷：{defect.DefectNo}",
                    Message = $"Codex Local 给你提交了一个缺陷：{defect.Title}",
                    Level = defect.Severity == DefectSeverity.Major ? "warning" : "info",
                    ActionLabel = "查看详情",
                    ActionUrl = $"/defect-agent?id={defect.Id}",
                    Source = "defect-agent",
                    Attachments =
                    [
                        new NotificationAttachment
                        {
                            Name = $"defect-{i + 1}.jpg",
                            Url = images[i],
                            MimeType = "image/jpeg",
                        },
                    ],
                    CreatedAt = now.AddSeconds(i),
                    UpdatedAt = now.AddSeconds(i),
                    ExpiresAt = now.AddDays(1),
                });
            }

            await service.DispatchPendingAsync(CancellationToken.None);

            var logs = await testDb.Context.AdminPushDeliveryLogs.Find(x => x.UserId == "inernoro").ToListAsync();
            Assert.Equal(2, logs.Count);
            Assert.All(logs, log =>
            {
                Assert.True(log.Success, log.ErrorMessage);
                Assert.Equal(200, log.StatusCode);
                Assert.Contains("image=", log.RequestUrl);
            });
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
            TestConfiguration,
            NullLogger<AdminPushNotificationService>.Instance);
    }

    private static AdminPushNotificationService CreateService(MongoDbContext db, DirectHttpClientFactory http)
    {
        return new AdminPushNotificationService(
            db,
            http,
            new AllowAllUrlValidator(),
            TestConfiguration,
            NullLogger<AdminPushNotificationService>.Instance);
    }

    private static readonly IConfiguration TestConfiguration = new ConfigurationBuilder().Build();

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

    private sealed class DirectHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
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
