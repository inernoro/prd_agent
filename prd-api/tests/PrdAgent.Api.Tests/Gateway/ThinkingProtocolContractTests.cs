using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Adapters;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class ThinkingProtocolContractTests
{
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
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    public async Task UpstreamFailure_RemainsDistinctFromCapabilityFailure(HttpStatusCode status)
    {
        var http = new ProtocolUpstream(openRouter: false) { Failure = status };
        var (gateway, _) = CreateGateway(http, supportsThinking: true);
        var error = Assert.Single(await Collect(gateway.StreamAsync(Request())),
            c => c.Type == GatewayChunkType.Error);
        Assert.Equal("LLM_ERROR", error.ErrorCode);
        Assert.Equal("contract-model", error.Resolution!.ActualModel);
        Assert.Equal(1, http.Calls);
    }

    [Theory]
    [InlineData(false, "NETWORK_ERROR")]
    [InlineData(true, "TIMEOUT")]
    public async Task TransportFailure_PreservesTypedClassification(bool timeout, string code)
    {
        var http = new ProtocolUpstream(openRouter: false)
        {
            TransportFailure = timeout ? new TaskCanceledException("arbitrary detail")
                : new HttpRequestException("arbitrary detail"),
        };
        var (gateway, _) = CreateGateway(http, supportsThinking: true);
        var error = Assert.Single(await Collect(gateway.StreamAsync(Request())),
            c => c.Type == GatewayChunkType.Error);
        Assert.Equal(code, error.ErrorCode);
        Assert.Equal("contract-model", error.Resolution!.ActualModel);
        Assert.Equal(1, http.Calls);
    }

    private static JsonObject Body() => new()
    {
        ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "相同输入" }),
        ["temperature"] = 0.5,
    };

    private static GatewayRequest Request(JsonObject? body = null, bool strict = false, bool includeThinking = true)
        => new()
        {
            AppCallerCode = AppCallerRegistry.ReportAgent.Polish.ItemRefine,
            ModelType = "chat",
            IncludeThinking = includeThinking,
            RequestBody = body ?? Body(),
            Context = new GatewayRequestContext { ParameterPolicy = strict ? "strict-require" : null },
        };

    private static (LlmGateway, Mock<IModelResolver>) CreateGateway(ProtocolUpstream http, bool? supportsThinking)
    {
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(r => r.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(),
                It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ModelResolutionResult
            {
                Success = true, ActualModel = "contract-model", ResolutionType = "Pinned",
                ActualPlatformId = "contract-platform", PlatformType = "openai", Protocol = "openai",
                ApiUrl = http.OpenRouter ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1",
                ApiKey = "test", SupportsThinking = supportsThinking,
                ParameterCapabilities = new() { ["temperature"] = true },
            });
        return (new LlmGateway(resolver.Object, http, NullLogger<LlmGateway>.Instance), resolver);
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
                        Content = new StringContent("{\"choices\":[{\"message\":{\"content\":\"结果\"}}]}")
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
}
