using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class GatewayPinnedModelTests
{
    private const string DefaultPlatformId = "plat-default";
    private const string PinnedPlatformId = "plat-pinned";
    private const string DefaultModel = "default-pool-model";
    private const string PinnedModel = "user-selected-model";
    private const string GatewayKey = "pinned-gateway-key";

    [Fact]
    public async Task LlmGatewaySendAsync_WithPinnedPlatformAndModel_UsesPinnedModelInUpstreamBody()
    {
        string? capturedBody = null;
        var gateway = new LlmGateway(
            CreateResolver(AppCallerRegistry.Admin.ModelLab.Run),
            new SingleClientFactory(new HttpClient(new CapturingHandler(async request =>
            {
                capturedBody = await request.Content!.ReadAsStringAsync();
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        """
                        {"choices":[{"message":{"role":"assistant","content":"pinned ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}
                        """,
                        Encoding.UTF8,
                        "application/json"),
                };
            }))),
            NullLogger<LlmGateway>.Instance);

        var response = await gateway.SendAsync(new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.Admin.ModelLab.Run,
            ModelType = ModelTypes.Chat,
            ExpectedModel = PinnedModel,
            PinnedPlatformId = PinnedPlatformId,
            PinnedModelId = PinnedModel,
            RequestBody = new JsonObject
            {
                ["model"] = DefaultModel,
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "user", ["content"] = "hello" },
                },
            },
        });

        response.Success.ShouldBeTrue(response.ErrorMessage);
        response.Resolution.ShouldNotBeNull();
        response.Resolution!.ResolutionType.ShouldBe("PinnedModel");
        response.Resolution.ActualModel.ShouldBe(PinnedModel);
        response.Resolution.ActualPlatformId.ShouldBe(PinnedPlatformId);

        capturedBody.ShouldNotBeNull();
        var sent = JsonNode.Parse(capturedBody!)!.AsObject();
        sent["model"]!.GetValue<string>().ShouldBe(PinnedModel);
        sent["model"]!.GetValue<string>().ShouldNotBe(DefaultModel);
    }

    [Fact]
    public async Task GatewayCreateClient_StreamGenerateAsync_CarriesPinnedModelContract()
    {
        var gateway = new CapturingGateway();
        var client = new GatewayLLMClient(
            gateway,
            AppCallerRegistry.Desktop.Arena.BattleChat,
            ModelTypes.Chat,
            expectedModel: PinnedModel,
            pinnedPlatformId: PinnedPlatformId,
            pinnedModelId: PinnedModel);

        var chunks = new List<LLMStreamChunk>();
        await foreach (var chunk in client.StreamGenerateAsync(
                           "",
                           new List<LLMMessage> { new() { Role = "user", Content = "battle" } }))
        {
            chunks.Add(chunk);
        }

        chunks.Any(x => x.Type == "done").ShouldBeTrue();
        gateway.CapturedRequest.ShouldNotBeNull();
        gateway.CapturedRequest!.ExpectedModel.ShouldBe(PinnedModel);
        gateway.CapturedRequest.PinnedPlatformId.ShouldBe(PinnedPlatformId);
        gateway.CapturedRequest.PinnedModelId.ShouldBe(PinnedModel);
    }

    [Fact]
    public async Task HttpCreateClient_ClientStream_SerializesPinnedModelContractAcrossProcess()
    {
        string? capturedBody = null;
        var httpGateway = new HttpLlmGatewayClient(
            new SingleClientFactory(new HttpClient(new CapturingHandler(async request =>
            {
                request.RequestUri!.AbsolutePath.ShouldBe("/gw/v1/client-stream");
                request.Headers.GetValues("X-Gateway-Key").Single().ShouldBe(GatewayKey);
                capturedBody = await request.Content!.ReadAsStringAsync();
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("data: {\"Type\":\"done\"}\n\n", Encoding.UTF8, "text/event-stream"),
                };
            }))),
            Config("http://llmgw-serve.test"),
            NullLogger<HttpLlmGatewayClient>.Instance);

        var client = httpGateway.CreateClient(
            AppCallerRegistry.Desktop.Arena.BattleChat,
            ModelTypes.Chat,
            maxTokens: 1234,
            temperature: 0.4,
            includeThinking: true,
            expectedModel: PinnedModel,
            pinnedPlatformId: PinnedPlatformId,
            pinnedModelId: PinnedModel);

        var chunks = new List<LLMStreamChunk>();
        await foreach (var chunk in client.StreamGenerateAsync(
                           "system",
                           new List<LLMMessage> { new() { Role = "user", Content = "arena" } }))
        {
            chunks.Add(chunk);
        }

        chunks.Any(x => x.Type == "done").ShouldBeTrue();
        capturedBody.ShouldNotBeNull();
        var payload = JsonNode.Parse(capturedBody!)!.AsObject();
        payload["AppCallerCode"]!.GetValue<string>().ShouldBe(AppCallerRegistry.Desktop.Arena.BattleChat);
        payload["ModelType"]!.GetValue<string>().ShouldBe(ModelTypes.Chat);
        payload["ExpectedModel"]!.GetValue<string>().ShouldBe(PinnedModel);
        payload["PinnedPlatformId"]!.GetValue<string>().ShouldBe(PinnedPlatformId);
        payload["PinnedModelId"]!.GetValue<string>().ShouldBe(PinnedModel);
        payload["MaxTokens"]!.GetValue<int>().ShouldBe(1234);
        payload["Temperature"]!.GetValue<double>().ShouldBe(0.4);
        payload["IncludeThinking"]!.GetValue<bool>().ShouldBeTrue();
    }

    private static InMemoryModelResolver CreateResolver(string appCallerCode)
    {
        var defaultPlatform = CreatePlatform(DefaultPlatformId, "https://default.example.com", "openai");
        var pinnedPlatform = CreatePlatform(PinnedPlatformId, "https://pinned.example.com", "openai");
        var defaultPool = new ModelGroup
        {
            Id = "pool-default",
            Name = "Default Chat Pool",
            Code = "default-chat",
            ModelType = ModelTypes.Chat,
            IsDefaultForType = true,
            Priority = 0,
            Models = new List<ModelGroupItem>
            {
                new()
                {
                    PlatformId = DefaultPlatformId,
                    ModelId = DefaultModel,
                    Priority = 0,
                    HealthStatus = ModelHealthStatus.Healthy,
                },
            },
        };
        var appCaller = new LLMAppCaller
        {
            Id = "app-caller-test",
            AppCode = appCallerCode,
            DisplayName = "Pinned caller",
            ModelRequirements = new List<AppModelRequirement>(),
        };
        var pinnedModel = new LLMModel
        {
            ModelName = PinnedModel,
            PlatformId = PinnedPlatformId,
            Enabled = true,
            IsMain = true,
        };

        return new InMemoryModelResolver()
            .WithPlatform(defaultPlatform, "sk-default")
            .WithPlatform(pinnedPlatform, "sk-pinned")
            .WithModelGroup(defaultPool)
            .WithLegacyModel(pinnedModel, "sk-pinned")
            .WithAppCaller(appCaller);
    }

    private static LLMPlatform CreatePlatform(string id, string apiUrl, string type) => new()
    {
        Id = id,
        Name = id,
        PlatformType = type,
        ApiUrl = apiUrl,
        Enabled = true,
    };

    private static IConfiguration Config(string baseUrl)
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = baseUrl,
            ["LlmGwServe:ApiKey"] = GatewayKey,
        }).Build();

    private sealed class CapturingGateway : ILlmGateway
    {
        public GatewayRequest? CapturedRequest { get; private set; }

        public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
        {
            CapturedRequest = request;
            return Task.FromResult(GatewayResponse.Ok("ok", Resolution()));
        }

        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
            GatewayRequest request,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
        {
            CapturedRequest = request;
            await Task.Yield();
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Done, Seq = 1 };
        }

        public Task<GatewayRawResponse> SendRawWithResolutionAsync(
            GatewayRawRequest request,
            GatewayModelResolution resolution,
            CancellationToken ct = default)
            => throw new NotSupportedException();

        public Task<GatewayModelResolution> ResolveModelAsync(
            string appCallerCode,
            string modelType,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null,
            CancellationToken ct = default)
            => Task.FromResult(Resolution());

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
            string appCallerCode,
            string modelType,
            CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool>());

        public ILLMClient CreateClient(
            string appCallerCode,
            string modelType,
            int maxTokens = 4096,
            double temperature = 0.2,
            bool includeThinking = false,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null)
            => throw new NotSupportedException();

        private static GatewayModelResolution Resolution() => new()
        {
            Success = true,
            ActualModel = PinnedModel,
            ActualPlatformId = PinnedPlatformId,
            ResolutionType = "PinnedModel",
            Protocol = "openai",
            PlatformType = "openai",
        };
    }

    private sealed class CapturingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> _handler;

        public CapturingHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> handler)
        {
            _handler = handler;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => _handler(request);
    }

    private sealed class SingleClientFactory : IHttpClientFactory
    {
        private readonly HttpClient _client;

        public SingleClientFactory(HttpClient client)
        {
            _client = client;
        }

        public HttpClient CreateClient(string name) => _client;
    }
}
