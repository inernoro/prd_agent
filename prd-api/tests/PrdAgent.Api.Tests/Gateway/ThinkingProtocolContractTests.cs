using System.Net;
using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Adapters;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class ThinkingProtocolContractTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ClaudeOpeningUsage_WithoutCompletionFailsAndNeverLogsSuccess(bool partialText)
    {
        var http = new ProtocolUpstream(false) { ClaudeOpeningOnly = true, PartialText = partialText };
        var log = new Mock<ILlmRequestLogWriter>();
        log.Setup(x => x.StartAsync(It.IsAny<LlmLogStart>(), It.IsAny<CancellationToken>())).ReturnsAsync("opening-test");
        var (gateway, _) = CreateGateway(http, true, log.Object);
        var chunks = await Collect(gateway.StreamAsync(Request(includeThinking: false)));
        Assert.DoesNotContain(chunks, c => c.Type == GatewayChunkType.Done);
        Assert.Equal("UPSTREAM_OUTCOME_UNKNOWN", Assert.Single(chunks, c => c.Type == GatewayChunkType.Error).ErrorCode);
        Assert.Equal(partialText ? "partial" : "", string.Concat(chunks.Where(c => c.Type == GatewayChunkType.Text).Select(c => c.Content)));
        log.Verify(x => x.MarkDone("opening-test", It.Is<LlmLogDone>(d => d.Status == "failed")), Times.Once);
        log.Verify(x => x.MarkFirstByte("opening-test", It.IsAny<DateTime>()), partialText ? Times.Once() : Times.Never());
        Assert.Equal(1, http.Calls);
    }

    [Fact]
    public async Task ClaudeOpeningUsage_CannotDisableFirstOutputDeadline()
    {
        var http = new ProtocolUpstream(false) { ClaudeOpeningOnly = true, StallAfterOpening = true };
        var (gateway, _) = CreateGateway(http, true, firstByteTimeout: 1);
        var watch = Stopwatch.StartNew();
        var chunks = await Collect(gateway.StreamAsync(Request(includeThinking: false, timeoutSeconds: 4)))
            .WaitAsync(TimeSpan.FromSeconds(5));
        Assert.DoesNotContain(chunks, c => c.Type == GatewayChunkType.Done);
        Assert.Equal("UPSTREAM_OUTCOME_UNKNOWN", Assert.Single(chunks, c => c.Type == GatewayChunkType.Error).ErrorCode);
        Assert.InRange(watch.Elapsed.TotalSeconds, 0.7, 2.5);
        Assert.Equal(1, http.Calls);
    }

    [Fact]
    public async Task Gateway_ToolOnlyResponseDoesNotExposeProtocolEnvelopeAsAssistantText()
    {
        var http = new ProtocolUpstream(false) { ToolOnly = true };
        var (gateway, _) = CreateGateway(http, supportsThinking: true);
        var response = await gateway.SendAsync(Request());
        Assert.True(response.Success, response.ErrorMessage);
        Assert.Single(response.ToolCalls!);
        Assert.Null(response.Content);
        Assert.Contains("choices", response.RawResponseBody);
    }

    [Theory]
    [InlineData("https://api.openai.com/v1/chat/completions", false)]
    [InlineData("https://openrouter.ai/api/v1/chat/completions", true)]
    [InlineData("https://openrouter.ai.evil.example/v1/chat/completions", false)]
    public async Task Adapter_ConsumesGatewayStrictFlagWithoutLeakingProviderObject(string endpoint, bool openRouter)
    {
        var body = Body();
        body["provider"] = new JsonObject { ["require_parameters"] = true };
        using var request = new OpenAIGatewayAdapter().BuildHttpRequest(endpoint, "synthetic", body);
        var wire = JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;
        Assert.Equal(openRouter, wire["provider"] is not null);
        if (openRouter) Assert.True(wire["provider"]!["require_parameters"]!.GetValue<bool>());
    }

    [Theory]
    [InlineData("https://api.openai.com/v1/chat/completions", false)]
    [InlineData("https://openrouter.ai/api/v1/chat/completions", true)]
    [InlineData("https://openrouter.ai.evil.example/api/v1/chat/completions", false)]
    [InlineData("https://proxy.example/openrouter.ai/chat/completions", false)]
    [InlineData("http://openrouter.ai/api/v1/chat/completions", false)]
    public async Task Adapter_EncodesExtensionsOnlyForExactOpenRouterTarget(string endpoint, bool openRouter)
    {
        var adapter = new OpenAIGatewayAdapter();
        var body = Body();
        using var request = adapter.BuildHttpRequest(endpoint, "test", body, includeThinking: true);
        var wire = JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;
        Assert.Equal(openRouter, wire["include_reasoning"] != null);
        Assert.Equal(openRouter, wire["reasoning"] != null);
        if (openRouter)
        {
            Assert.True(wire["include_reasoning"]!.GetValue<bool>());
            Assert.False(wire["reasoning"]!["exclude"]!.GetValue<bool>());
        }
    }

    [Fact]
    public async Task Adapter_PreservesExplicitReasoningBudget()
    {
        var body = Body();
        body["reasoning"] = new JsonObject { ["max_tokens"] = 256, ["exclude"] = true };
        using var request = new OpenAIGatewayAdapter().BuildHttpRequest(
            "https://openrouter.ai/api/v1/chat/completions", "test", body, includeThinking: true);
        var wire = JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;
        Assert.Equal(256, wire["reasoning"]!["max_tokens"]!.GetValue<int>());
        Assert.False(wire["reasoning"]!["exclude"]!.GetValue<bool>());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Gateway_SameIntent_SucceedsOnStrictNativeAndStreamsOpenRouterThinking(bool openRouter)
    {
        var http = new ProtocolUpstream(openRouter);
        var (gateway, resolver) = CreateGateway(http, supportsThinking: true);
        var request = Request();
        var original = request.RequestBody!.DeepClone().ToJsonString();
        var chunks = await Collect(gateway.StreamAsync(request));
        Assert.DoesNotContain(chunks, c => c.Type == GatewayChunkType.Error);
        Assert.Contains(chunks, c => c.Type == GatewayChunkType.Thinking && c.Content == "推理过程");
        Assert.Contains(chunks, c => c.Type == GatewayChunkType.Text && c.Content == "结果");
        Assert.Contains(chunks, c => c.Type == GatewayChunkType.Done);
        Assert.Equal(original, request.RequestBody.ToJsonString());
        Assert.Equal(1, http.Calls);
        resolver.Verify(r => r.ResolveAsync(request.AppCallerCode, "chat", null, null, null,
            It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task StrictNative_RejectsLegacyBody_ButAcceptsSameModelInputAndThinkingIntent()
    {
        var http = new ProtocolUpstream(openRouter: false);
        var (gateway, _) = CreateGateway(http, supportsThinking: true);
        var legacyBody = Body();
        legacyBody["include_reasoning"] = true;
        legacyBody["reasoning"] = new JsonObject { ["exclude"] = false };
        var before = await Collect(gateway.StreamAsync(Request(body: legacyBody)));
        var error = Assert.Single(before, c => c.Type == GatewayChunkType.Error);
        Assert.Equal("LLM_ERROR", error.ErrorCode);
        Assert.Equal("contract-model", error.Resolution!.ActualModel);
        Assert.Contains("Unknown parameter", error.Error);

        var after = await Collect(gateway.StreamAsync(Request()));
        Assert.DoesNotContain(after, c => c.Type == GatewayChunkType.Error);
        Assert.Contains(after, c => c.Type == GatewayChunkType.Text && c.Content == "结果");
        Assert.Equal(2, http.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NonStreaming_AlsoEncodesIntentAtResolvedTarget(bool openRouter)
    {
        var http = new ProtocolUpstream(openRouter);
        var (gateway, _) = CreateGateway(http, supportsThinking: true);
        var response = await gateway.SendAsync(Request());
        Assert.True(response.Success, response.ErrorMessage);
        Assert.Equal("结果", response.Content);
        Assert.Equal(1, http.Calls);
    }

    [Theory]
    [InlineData(false, "THINKING_UNSUPPORTED")]
    [InlineData(null, "THINKING_UNVERIFIED")]
    public async Task CapabilityFailure_PreservesCodeAndResolution_WithoutSending(bool? supported, string code)
    {
        var http = new ProtocolUpstream(openRouter: true);
        var (gateway, _) = CreateGateway(http, supported);
        var error = Assert.Single(await Collect(gateway.StreamAsync(Request(strict: true))));
        Assert.Equal(GatewayChunkType.Error, error.Type);
        Assert.Equal(code, error.ErrorCode);
        Assert.Equal("contract-model", error.Resolution!.ActualModel);
        Assert.Equal(0, http.Calls);
    }

    [Fact]
    public async Task OpenRouter_WithoutThinkingIntent_DoesNotEnableReasoning()
    {
        var http = new ProtocolUpstream(openRouter: true) { ExpectThinking = false };
        var (gateway, _) = CreateGateway(http, supportsThinking: true);
        var chunks = await Collect(gateway.StreamAsync(Request(includeThinking: false)));
        Assert.DoesNotContain(chunks, c => c.Type is GatewayChunkType.Error or GatewayChunkType.Thinking);
        Assert.Contains(chunks, c => c.Type == GatewayChunkType.Text);
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest, "LLM_ERROR")]
    [InlineData(HttpStatusCode.Unauthorized, "LLM_ERROR")]
    [InlineData(HttpStatusCode.ServiceUnavailable, "UPSTREAM_OUTCOME_UNKNOWN")]
    public async Task UpstreamFailure_RemainsDistinctFromCapabilityFailure(HttpStatusCode status, string code)
    {
        var http = new ProtocolUpstream(openRouter: false) { Failure = status };
        var (gateway, _) = CreateGateway(http, supportsThinking: true);
        var error = Assert.Single(await Collect(gateway.StreamAsync(Request())),
            c => c.Type == GatewayChunkType.Error);
        Assert.Equal(code, error.ErrorCode);
        Assert.Equal("contract-model", error.Resolution!.ActualModel);
        Assert.Equal(1, http.Calls);
    }

    [Theory]
    [InlineData(false, "网络")]
    [InlineData(true, "超时")]
    public async Task TransportFailure_PreservesCauseAndMarksUnknownExecution(bool timeout, string cause)
    {
        var http = new ProtocolUpstream(openRouter: false)
        {
            TransportFailure = timeout ? new TaskCanceledException("arbitrary detail")
                : new HttpRequestException("arbitrary detail"),
        };
        var (gateway, _) = CreateGateway(http, supportsThinking: true);
        var error = Assert.Single(await Collect(gateway.StreamAsync(Request())),
            c => c.Type == GatewayChunkType.Error);
        Assert.Equal("UPSTREAM_OUTCOME_UNKNOWN", error.ErrorCode);
        Assert.Contains(cause, error.Error);
        Assert.Equal("contract-model", error.Resolution!.ActualModel);
        Assert.Equal(1, http.Calls);
    }

    private static JsonObject Body() => new()
    {
        ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "相同输入" }),
        ["temperature"] = 0.5,
    };

    private static GatewayRequest Request(JsonObject? body = null, bool strict = false, bool includeThinking = true, int timeoutSeconds = 120)
        => new()
        {
            AppCallerCode = AppCallerRegistry.ReportAgent.Polish.ItemRefine,
            ModelType = "chat",
            IncludeThinking = includeThinking,
            TimeoutSeconds = timeoutSeconds,
            RequestBody = body ?? Body(),
            Context = new GatewayRequestContext { ParameterPolicy = strict ? "strict-require" : null },
        };

    private static (LlmGateway, Mock<IModelResolver>) CreateGateway(ProtocolUpstream http, bool? supportsThinking,
        ILlmRequestLogWriter? log = null, int firstByteTimeout = 30)
    {
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(r => r.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(),
                It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ModelResolutionResult
            {
                Success = true, ActualModel = "contract-model", ResolutionType = "Pinned",
                ActualPlatformId = "contract-platform", PlatformType = http.ClaudeOpeningOnly ? "claude" : "openai",
                Protocol = http.ClaudeOpeningOnly ? "claude" : "openai",
                ApiUrl = http.OpenRouter ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1",
                ApiKey = "test", SupportsThinking = supportsThinking,
                ParameterCapabilities = new() { ["temperature"] = true },
            });
        return (new LlmGateway(resolver.Object, http, NullLogger<LlmGateway>.Instance, log,
            configuration: new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            { ["LlmGateway:FirstByteTimeoutSeconds"] = firstByteTimeout.ToString() }).Build()), resolver);
    }

    private static async Task<List<GatewayStreamChunk>> Collect(IAsyncEnumerable<GatewayStreamChunk> stream)
    {
        var result = new List<GatewayStreamChunk>();
        await foreach (var chunk in stream) result.Add(chunk);
        return result;
    }

    // A strict upstream rejects the old body; OpenRouter emits thinking only when its
    // explicit extension is present. The same gateway path must satisfy both contracts.
    private sealed class ProtocolUpstream(bool openRouter) : IHttpClientFactory
    {
        public bool ToolOnly { get; init; }
        public bool ClaudeOpeningOnly { get; init; }
        public bool PartialText { get; init; }
        public bool StallAfterOpening { get; init; }
        internal bool OpenRouter => openRouter;
        internal int Calls;
        internal bool ExpectThinking = true;
        internal HttpStatusCode? Failure;
        internal Exception? TransportFailure;
        public HttpClient CreateClient(string name) => new(new Handler(this));

        private sealed class Handler(ProtocolUpstream owner) : HttpMessageHandler
        {
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            {
                owner.Calls++;
                if (owner.TransportFailure is { } failureException) throw failureException;
                var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!.AsObject();
                Assert.Equal("contract-model", body["model"]!.GetValue<string>());
                if (owner.ClaudeOpeningOnly)
                {
                    var opening = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":11,\"output_tokens\":0}}}\n\n";
                    if (owner.PartialText) opening += "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n";
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = owner.StallAfterOpening
                            ? new StreamContent(new OpeningThenStallStream(Encoding.UTF8.GetBytes(opening)))
                            : new StringContent(opening, Encoding.UTF8, "text/event-stream")
                    };
                }
                if (!owner.OpenRouter)
                {
                    var allowed = new[] { "model", "messages", "temperature", "stream", "stream_options" };
                    var unknown = body.FirstOrDefault(p => !allowed.Contains(p.Key)).Key;
                    if (unknown != null) return Error(HttpStatusCode.BadRequest, $"Unknown parameter: '{unknown}'");
                }
                else if (owner.ExpectThinking)
                {
                    Assert.True(body["include_reasoning"]?.GetValue<bool>());
                    Assert.False(body["reasoning"]?["exclude"]?.GetValue<bool>());
                }
                else
                {
                    Assert.Null(body["include_reasoning"]);
                    Assert.Null(body["reasoning"]);
                }
                if (owner.Failure is { } failure) return Error(failure, "upstream contract failure");
                if (body["stream"]?.GetValue<bool>() != true)
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(owner.ToolOnly
                            ? """{"choices":[{"message":{"content":null,"tool_calls":[{"id":"call_one","type":"function","function":{"name":"echo_city","arguments":"{\"city\":\"北京\"}"}}]},"finish_reason":"tool_calls"}]}"""
                            : "{\"choices\":[{\"message\":{\"content\":\"结果\"}}]}")
                    };
                var reasoningField = owner.OpenRouter ? "reasoning" : "reasoning_content";
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        $"data: {{\"choices\":[{{\"delta\":{{\"{reasoningField}\":\"推理过程\"}}}}]}}\n\n" +
                        "data: {\"choices\":[{\"delta\":{\"content\":\"结果\"}}]}\n\n" +
                        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
                        "data: [DONE]\n\n", Encoding.UTF8, "text/event-stream")
                };
            }

            private static HttpResponseMessage Error(HttpStatusCode status, string message) => new(status)
            {
                Content = new StringContent(new JsonObject
                {
                    ["error"] = new JsonObject { ["message"] = message }
                }.ToJsonString())
            };
        }
    }

    private sealed class OpeningThenStallStream(byte[] opening) : MemoryStream(opening)
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var count = await base.ReadAsync(buffer, cancellationToken);
            if (count > 0) return count;
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return 0;
        }
    }
}
