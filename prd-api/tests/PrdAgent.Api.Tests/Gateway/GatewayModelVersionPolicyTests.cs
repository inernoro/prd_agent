using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class GatewayModelVersionPolicyTests
{
    private static IConfiguration Config() => new ConfigurationBuilder().AddInMemoryCollection(
        new Dictionary<string, string?> { [GatewayModelVersionPolicy.ConfigKey] = "5.6" }).Build();

    [Theory]
    [InlineData("gpt-5.2-chat-latest", false)]
    [InlineData("gpt-5.2-2025-12-11", false)]
    [InlineData("openai/gpt-5.5", false)]
    [InlineData("chatgpt-4o-latest", false)]
    [InlineData("gpt-3.5-turbo-16k", false)]
    [InlineData("gpt-5", false)]
    [InlineData("gpt-5.6-sol", true)]
    [InlineData("gpt-5.10", true)]
    [InlineData("gpt-6.1", true)]
    [InlineData("deepseek-ai/DeepSeek-V4-Flash", true)]
    [InlineData("gpt-image-1.5", true)]
    [InlineData("doubao-seedance-2-0-fast-260128", true)]
    public void EvaluatesPhysicalModelNotProductNumbers(string name, bool allowed)
        => Assert.Equal(allowed, new GatewayModelVersionPolicy(Config()).Allows(name));

    [Fact]
    public void ResolverFiltersRetryAndDoesNotPromotePinnedModel()
    {
        var policy = new GatewayModelVersionPolicy(Config());
        var primary = Resolution("gpt-5.2-chat-latest");
        primary.RetryCandidates = [Resolution("gpt-4o"), Resolution("gpt-5.6-sol")];
        var selected = policy.Filter(primary, true, AppCallerRegistry.VisualAgent.Storyboard.Script);
        Assert.Equal("gpt-5.6-sol", selected.ActualModel);
        var pinned = Resolution("gpt-5.2-chat-latest");
        pinned.RetryCandidates = [Resolution("gpt-5.6-sol")];
        Assert.Equal(GatewayModelVersionPolicy.ErrorCode, policy.Filter(pinned, false, "test::chat").FailureCode);
    }

    [Theory]
    [InlineData("send")]
    [InlineData("stream")]
    [InlineData("raw")]
    public async Task NoOutboundCallForOldModelEvenWithPreResolvedResult(string path)
    {
        var handler = new Recorder();
        var gateway = Gateway(Resolution("gpt-5.2-chat-latest"), handler);
        if (path == "raw")
        {
            var response = await gateway.SendRawWithResolutionAsync(Raw(), Resolution("gpt-5.2-chat-latest").ToGatewayResolution());
            Assert.Equal(GatewayModelVersionPolicy.ErrorCode, response.ErrorCode);
        }
        else if (path == "send")
        {
            var response = await gateway.SendAsync(Request());
            Assert.Equal(GatewayModelVersionPolicy.ErrorCode, response.ErrorCode);
        }
        else
        {
            var chunks = new List<GatewayStreamChunk>();
            await foreach (var chunk in gateway.StreamAsync(Request())) chunks.Add(chunk);
            Assert.Single(chunks);
            Assert.Equal(GatewayChunkType.Error, chunks[0].Type);
        }
        Assert.Empty(handler.Models);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TimeoutFallbackSkipsOldModelAndUsesPermittedCandidate(bool raw)
    {
        var primary = Resolution("deepseek-ai/DeepSeek-V4-Flash");
        primary.RetryCandidates = [Resolution("gpt-5.2-chat-latest"), Resolution("gpt-5.6-sol")];
        var handler = new Recorder { FailFirst = true };
        var gateway = Gateway(primary, handler);
        if (raw) Assert.True((await gateway.SendRawWithResolutionAsync(Raw(), primary.ToGatewayResolution())).Success);
        else Assert.True((await gateway.SendAsync(Request())).Success);
        Assert.Equal(new[] { "deepseek-ai/DeepSeek-V4-Flash", "gpt-5.6-sol" }, handler.Models);
    }

    private static LlmGateway Gateway(ModelResolutionResult resolution, Recorder handler)
    {
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(x => x.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>())).ReturnsAsync(resolution);
        return new LlmGateway(resolver.Object, new Factory(handler), NullLogger<LlmGateway>.Instance, configuration: Config());
    }
    private static ModelResolutionResult Resolution(string model) => new()
    {
        Success = true, ActualModel = model, ActualPlatformId = model, PlatformType = "openai", Protocol = "openai",
        ApiUrl = "https://upstream.test", ApiKey = "test-only", ExpectedModel = "logical-chat"
    };
    private static GatewayRequest Request() => new()
    {
        AppCallerCode = AppCallerRegistry.VisualAgent.Storyboard.Script, ModelType = ModelTypes.Chat,
        RequestBody = new JsonObject { ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "test" }) }
    };
    private static GatewayRawRequest Raw() => new()
    {
        AppCallerCode = AppCallerRegistry.VisualAgent.Storyboard.Script, ModelType = ModelTypes.Chat,
        RequestBody = Request().RequestBody
    };
    private sealed class Factory(Recorder handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
    private sealed class Recorder : HttpMessageHandler
    {
        public List<string> Models { get; } = [];
        public bool FailFirst { get; init; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            Models.Add(body.RootElement.GetProperty("model").GetString()!);
            return new HttpResponseMessage(FailFirst && Models.Count == 1 ? HttpStatusCode.GatewayTimeout : HttpStatusCode.OK)
            {
                Content = new StringContent(Models.Count == 1 && FailFirst ? "timeout" :
                    """{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}""", Encoding.UTF8, "application/json")
            };
        }
    }
}
