using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Shouldly;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests;

public class HistoricalAssetUrlResolverTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData(HttpStatusCode.OK, 42, "matched")]
    [InlineData(HttpStatusCode.OK, 41, "length_mismatch")]
    [InlineData(HttpStatusCode.NotFound, 42, "http_status")]
    public async Task 实际HEAD持久化业务关联和安全长度判定且缓存不伪造调用(HttpStatusCode status, long size, string reason)
    {
        var rows = new List<ApiRequestLog>();
        var audit = new Mock<IMongoCollection<ApiRequestLog>>();
        audit.Setup(x => x.InsertOneAsync(It.IsAny<ApiRequestLog>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>()))
            .Callback<ApiRequestLog, InsertOneOptions, CancellationToken>((row, _, _) => rows.Add(row)).Returns(Task.CompletedTask);
        var context = new DefaultHttpContext();
        context.Items["RequestId"] = "business-request-123";
        context.Request.Headers.Authorization = "Bearer never-log-this";
        using var resolver = new HistoricalAssetUrlResolver(Config(), new Probe(status, size), auditLogs: audit.Object,
            httpContextAccessor: new HttpContextAccessor { HttpContext = context });
        var attachment = new DefectAttachment { Id = "attachment-123", Url = $"https://expired.example/{Key}", FileSize = 42 };
        await resolver.ResolveAttachmentUrlAsync(attachment, default);
        await resolver.ResolveAttachmentUrlAsync(attachment, default);
        var row = rows.ShouldHaveSingleItem();
        row.RequestId.ShouldBe("business-request-123");
        row.Direction.ShouldBe("outbound");
        row.Method.ShouldBe("HEAD");
        row.StatusCode.ShouldBe((int)status);
        var evidence = row.ResponseBody ?? throw new InvalidOperationException("审计证据缺失");
        evidence.ShouldNotContain("never-log-this");
        evidence.ShouldNotContain("expired.example");
        using var body = JsonDocument.Parse(evidence);
        body.RootElement.GetProperty("reason").GetString().ShouldBe(reason);
        body.RootElement.GetProperty("attachmentId").GetString().ShouldBe("attachment-123");
        body.RootElement.GetProperty("expectedLength").GetInt64().ShouldBe(42);
        body.RootElement.GetProperty("actualLength").GetInt64().ShouldBe(size);
        body.RootElement.GetProperty("bodyOmission").GetString().ShouldBe("HEAD has no response body");
    }

    [Fact]
    public async Task 审计失败有明确缺失告警且等待有界不改变资源结果()
    {
        var audit = new Mock<IMongoCollection<ApiRequestLog>>();
        // 故意模拟不响应取消的写方，验证业务不会被无限拖住。
        var never = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        audit.Setup(x => x.InsertOneAsync(It.IsAny<ApiRequestLog>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>()))
            .Returns(never.Task);
        var logger = new Mock<ILogger<HistoricalAssetUrlResolver>>();
        using var resolver = new HistoricalAssetUrlResolver(Config(), new Probe(HttpStatusCode.OK, 42), logger.Object, audit.Object);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        (await resolver.ResolveAttachmentUrlAsync(new() { Url = $"https://expired.example/{Key}", FileSize = 42 }, default))
            .ShouldBe($"https://legacy.example/{Key}");
        clock.Elapsed.ShouldBeLessThan(TimeSpan.FromSeconds(1));
        logger.Verify(x => x.Log(LogLevel.Error, It.IsAny<EventId>(),
            It.Is<It.IsAnyType>((state, _) => state.ToString()!.Contains("audit missing")), null,
            It.IsAny<Func<It.IsAnyType, Exception?, string>>()), Times.Once);
        never.SetResult();
    }

    [Fact]
    public async Task 实际Mongo和既有日志查询能回查成功不匹配网络超时和调用方取消()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018";
        var databaseName = $"historical_asset_audit_{Guid.NewGuid():N}";
        var database = new MongoDbContext(connection, databaseName);
        try
        {
            // ping 只证明连接可用；测试新库先显式验证该类型的审计写路径。
            // 预备记录精确回读并删除后，仍按原 200ms 业务审计预算验证六种结果。
            await database.Database.RunCommandAsync<MongoDB.Bson.BsonDocument>(new MongoDB.Bson.BsonDocument("ping", 1));
            var readiness = new ApiRequestLog { Id = Guid.NewGuid().ToString("N"), RequestId = "audit-fixture-readiness", Direction = "outbound" };
            await database.ApiRequestLogs.InsertOneAsync(readiness);
            (await database.ApiRequestLogs.Find(x => x.Id == readiness.Id).ToListAsync()).ShouldHaveSingleItem();
            (await database.ApiRequestLogs.DeleteOneAsync(x => x.Id == readiness.Id)).DeletedCount.ShouldBe(1);
            foreach (var reason in new[] { "matched", "length_mismatch", "http_status", "network_failure", "upstream_timeout", "caller_cancelled" })
            {
                var context = new DefaultHttpContext();
                context.Items["RequestId"] = $"audit-business-{reason}";
                context.Request.Headers.Authorization = "Bearer raw-inbound-secret";
                using var cancellation = new CancellationTokenSource();
                using var resolver = new HistoricalAssetUrlResolver(Config(), new AuditProbe(reason, cancellation),
                    auditLogs: database.ApiRequestLogs, httpContextAccessor: new HttpContextAccessor { HttpContext = context });
                var attachment = new DefectAttachment { Id = "audit-attachment", Url = $"https://expired.example/{Key}", FileSize = 42 };
                if (reason == "caller_cancelled")
                    await Should.ThrowAsync<OperationCanceledException>(() => resolver.ResolveAttachmentUrlAsync(attachment, cancellation.Token));
                else
                    await resolver.ResolveAttachmentUrlAsync(attachment, cancellation.Token);

                // 真正从持久化集合按与现有入口相同的 requestId/direction 过滤回查。
                var row = (await database.ApiRequestLogs.Find(x => x.RequestId == $"audit-business-{reason}" && x.Direction == "outbound")
                    .ToListAsync()).ShouldHaveSingleItem($"审计业务判据 reason={reason}，不能用预备记录替代");
                var evidence = row.ResponseBody ?? throw new InvalidOperationException("审计证据缺失");
                evidence.ShouldNotContain("raw-inbound-secret");
                evidence.ShouldNotContain("raw-upstream-secret");
                evidence.ShouldNotContain("media-user-content");
                evidence.Length.ShouldBeLessThan(4096);
                using var body = JsonDocument.Parse(evidence);
                body.RootElement.GetProperty("reason").GetString().ShouldBe(reason);
                body.RootElement.GetProperty("attachmentId").GetString().ShouldBe("audit-attachment");
                body.RootElement.GetProperty("attempt").GetInt32().ShouldBe(1);
                var received = reason is "matched" or "length_mismatch" or "http_status";
                body.RootElement.GetProperty("receivedResponse").GetBoolean().ShouldBe(received);
                if (!received)
                {
                    body.RootElement.GetProperty("httpStatus").ValueKind.ShouldBe(JsonValueKind.Null);
                    body.RootElement.GetProperty("actualLength").ValueKind.ShouldBe(JsonValueKind.Null);
                    row.ResponseBodyBytes.ShouldBeNull();
                    row.StatusCode.ShouldBe(0); // 既有 int 模型的无响应哨兵；JSON明确标null，未冒充上游状态。
                }
                else
                {
                    body.RootElement.GetProperty("upstreamRequestIdSha256").GetString()!.Length.ShouldBe(64);
                    row.ResponseBodyBytes.ShouldBe(0);
                }
                var controller = new ApiLogsController(database);
                var listing = (await controller.List(requestId: row.RequestId, direction: "outbound")).ShouldBeOfType<OkObjectResult>();
                var listData = listing.Value.ShouldBeOfType<ApiResponse<object>>().Data;
                JsonSerializer.SerializeToElement(listData).GetProperty("total").GetInt64().ShouldBe(1);
                var detail = (await controller.Detail(row.Id)).ShouldBeOfType<OkObjectResult>();
                var detailData = detail.Value.ShouldBeOfType<ApiResponse<object>>().Data;
                JsonSerializer.SerializeToElement(detailData).GetProperty("ResponseBody").GetString().ShouldBe(row.ResponseBody);
                output.WriteLine("MONGO_AUDIT_VERIFIED " + JsonSerializer.Serialize(new
                {
                    requestId = row.RequestId, attachmentId = "audit-attachment", reason,
                    row.StatusCode, row.Status, row.ResponseBodyBytes,
                    responseEvidenceChars = evidence.Length, receivedResponse = received,
                    queryEntry = "/api/logs/api?requestId=<business-request>&direction=outbound",
                    listTotal = 1, detailEvidenceMatches = true, masked = true
                }));
            }
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(databaseName); }
    }

    private sealed class AuditProbe(string reason, CancellationTokenSource caller) : HttpMessageHandler, IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (reason == "network_failure") throw new HttpRequestException("raw-upstream-secret");
            if (reason == "upstream_timeout") throw new TaskCanceledException("raw-upstream-secret");
            if (reason == "caller_cancelled")
            {
                caller.Cancel();
                await Task.Delay(Timeout.Infinite, ct);
            }
            var response = new HttpResponseMessage(reason == "http_status" ? HttpStatusCode.NotFound : HttpStatusCode.OK)
            {
                RequestMessage = request, Content = new StringContent("media-user-content")
            };
            response.Headers.TryAddWithoutValidation("Set-Cookie", "raw-upstream-secret");
            response.Headers.TryAddWithoutValidation("x-cos-request-id", "raw-upstream-secret");
            response.Content.Headers.ContentLength = reason == "length_mismatch" ? 41 : 42;
            return response;
        }
    }

    private const string Key = "data/defect-agent/img/abcdefghijklmnopqrstuvwxyz.png";
    private static IConfiguration Config(string provider = "cloudflareR2") => new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ASSETS_PROVIDER"] = provider,
            ["R2_PUBLIC_BASE_URL"] = "https://current.example",
            ["TENCENT_COS_PUBLIC_BASE_URL"] = "https://legacy.example"
        }).Build();

    [Fact]
    public async Task 旧附件只探测受信旧源且长度一致后恢复并缓存()
    {
        var transport = new Probe(HttpStatusCode.OK, 42);
        using var resolver = new HistoricalAssetUrlResolver(Config(), transport);
        var attachment = new DefectAttachment { Url = $"https://expired.example/{Key}", FileSize = 42 };
        (await resolver.ResolveAttachmentUrlAsync(attachment, default)).ShouldBe($"https://legacy.example/{Key}");
        (await resolver.ResolveAttachmentUrlAsync(attachment, default)).ShouldBe($"https://legacy.example/{Key}");
        transport.Urls.ShouldHaveSingleItem().ShouldBe($"https://legacy.example/{Key}");
        attachment.Url.ShouldBe($"https://expired.example/{Key}");
    }

    [Theory]
    [InlineData("https://current.example/" + Key)]
    [InlineData("https://legacy.example/" + Key)]
    [InlineData("https://native-assets-1250000000.cos.ap-test.myqcloud.com/" + Key)]
    [InlineData("https://outside.example/other/file.png")]
    [InlineData("https://outside.example/" + Key + "?signature=opaque")]
    [InlineData("https://outside.example/data/defect-agent/img/../../secret.png")]
    public async Task 当前资源及不属于规范附件的链接保持不变且不探测(string url)
    {
        var transport = new Probe(HttpStatusCode.OK, 42);
        using var resolver = new HistoricalAssetUrlResolver(Config(), transport);
        (await resolver.ResolveAttachmentUrlAsync(new() { Url = url, FileSize = 42 }, default)).ShouldBe(url);
        transport.Urls.ShouldBeEmpty();
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound, 42)]
    [InlineData(HttpStatusCode.OK, 41)]
    [InlineData(HttpStatusCode.Redirect, 42)]
    public async Task 旧源缺失长度不符或重定向均不冒充恢复(HttpStatusCode status, long size)
    {
        var transport = new Probe(status, size);
        using var resolver = new HistoricalAssetUrlResolver(Config(), transport);
        var original = $"https://expired.example/{Key}";
        (await resolver.ResolveAttachmentUrlAsync(new() { Url = original, FileSize = 42 }, default)).ShouldBe(original);
    }

    [Fact]
    public async Task 整页仅更改内存响应并保留当前R2对象()
    {
        using var resolver = new HistoricalAssetUrlResolver(Config(), new Probe(HttpStatusCode.OK, 42));
        var old = new DefectAttachment { Url = $"https://expired.example/{Key}", ThumbnailUrl = $"https://expired.example/{Key}", FileSize = 42 };
        var current = new DefectAttachment { Url = $"https://current.example/{Key}", FileSize = 42 };
        await resolver.ResolveAttachmentsForReadAsync(new[] { new DefectReport { Attachments = [old, current] } }, default);
        old.Url.ShouldBe($"https://legacy.example/{Key}");
        old.ThumbnailUrl.ShouldBe(old.Url);
        current.Url.ShouldBe($"https://current.example/{Key}");
    }

    [Fact]
    public void 本地或COS模式不启用跨提供方兼容()
    {
        HistoricalAssetUrlResolver.ResolveLegacyPublicBaseUrl(Config("local")).ShouldBeNull();
        HistoricalAssetUrlResolver.ResolveLegacyPublicBaseUrl(Config("tencentCos")).ShouldBeNull();
    }

    [Fact]
    public async Task 整页探测有共同预算且并发不超过四个()
    {
        var transport = new SlowProbe();
        var rows = new System.Collections.Concurrent.ConcurrentQueue<ApiRequestLog>();
        var audit = new Mock<IMongoCollection<ApiRequestLog>>();
        audit.Setup(x => x.InsertOneAsync(It.IsAny<ApiRequestLog>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>()))
            .Callback<ApiRequestLog, InsertOneOptions, CancellationToken>((row, _, _) => rows.Enqueue(row)).Returns(Task.CompletedTask);
        using var resolver = new HistoricalAssetUrlResolver(Config(), transport, auditLogs: audit.Object);
        var attachments = Enumerable.Range(0, 20).Select(i => new DefectAttachment
        {
            Url = $"https://expired.example/data/defect-agent/img/{i:D26}.png", FileSize = 42
        }).ToList();
        var originals = attachments.Select(x => x.Url).ToList();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        await resolver.ResolveAttachmentsForReadAsync(new[] { new DefectReport { Id = "budget-defect", ProjectId = "budget-project", Attachments = attachments } }, default);
        transport.MaxActive.ShouldBeInRange(1, 4);
        transport.Active.ShouldBe(0);
        attachments.Select(x => x.Url).ShouldBe(originals);
        clock.Elapsed.ShouldBeLessThan(TimeSpan.FromMilliseconds(4500));
        rows.Count.ShouldBe(4); // 后续16个排队取消，未实际调用，不伪造上游审计。
        rows.ShouldAllBe(row => row.Status == "timeout" && row.ErrorCode == "page_budget_exhausted");
        using var summary = JsonDocument.Parse(rows.First().ResponseBody!);
        summary.RootElement.GetProperty("defectId").GetString().ShouldBe("budget-defect");
        summary.RootElement.GetProperty("projectId").GetString().ShouldBe("budget-project");
    }

    [Fact]
    public async Task 冷列表先核验旧图且正常原生COS与排前日志不会饿死图片()
    {
        var transport = new DelayedProbe();
        var rows = new System.Collections.Concurrent.ConcurrentQueue<ApiRequestLog>();
        var audit = new Mock<IMongoCollection<ApiRequestLog>>();
        audit.Setup(x => x.InsertOneAsync(It.IsAny<ApiRequestLog>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>()))
            .Returns<ApiRequestLog, InsertOneOptions, CancellationToken>(async (row, _, ct) =>
            {
                await Task.Delay(10, ct);
                rows.Enqueue(row);
            });
        using var resolver = new HistoricalAssetUrlResolver(Config(), transport, auditLogs: audit.Object);
        var native = Enumerable.Range(0, 26).Select(i => new DefectAttachment
        {
            Url = $"https://native-assets-1250000000.cos.ap-test.myqcloud.com/data/defect-agent/{(i < 11 ? "img" : "log")}/{i:D26}.{(i < 11 ? "png" : "txt")}",
            MimeType = i < 11 ? "image/png" : "text/plain", FileSize = 42
        }).ToList();
        var logs = Enumerable.Range(0, 29).Select(i => new DefectAttachment
        {
            Url = $"https://expired.example/data/defect-agent/log/{i:D26}.txt", MimeType = "text/plain", FileSize = 42
        }).ToList();
        var images = Enumerable.Range(0, 20).Select(i => new DefectAttachment
        {
            Url = $"https://expired.example/data/defect-agent/img/{i:D26}.png", MimeType = "image/png", FileSize = 42
        }).ToList();
        var nativeOriginals = native.Select(x => x.Url).ToList();
        await resolver.ResolveAttachmentsForReadAsync(new[] { new DefectReport { Attachments = [.. native, .. logs, .. images] } }, default);
        native.Select(x => x.Url).ShouldBe(nativeOriginals);
        images.ShouldAllBe(x => x.Url.StartsWith("https://legacy.example/data/defect-agent/img/"));
        transport.Urls.Count(x => x.Contains("/img/")).ShouldBe(20);
        transport.Urls.Count(x => x.Contains("/log/")).ShouldBeLessThanOrEqualTo(4);
        transport.MaxActive.ShouldBeInRange(1, 4);
        transport.Active.ShouldBe(0);
        rows.Count(x => x.Status == "completed" && x.Path.Contains("/img/", StringComparison.Ordinal)).ShouldBe(20);
    }

    private sealed class DelayedProbe : HttpMessageHandler, IHttpClientFactory
    {
        private readonly object _gate = new();
        public int Active { get; private set; }
        public int MaxActive { get; private set; }
        public System.Collections.Concurrent.ConcurrentQueue<string> Urls { get; } = new();
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Urls.Enqueue(request.RequestUri!.AbsoluteUri);
            lock (_gate) { Active++; MaxActive = Math.Max(MaxActive, Active); }
            try
            {
                await Task.Delay(request.RequestUri.AbsolutePath.Contains("/img/") ? 625 : Timeout.Infinite, ct);
                var response = new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = new ByteArrayContent([]) };
                response.Content.Headers.ContentLength = 42;
                return response;
            }
            finally { lock (_gate) { Active--; } }
        }
    }

    private sealed class SlowProbe : HttpMessageHandler, IHttpClientFactory
    {
        private readonly object _gate = new();
        public int Active { get; private set; }
        public int MaxActive { get; private set; }
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            lock (_gate) { Active++; MaxActive = Math.Max(MaxActive, Active); }
            try
            {
                await Task.Delay(Timeout.Infinite, ct);
                throw new InvalidOperationException("探测应被共同预算取消");
            }
            finally { lock (_gate) { Active--; } }
        }
    }

    private sealed class Probe(HttpStatusCode status, long size) : HttpMessageHandler, IHttpClientFactory
    {
        public List<string> Urls { get; } = [];
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            request.Method.ShouldBe(HttpMethod.Head);
            Urls.Add(request.RequestUri!.AbsoluteUri);
            var response = new HttpResponseMessage(status) { RequestMessage = request, Content = new ByteArrayContent([]) };
            response.Content.Headers.ContentLength = size;
            return Task.FromResult(response);
        }
    }
}
