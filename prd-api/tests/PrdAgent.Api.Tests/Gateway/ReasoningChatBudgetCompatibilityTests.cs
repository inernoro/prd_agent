using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.LlmGatewayHost;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>真实网关发送到内存 HTTP 替身；不访问供应商、不消费额度。</summary>
public sealed class ReasoningChatBudgetCompatibilityTests
{
    [Theory]
    [InlineData("o3")]
    [InlineData("openai/o3-mini-2025-01-31")]
    [InlineData("o4-mini-2025-04-16")]
    public async Task ArenaClientDefaults_SendOneCompatibleRequestToResolvedReasoningModel(string upstreamModel)
    {
        var transport = new StrictReasoningUpstream();
        var gateway = Gateway(transport, upstreamModel);
        // 与 Arena worker 相同的公共客户端入口和默认参数；业务 publicId 不必等于物理型号。
        var client = gateway.CreateClient(AppCallerRegistry.Desktop.Arena.BattleChat, ModelTypes.Chat,
            maxTokens: 4096, temperature: 0.2, expectedModel: "stable-reasoning");
        var output = new List<LLMStreamChunk>();
        await foreach (var chunk in client.StreamGenerateAsync("", new() { new() { Role = "user", Content = "合成验收" } }))
            output.Add(chunk);

        Assert.Equal(1, transport.Calls);
        Assert.Contains(output, x => x.Content == "合成结果");
        Assert.Equal(upstreamModel, transport.Body!["model"]!.GetValue<string>());
        AssertWire(transport.Body, 1024);
    }

