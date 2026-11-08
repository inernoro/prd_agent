using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayTaskTransportAdmissionTests
{
    [Theory]
    [InlineData("send")]
    [InlineData("stream")]
    [InlineData("raw")]
    [InlineData("image")]
    [InlineData("profile")]
    [InlineData("client-stream")]
    public async Task MissingAuthorizer_RejectsAllPaidTransportsBeforeHttp(string operation)
    {
        var transport = new RecordingTransport();
        var result = await InvokeAsync(BuildClient(transport), operation);
        Assert.Equal("TASK_EXECUTION_NOT_ADMITTED", result);
        Assert.Equal(0, transport.Sends);
    }

    [Theory]
    [InlineData("send")]
    [InlineData("stream")]
    [InlineData("raw")]
    [InlineData("image")]
    [InlineData("profile")]
    [InlineData("client-stream")]
    public async Task GrantedTask_IsPreparedOnceBeforePayloadSerialization(string operation)
    {
        var transport = new RecordingTransport();
        var authorizer = new RecordingAuthorizer();
        var result = await InvokeAsync(BuildClient(transport, authorizer), operation);
        Assert.Null(result);
        Assert.Equal(1, authorizer.Calls);
        Assert.Equal(1, transport.Sends);
        Assert.Equal(AuthorizedGatewayRequest.HttpClientName, transport.ClientName);
        Assert.Equal("transport-unit-test-permit", transport.Permit);
        Assert.Equal("interactive", transport.Origin);
        Assert.Equal("transport-unit-test-permit", transport.Body!["Context"]!["TaskPermitId"]!.GetValue<string>());
        Assert.Equal("interactive", transport.Body["Context"]!["ExecutionOrigin"]!.GetValue<string>());
        Assert.Equal("transport-test-deployment", transport.Body["Context"]!["SourceDeployment"]!.GetValue<string>());
    }

    [Fact]
    public async Task AdmissionDenial_RemainsStructuredAndDoesNotReachHttp()
    {
        var transport = new RecordingTransport();
        var client = BuildClient(transport, new RecordingAuthorizer(deny: true));
        Assert.Equal("TASK_EXECUTION_EXPIRED", await InvokeAsync(client, "send"));
        Assert.Equal("TASK_EXECUTION_EXPIRED", await InvokeAsync(client, "stream"));
        Assert.Equal("TASK_EXECUTION_EXPIRED", await InvokeAsync(client, "client-stream"));
        Assert.Equal(0, transport.Sends);
    }

    [Fact]
    public async Task ReadOnlyResolveAndCatalog_WorkWithoutTaskAuthorizer()
    {
        var transport = new RecordingTransport();
        var client = BuildClient(transport);
        await client.ResolveModelAsync("future-business.chat::chat", ModelTypes.Chat);
        await client.ResolveOfferingAsync("future-business.chat::chat", ModelTypes.Chat, "future-offering");
        await client.GetAvailablePoolsAsync("future-business.chat::chat", ModelTypes.Chat);
        await client.GetImageModelsAsync("future-business.image::generation");
        Assert.Equal(4, transport.Sends);
        Assert.Null(transport.Permit);
    }

    [Fact]
    public async Task AuthorizerThatReturnsWithoutPermit_CannotOpenTransport()
    {
        var transport = new RecordingTransport();
        var result = await InvokeAsync(BuildClient(transport, new EmptyAuthorizer()), "send");
        Assert.Equal("TASK_EXECUTION_NOT_ADMITTED", result);
        Assert.Equal(0, transport.Sends);
    }

    [Fact]
    public async Task MissingAdmission_StopsMultipartBeforeObjectStorageUpload()
    {
        var transport = new RecordingTransport();
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        var client = new HttpLlmGatewayClient(transport, new ConfigurationBuilder().Build(),
            NullLogger<HttpLlmGatewayClient>.Instance, assetStorage: storage.Object);
        var response = await client.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = "future-business.asr::asr", ModelType = ModelTypes.Asr, IsMultipart = true,
            MultipartFiles = new() { ["file"] = ("one.wav", new byte[] { 1, 2 }, "audio/wav") },
        }, new GatewayModelResolution { Success = true, ActualModel = "future-model" });
        Assert.Equal("TASK_EXECUTION_NOT_ADMITTED", response.ErrorCode);
        Assert.Equal(0, transport.Sends);
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task LiveAsrHandshake_RequiresSameTaskAdmissionAndCopiesVerifiedIdentity()
    {
        await Assert.ThrowsAsync<TaskExecutionAdmissionException>(() =>
            DocumentStoreLiveTranscriptionRelay.PrepareHandshakeAsync("https://gateway.invalid", "unit-key",
                null, "actor", "session", CancellationToken.None));
        var authorizer = new RecordingAuthorizer();
        using var handshake = await DocumentStoreLiveTranscriptionRelay.PrepareHandshakeAsync("https://gateway.invalid", "unit-key",
            authorizer, "actor", "session", CancellationToken.None);
        Assert.Equal(1, authorizer.Calls);
        Assert.Equal(HttpMethod.Get, handshake.Method);
        Assert.Equal("/gw/v1/asr/live", handshake.RequestUri!.AbsolutePath);
        Assert.Equal(AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio, handshake.Headers.GetValues("X-Gateway-App-Caller").Single());
        Assert.Equal("transport-unit-test-permit", handshake.Headers.GetValues("X-Gateway-Task-Permit").Single());
        Assert.Equal("interactive", handshake.Headers.GetValues("X-Gateway-Execution-Origin").Single());
    }

    private static HttpLlmGatewayClient BuildClient(RecordingTransport transport, ITaskExecutionAuthorizer? authorizer = null)
        => new(transport, new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "https://gateway.invalid",
            ["LlmGwServe:ApiKey"] = "unit-key",
        }).Build(), NullLogger<HttpLlmGatewayClient>.Instance, taskAuthorizer: authorizer);

    private static GatewayRequestContext Context() => new() { UserId = "actor", RequestId = "unit-request" };

    private static async Task<string?> InvokeAsync(HttpLlmGatewayClient client, string operation)
    {
        var request = new GatewayRequest { AppCallerCode = "future-business.chat::chat", ModelType = ModelTypes.Chat, Context = Context() };
        var raw = new GatewayRawRequest { AppCallerCode = "future-business.image::generation", ModelType = ModelTypes.ImageGen, Context = Context() };
        switch (operation)
        {
            case "send": return (await client.SendAsync(request)).ErrorCode;
            case "stream":
                await foreach (var chunk in client.StreamAsync(request)) return chunk.ErrorCode;
                return null;
            case "raw": return (await client.SendRawWithResolutionAsync(raw, new GatewayModelResolution { Success = true, ActualModel = "future-model" })).ErrorCode;
            case "image": return (await client.GenerateImageAsync(new GatewayRawRequest
            {
                AppCallerCode = raw.AppCallerCode, ModelType = raw.ModelType, Context = Context(), RequiredLogicalModelPublicId = "future-model",
                CanonicalImageRequest = new GatewayCanonicalImageRequest { Prompt = "unit test" },
            }, CancellationToken.None)).ErrorCode;
            case "profile": return (await client.TestUpstreamProfileAsync(new GatewayUpstreamProfileTestRequest
            {
                AppCallerCode = request.AppCallerCode, Protocol = "openai", BaseUrl = "https://upstream.invalid",
                Model = "future-model", ApiKey = "unit-profile-key", Context = Context(),
            })).ErrorCode;
            case "client-stream":
                await foreach (var chunk in client.CreateClient(request.AppCallerCode, ModelTypes.Chat).StreamGenerateAsync(
                                   "unit test", new List<LLMMessage> { new() { Role = "user", Content = "test" } })) return chunk.ErrorCode;
                return null;
            default: throw new InvalidOperationException(operation);
        }
    }

    private sealed class RecordingAuthorizer(bool deny = false) : ITaskExecutionAuthorizer
    {
        public int Calls { get; private set; }
        public Task AuthorizeOutboundAsync(HttpRequestMessage message, string caller, GatewayRequestContext? context, CancellationToken ct)
        {
            Calls++;
            if (deny) throw new TaskExecutionAdmissionException("TASK_EXECUTION_EXPIRED", "本次任务许可已过期，请重新发起操作。");
            return TransportTestTaskAuthorizer.Instance.AuthorizeOutboundAsync(message, caller, context, ct);
        }
    }

    private sealed class EmptyAuthorizer : ITaskExecutionAuthorizer
    {
        public Task AuthorizeOutboundAsync(HttpRequestMessage message, string caller, GatewayRequestContext? context, CancellationToken ct)
            => Task.CompletedTask;
    }

    private sealed class RecordingTransport : HttpMessageHandler, IHttpClientFactory
    {
        public int Sends { get; private set; }
        public string? ClientName { get; private set; }
        public string? Permit { get; private set; }
        public string? Origin { get; private set; }
        public JsonObject? Body { get; private set; }
        public HttpClient CreateClient(string name) { ClientName = name; return new(this, false); }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Sends++;
            Permit = request.Headers.TryGetValues("X-Gateway-Task-Permit", out var permits) ? permits.Single() : null;
            Origin = request.Headers.TryGetValues("X-Gateway-Execution-Origin", out var origins) ? origins.Single() : null;
            if (request.Content is not null) Body = JsonNode.Parse(await request.Content.ReadAsStringAsync(ct))!.AsObject();
            var path = request.RequestUri!.AbsolutePath;
            var body = path switch
            {
                "/gw/v1/client-stream" => "data: {\"Type\":\"content\",\"Content\":\"ok\"}\n\n",
                "/gw/v1/stream" => "data: " + JsonSerializer.Serialize(GatewayStreamChunk.Text("ok")) + "\n\n",
                "/gw/v1/pools" or "/gw/v1/image-models" => "[]",
                _ => "{\"Success\":true,\"StatusCode\":200,\"Content\":\"ok\"}",
            };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }
}
