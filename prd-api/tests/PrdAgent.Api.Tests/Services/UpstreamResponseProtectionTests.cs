using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Services;

public sealed partial class UpstreamResponseProtectionTests(ITestOutputHelper output)
{
    private const string Secret = "synthetic-provider-credential-7b6c";
    private static GatewayRequest Request() => new() { AppCallerCode = "prd-agent-web.lab::chat", ModelType = "chat", IncludeThinking = true, RequestBody = new JsonObject { ["messages"] = new JsonArray() } };
    private static LlmGateway Gateway(IHttpClientFactory factory, ILlmRequestLogWriter logs, IConfiguration? config = null, GatewayProviderConcurrencyCoordinator? coordinator = null)
    {
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(x => x.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ModelResolutionResult { Success = true, ActualModel = "synthetic", ActualPlatformId = "synthetic", PlatformType = "openai", ApiUrl = "https://synthetic.invalid", ApiKey = Secret, ResolutionType = "PinnedModel", SupportsThinking = true, SupportsFunctionCalling = true, PlatformMaxConcurrency = 1 });
        return new LlmGateway(resolver.Object, factory, new TestLogger<LlmGateway>(), logs, configuration: config, concurrencyCoordinator: coordinator);
    }
    private static string Event(string field, string value)
    {
        var delta = field == "arguments" ? new JsonObject { ["tool_calls"] = new JsonArray(new JsonObject { ["index"] = 0, ["function"] = new JsonObject { ["arguments"] = value } }) } : new JsonObject { [field] = value };
        return "data: " + new JsonObject { ["choices"] = new JsonArray(new JsonObject { ["delta"] = delta }) }.ToJsonString() + "\n\n";
    }
    [Theory]
    [InlineData(200, false)] [InlineData(400, false)] [InlineData(200, true)] [InlineData(400, true)]
    public async Task CompleteOrMalformedBodyNeverReturnsOrLogsActiveCredential(int status, bool malformed)
    {
        var body = malformed ? "{broken:\"" + Secret + "\"" : JsonSerializer.Serialize(new { choices = new[] { new { message = new { content = Secret } } } });
        var logs = new CapturingLogWriter(); var factory = new SequenceHttpClientFactory((status, body));
        var result = await Gateway(factory, logs).SendAsync(Request());
        Assert.False(result.Success); Assert.Equal("UPSTREAM_CREDENTIAL_REFLECTION", result.ErrorCode);
        Assert.Null(result.Content); Assert.Null(result.RawResponseBody);
        Assert.DoesNotContain(Secret, JsonSerializer.Serialize(logs.Done)); Assert.DoesNotContain(Secret, logs.Error ?? "");
        Assert.Equal("failed", logs.Done?.Status); Assert.Single(factory.RequestBodies);
    }
    [Theory]
    [InlineData("content")] [InlineData("reasoning_content")] [InlineData("arguments")]
    public async Task SecretSplitAcrossSseEventsIsWithheldBeforeStreamAndAudit(string field)
    {
        var prefix = Secret[..15]; var body = Event(field, prefix) + Event(field, Secret[15..]) + "data: [DONE]\n\n";
        var logs = new CapturingLogWriter(); var chunks = new List<GatewayStreamChunk>();
        await foreach (var chunk in Gateway(new SequenceHttpClientFactory((200, body)), logs).StreamAsync(Request())) chunks.Add(chunk);
        Assert.Equal("UPSTREAM_CREDENTIAL_REFLECTION", Assert.Single(chunks, c => c.Type == GatewayChunkType.Error).ErrorCode);
        Assert.DoesNotContain(prefix, JsonSerializer.Serialize(chunks)); Assert.DoesNotContain(prefix, JsonSerializer.Serialize(logs.Done));
        Assert.Equal("failed", logs.Done?.Status);
    }
    [Theory]
    [InlineData("{\"authorization\":\"unknown-new-secret\"}")]
    [InlineData("{\"nested\":{\"password\":\"unknown-new-secret\"}}")]
    [InlineData("{broken,\"api_key\":\"unknown-new-secret\"")]
    public void StructuredAndMalformedSensitiveFieldsFailClosed(string body)
    {
        var inspector = new UpstreamResponseInspector([Secret], new(), 200);
        var ex = Assert.Throws<UpstreamResponseRejectedException>(() => inspector.CheckBody(Encoding.UTF8.GetBytes(body)));
        Assert.Equal("UPSTREAM_CREDENTIAL_REFLECTION", ex.Code); Assert.DoesNotContain("unknown-new-secret", ex.Message);
    }
    [Fact]
    public void EscapedProviderAndProxyBasicCredentialsAreRejected()
    {
        const string proxy = "synthetic-proxy-credential";
        var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes("synthetic-user:" + proxy));
        foreach (var body in new[] { JsonSerializer.Serialize(new { content = proxy }), basic, "{\"content\":\"" + string.Concat(Secret.Select(c => $"\\u{(int)c:x4}")) + "\"}" })
            Assert.Throws<UpstreamResponseRejectedException>(() => new UpstreamResponseInspector([Secret, proxy, basic], new(), 200).CheckBody(Encoding.UTF8.GetBytes(body)));
        var truncated = "{broken:\"\\u0073" + Secret[1..];
        Assert.Throws<UpstreamResponseRejectedException>(() => new UpstreamResponseInspector([Secret], new(), 200).CheckBody(Encoding.UTF8.GetBytes(truncated)));
    }
    [Fact]
    public async Task SafeSseBytesAndPartialPrefixAtEofRemainUnchanged()
    {
        var input = Event("content", "safe normal output") + Event("content", "synthetic-pro") + "data: [DONE]\n\n";
        using var stream = new ProtectedSseStream(new MemoryStream(Encoding.UTF8.GetBytes(input)), new UpstreamResponseInspector([Secret], new(), 200), new(), false);
        using var target = new MemoryStream(); await stream.CopyToAsync(target);
        Assert.Equal(input, Encoding.UTF8.GetString(target.ToArray()));
    }
    [Theory]
    [InlineData("ResponseBytes", 64, "content")] [InlineData("EventBytes", 64, "content")]
    [InlineData("OutputBytes", 32, "content")] [InlineData("OutputBytes", 32, "reasoning_content")]
    [InlineData("OutputBytes", 32, "arguments")]
    public async Task ConfiguredStreamBudgetRejectsBeforeOversizedContentIsReturned(string key, int limit, string field)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { [$"LlmGateway:ResponseBudget:{key}"] = limit.ToString() }).Build();
        var logs = new CapturingLogWriter(); var chunks = new List<GatewayStreamChunk>();
        await foreach (var chunk in Gateway(new SequenceHttpClientFactory((200, Event(field, new string('x', 256)) + "data: [DONE]\n\n")), logs, config).StreamAsync(Request())) chunks.Add(chunk);
        Assert.Equal("UPSTREAM_RESPONSE_TOO_LARGE", Assert.Single(chunks, c => c.Type == GatewayChunkType.Error).ErrorCode);
        Assert.DoesNotContain(chunks, c => c.Type == GatewayChunkType.Text); Assert.Equal("failed", logs.Done?.Status);
    }
    [Fact]
    public void CumulativeOutputBudgetCountsUtf8BytesAcrossEvents()
    {
        var inspector = new UpstreamResponseInspector([Secret], new(OutputBytes: 32), 200);
        inspector.CheckEvent(JsonSerializer.Serialize(new { content = new string('中', 10) }));
        Assert.Throws<UpstreamResponseRejectedException>(() => inspector.CheckEvent("{\"content\":\"中\"}"));
    }
    [Fact]
    public void CandidateBudgetsHaveNoProductionDefaultAndRejectInvalidConfiguration()
    {
        Assert.Equal(new UpstreamResponseBudget(), UpstreamResponseBudget.Read(null));
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["LlmGateway:ResponseBudget:ResponseBytes"] = "0" }).Build();
        Assert.Throws<InvalidOperationException>(() => UpstreamResponseBudget.Read(config));
    }
    [Theory]
    [InlineData("claude-text")] [InlineData("claude-thinking")] [InlineData("claude-tool")] [InlineData("gemini")]
    public async Task ProtocolSpecificDeltaStringsCannotBypassSplitCredentialCheck(string protocol)
    {
        string Frame(string value) => "data: " + (protocol == "gemini"
            ? new JsonObject { ["candidates"] = new JsonArray(new JsonObject { ["content"] = new JsonObject { ["parts"] = new JsonArray(new JsonObject { ["text"] = value }) } }) }
            : new JsonObject { ["type"] = "content_block_delta", ["index"] = 0, ["delta"] = new JsonObject
                { [protocol == "claude-tool" ? "partial_json" : protocol == "claude-thinking" ? "thinking" : "text"] = value } }).ToJsonString() + "\n\n";
        using var source = new MemoryStream(Encoding.UTF8.GetBytes(Frame(Secret[..15]) + Frame(Secret[15..])));
        using var stream = new ProtectedSseStream(source, new UpstreamResponseInspector([Secret], new(), 200), new(), false);
        using var target = new MemoryStream();
        await Assert.ThrowsAsync<UpstreamResponseRejectedException>(() => stream.CopyToAsync(target));
        Assert.Equal(0, target.Length);
    }
    [Fact]
    public async Task TerminalFrameReleasesSafePrefixWithoutWaitingForEof()
    {
        var data = Event("content", "synthetic-pro") + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n";
        using var source = new PrefixThenStall(Encoding.UTF8.GetBytes(data));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var logs = new CapturingLogWriter(); var chunks = new List<GatewayStreamChunk>();
        await foreach (var chunk in Gateway(new StreamFactory(source), logs).StreamAsync(Request(), deadline.Token)) chunks.Add(chunk);
        Assert.Contains(chunks, x => x.Type == GatewayChunkType.Done);
        Assert.DoesNotContain(chunks, x => x.Type == GatewayChunkType.Error);
        Assert.Equal("synthetic-pro", string.Concat(chunks.Where(x => x.Type == GatewayChunkType.Text).Select(x => x.Content)));
    }
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ReusedSseAssemblerPreservesBytesAcrossSlowReadsAndEventLimit(bool lineEvents)
    {
        var frame = Encoding.UTF8.GetBytes("data: {\"text\":\"你好\"}\n" + (lineEvents ? "" : "\n"));
        var input = frame.Concat(frame).ToArray();
        var budget = new UpstreamResponseBudget(ResponseBytes: input.Length, EventBytes: frame.Length);
        using var stream = new ProtectedSseStream(new MemoryStream(input), new UpstreamResponseInspector([], budget, 200), budget, lineEvents);
        using var output = new MemoryStream();
        var buffer = new byte[3];
        while (await stream.ReadAsync(buffer.AsMemory()) is var read && read > 0)
        {
            output.Write(buffer, 0, read);
            await Task.Yield();
        }
        Assert.Equal(input, output.ToArray());

        var smaller = budget with { EventBytes = frame.Length - 1 };
        using var oversized = new ProtectedSseStream(new MemoryStream(input), new UpstreamResponseInspector([], smaller, 200), smaller, lineEvents);
        var error = await Assert.ThrowsAsync<UpstreamResponseRejectedException>(() => oversized.CopyToAsync(Stream.Null));
        Assert.Equal("UPSTREAM_RESPONSE_TOO_LARGE", error.Code);
    }

    [Fact]
    public async Task ReusedSseAssemblerPropagatesCancellationDuringIncompleteFrame()
    {
        var budget = new UpstreamResponseBudget();
        using var source = new PrefixThenStall("data: {"u8.ToArray());
        using var stream = new ProtectedSseStream(source, new UpstreamResponseInspector([], budget, 200), budget, false);
        using var cancellation = new CancellationTokenSource();
        var read = stream.ReadAsync(new byte[16].AsMemory(), cancellation.Token).AsTask();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => read);
    }

    private sealed class PrefixThenStall(byte[] data) : MemoryStream(data)
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            var count = await base.ReadAsync(buffer, ct);
            if (count != 0) return count;
            await Task.Delay(Timeout.Infinite, ct); return 0;
        }
    }
    [Fact]
    public async Task UnknownLengthBodyStopsAtConfiguredLimitPlusOneAndDisposesSource()
    {
        var source = new CountingSource(8192); var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["LlmGateway:ResponseBudget:ResponseBytes"] = "128" }).Build();
        var logs = new CapturingLogWriter(); var response = await Gateway(new StreamFactory(source), logs, config).SendAsync(Request());
        Assert.Equal("UPSTREAM_RESPONSE_TOO_LARGE", response.ErrorCode); Assert.InRange(source.BytesRead, 1, 129);
        Assert.True(source.Disposed); Assert.Equal("failed", logs.Done?.Status);
    }
    private sealed class StreamFactory(Stream source) : HttpMessageHandler, IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(this, false);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(source) });
    }
    private sealed class CountingSource(int length) : Stream
    {
        public int BytesRead { get; private set; } public bool Disposed { get; private set; }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            ct.ThrowIfCancellationRequested(); var count = Math.Min(buffer.Length, length - BytesRead);
            buffer.Span[..count].Fill((byte)'x'); BytesRead += count; return ValueTask.FromResult(count);
        }
        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).Result;
        protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { } public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
