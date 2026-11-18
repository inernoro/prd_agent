using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed partial class UpstreamResponseProtectionTests
{
    [Theory]
    [InlineData("raw")] [InlineData("native")] [InlineData("native-stream")]
    public async Task RawAndNativeResponsesRejectSecretsBeforeCallbackOrAudit(string entry)
    {
        var stream = entry == "native-stream";
        var body = stream ? "data: {\"type\":\"response.output_text.delta\",\"delta\":\"" + Secret[..15] + "\"}\n\n"
            + "data: {\"type\":\"response.output_text.delta\",\"delta\":\"" + Secret[15..] + "\"}\n\n"
            : JsonSerializer.Serialize(new { status = "completed", output_text = Secret });
        var logs = new CapturingLogWriter();
        var gateway = Gateway(new BodyFactory(body, stream ? "text/event-stream" : "application/json"), logs);
        var resolution = new GatewayModelResolution { Success = true, ActualModel = "synthetic", ActualPlatformId = "synthetic", PlatformType = "openai", Protocol = "openai", ApiUrl = "https://synthetic.invalid", ApiKey = Secret };
        var request = new GatewayRawRequest { AppCallerCode = "prd-agent-web.lab::chat", ModelType = "chat", HttpMethod = "POST", EndpointPath = entry == "raw" ? "/v1/chat/completions" : "/v1/responses", RequestBody = new JsonObject { ["input"] = "safe", ["store"] = false, ["stream"] = stream } };
        using var delivered = new MemoryStream();
        var result = entry == "raw" ? await gateway.SendRawWithResolutionAsync(request, resolution)
            : await gateway.SendNativeResponsesWithResolutionAsync(request, resolution, (chunk, ct) => delivered.WriteAsync(chunk.Data, ct).AsTask());
        Assert.False(result.Success); Assert.Equal("UPSTREAM_CREDENTIAL_REFLECTION", result.ErrorCode);
        Assert.DoesNotContain(Secret[..15], Encoding.UTF8.GetString(delivered.ToArray()));
        Assert.DoesNotContain(Secret, JsonSerializer.Serialize(logs.Done));
        Assert.Equal("failed", logs.Done?.Status);
    }

    [Fact]
    public async Task CredentialHeadersAreRemovedAndReflectedRequestIdsAreRejected()
    {
        foreach (var reflectedId in new[] { false, true })
        {
            var factory = new BodyFactory("{\"choices\":[{\"message\":{\"content\":\"safe\"}}]}", "application/json", response =>
            {
                response.Headers.TryAddWithoutValidation(reflectedId ? "x-request-id" : "Set-Cookie", Secret);
            });
            var logs = new CapturingLogWriter(); var result = await Gateway(factory, logs).SendAsync(Request());
            Assert.Equal(!reflectedId, result.Success);
            Assert.DoesNotContain(Secret, JsonSerializer.Serialize(logs.Done));
        }
    }

    // 使用真实日志后台会启动进程级队列消费；单独点名执行，避免多个测试库消费者互相取走操作。
    [Fact, Trait("Category", "Integration")]
    public async Task RejectionBudgetAndCancellationReleaseLeasesAndAreQueryableWithoutSecrets()
    {
        await using var database = await RunMongoFixture.CreateAsync("gateway_response_protection");
        var coordinator = new GatewayProviderConcurrencyCoordinator(new LlmGatewayDataContext(
            Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017",
            database.Db.Database.DatabaseNamespace.DatabaseName), NullLogger<GatewayProviderConcurrencyCoordinator>.Instance);
        var storage = Mock.Of<IAssetStorage>();
        var background = new LlmRequestLogBackground(database.Db, NullLogger<LlmRequestLogBackground>.Instance,
            storage, new SequenceHttpClientFactory(), Mock.Of<ISafeOutboundUrlValidator>());
        var settings = new Mock<IAppSettingsService>();
        settings.Setup(x => x.GetSettingsAsync(It.IsAny<CancellationToken>())).ReturnsAsync(new AppSettings());
        var writer = new LlmRequestLogWriter(database.Db, NullLogger<LlmRequestLogWriter>.Instance, background,
            settings.Object, storage, new ConfigurationBuilder().Build());
        var resolution = new ModelResolutionResult { ActualPlatformId = "synthetic", ActualModel = "synthetic", PlatformMaxConcurrency = 1 };
        foreach (var mode in new[] { "send-secret", "stream-secret", "send-budget", "stream-budget", "cancel" })
        {
            using var cancel = new CancellationTokenSource();
            var stream = mode.StartsWith("stream", StringComparison.Ordinal);
            var value = mode.EndsWith("secret", StringComparison.Ordinal) ? Secret : new string('x', 512);
            IHttpClientFactory http = mode == "cancel" ? new StreamFactory(new CancelSource(cancel))
                : new SequenceHttpClientFactory((200, stream ? Event("content", value) + "data: [DONE]\n\n"
                    : JsonSerializer.Serialize(new { choices = new[] { new { message = new { content = value } } } })));
            var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                { ["LlmGateway:ResponseBudget:ResponseBytes"] = "256" }).Build();
            var gateway = Gateway(http, writer, config, coordinator);
            if (stream)
            {
                var chunks = new List<GatewayStreamChunk>();
                await foreach (var chunk in gateway.StreamAsync(Request())) chunks.Add(chunk);
                Assert.Contains(chunks, x => x.Type == GatewayChunkType.Error);
            }
            else Assert.False((await gateway.SendAsync(Request(), cancel.Token)).Success);
            var next = await coordinator.AcquireAsync(GatewayTenantDefaults.InternalTenantId, resolution, 5, default);
            Assert.True(next.Allowed, mode); Assert.NotNull(next.Lease); await next.Lease!.DisposeAsync();
        }
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        List<LlmRequestLog> records;
        do
        {
            records = await database.Db.LlmRequestLogs.Find(_ => true).ToListAsync(deadline.Token);
            if (records.Count == 5 && records.All(x => x.EndedAt.HasValue)) break;
            await Task.Delay(20, deadline.Token);
        } while (true);
        Assert.All(records, x => Assert.Equal("failed", x.Status));
        Assert.DoesNotContain(Secret, records.ToJson());
        Assert.Contains(records, x => (x.FinishReason ?? "").Contains("凭据回显", StringComparison.Ordinal));
        Assert.Contains(records, x => (x.FinishReason ?? "").Contains("字节预算", StringComparison.Ordinal));
        Assert.Contains(records, x => x.StatusCode == 499);
    }

    private sealed class BodyFactory(string body, string contentType, Action<HttpResponseMessage>? headers = null,
        bool unknownLength = false) : HttpMessageHandler, IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(this, false);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            HttpContent content = unknownLength ? new StreamContent(new NonSeekableBody(Encoding.UTF8.GetBytes(body)))
                : new StringContent(body, Encoding.UTF8, contentType);
            content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(contentType);
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
            headers?.Invoke(response); return Task.FromResult(response);
        }
    }
    private sealed class NonSeekableBody(byte[] bytes) : MemoryStream(bytes)
    {
        public override bool CanSeek => false;
    }
    private sealed class CancelSource(CancellationTokenSource cancel) : Stream
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) { cancel.Cancel(); return ValueTask.FromCanceled<int>(cancel.Token); }
        public override int Read(byte[] buffer, int offset, int count) => throw new OperationCanceledException();
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { } public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