    [Theory]
    [InlineData("o1")]
    [InlineData("o1-mini-2024-09-12")]
    [InlineData("o1-preview")]
    [InlineData("o3-mini-2025-01-31")]
    public void HistoricalReasoning_OnlyNormalizesBudgetAndSampling_NotRolesOrStreaming(string model)
    {
        var body = Request().RequestBody!.DeepClone().AsObject();
        body["stream"] = false;
        var messages = body["messages"]!.ToJsonString();
        var stop = body["stop"]!.ToJsonString();
        var compatibility = typeof(LlmGateway).GetMethod("ApplyOpenAiChatCompletionsCompatibility", BindingFlags.NonPublic | BindingFlags.Static)!;
        compatibility.Invoke(null, new object?[] { body, new ModelResolutionResult
            { Success = true, ActualModel = model, Protocol = "openai" }, null });
        Assert.Equal(128, body["max_completion_tokens"]!.GetValue<int>());
        Assert.False(body.ContainsKey("temperature"));
        Assert.False(body.ContainsKey("top_p"));
        Assert.False(body.ContainsKey("max_tokens"));
        Assert.Equal(messages, body["messages"]!.ToJsonString());
        Assert.Equal(stop, body["stop"]!.ToJsonString());
        Assert.False(body["stream"]!.GetValue<bool>());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BothServingBudgetLayers_PreserveSmallestCapBeforeFinalWire(bool stream)
    {
        var transport = new StrictReasoningUpstream();
        var gateway = Gateway(transport, "o3");
        var original = Request();
        var before = original.RequestBody!.ToJsonString();
        // 这两个生产 helper 在模型解析前执行，使用中间 max_tokens 不得改变最终 wire 或放大额度。
        var endpointCap = typeof(GatewayHttpEndpoints).GetMethod("ApplyTaskBudgetOutputCap", BindingFlags.NonPublic | BindingFlags.Static)!;
        var taskCap = typeof(TaskBudgetGateway).GetMethod("Cap", BindingFlags.NonPublic | BindingFlags.Static)!;
        var capped = (GatewayRequest)endpointCap.Invoke(null, new object[] { original, 256 })!;
        capped = (GatewayRequest)taskCap.Invoke(null, new object[] { capped, 192 })!;
        if (stream)
        {
            var chunks = new List<GatewayStreamChunk>();
            await foreach (var chunk in gateway.StreamAsync(capped)) chunks.Add(chunk);
            Assert.DoesNotContain(chunks, x => x.Type == GatewayChunkType.Error);
            Assert.Contains(chunks, x => x.Type == GatewayChunkType.Text && x.Content == "合成结果");
        }
        else
        {
            var response = await gateway.SendAsync(capped);
            Assert.True(response.Success, response.ErrorMessage);
            Assert.Equal("合成结果", response.Content);
        }
        Assert.Equal(1, transport.Calls);
        AssertWire(transport.Body!, 128);
        Assert.Equal(before, original.RequestBody.ToJsonString());
    }

    [Fact]
    public async Task StrictExplicitUnsupportedParameter_IsRejectedBeforeSend_EvenIfMetadataClaimsSupport()
    {
        var transport = new StrictReasoningUpstream();
        var request = Request(strict: true);
        var response = await Gateway(transport, "o3").SendAsync(request);
        Assert.False(response.Success);
        Assert.Equal("PARAMETER_UNSUPPORTED", response.ErrorCode);
        Assert.Equal(0, transport.Calls);
        Assert.Equal(0.2, request.RequestBody!["temperature"]!.GetValue<double>());
    }

    private static GatewayRequest Request(bool strict = false) => new()
    {
        AppCallerCode = AppCallerRegistry.Desktop.Arena.BattleChat,
        ModelType = ModelTypes.Chat,
        ExpectedModel = "stable-reasoning",
        Context = new GatewayRequestContext { ParameterPolicy = strict ? "strict-require" : null },
        RequestBody = new JsonObject
        {
            ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "合成验收" }),
            ["max_tokens"] = 4096, ["max_completion_tokens"] = 512, ["max_output_tokens"] = 128,
            ["temperature"] = 0.2, ["top_p"] = 0.8, ["presence_penalty"] = 0.1,
            ["frequency_penalty"] = 0.1, ["logprobs"] = true, ["top_logprobs"] = 2,
            ["logit_bias"] = new JsonObject { ["1"] = 1 }, ["stop"] = new JsonArray("结束")
        }
    };

    private static LlmGateway Gateway(StrictReasoningUpstream transport, string model)
    {
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(r => r.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ModelResolutionResult
            {
                Success = true, ActualModel = model, ActualPlatformId = "synthetic-platform",
                PlatformType = "openai", Protocol = "openai", ResolutionType = "Pinned",
                ApiUrl = "https://api.openai.com/v1", ApiKey = "synthetic", MaxTokens = 1024,
                ParameterCapabilities = new() { ["temperature"] = true }
            });
        return new LlmGateway(resolver.Object, transport, NullLogger<LlmGateway>.Instance);
    }

    private static void AssertWire(JsonObject body, int expectedCap)
    {
        Assert.Equal(expectedCap, body["max_completion_tokens"]!.GetValue<int>());
        Assert.False(body.ContainsKey("max_tokens"));
        Assert.False(body.ContainsKey("max_output_tokens"));
        Assert.False(body.ContainsKey("temperature"));
        Assert.False(body.ContainsKey("reasoning_effort"));
    }

    private sealed class StrictReasoningUpstream : HttpMessageHandler, IHttpClientFactory
    {
        public int Calls;
        public JsonObject? Body;
        public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++;
            Body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!.AsObject();
            var forbidden = new[] { "max_tokens", "max_output_tokens", "temperature", "top_p", "presence_penalty",
                "frequency_penalty", "logprobs", "top_logprobs", "logit_bias", "stop" };
            if (forbidden.Any(Body.ContainsKey))
                return new HttpResponseMessage(HttpStatusCode.BadRequest)
                { Content = new StringContent("{\"error\":{\"message\":\"Unsupported parameter\"}}") };
            var streaming = Body["stream"]?.GetValue<bool>() == true;
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = streaming
                    ? new StringContent("data: {\"choices\":[{\"delta\":{\"content\":\"合成结果\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", Encoding.UTF8, "text/event-stream")
                    : new StringContent("{\"choices\":[{\"message\":{\"content\":\"合成结果\"}}]}")
            };
        }
    }
}
