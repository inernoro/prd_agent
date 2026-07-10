using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.LlmGateway;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class HttpLlmClientHealthProbeTests
{
    [Fact]
    public async Task StreamGenerateAsync_CarriesHealthProbeInClientStreamPayload()
    {
        string? capturedBody = null;
        var factory = new SingleClientFactory(new HttpClient(new CapturingHandler(async request =>
        {
            request.Method.ShouldBe(HttpMethod.Post);
            request.RequestUri!.AbsolutePath.ShouldBe("/gw/v1/client-stream");
            request.Headers.GetValues("X-Gateway-Key").Single().ShouldBe("gateway-key");
            capturedBody = await request.Content!.ReadAsStringAsync();

            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "data: {\"Type\":\"content\",\"Content\":\"ok\"}\n\n",
                    Encoding.UTF8,
                    "text/event-stream"),
            };
        })));

        var contextAccessor = new LLMRequestContextAccessor();
        using var _ = contextAccessor.BeginScope(new LlmRequestContext(
            RequestId: "req-health-probe",
            GroupId: "group-1",
            SessionId: "session-1",
            UserId: "smoke-test",
            ViewRole: "ops",
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: null,
            RequestType: ModelTypes.Chat,
            AppCallerCode: "prd-agent-smoke.chat::chat",
            IsHealthProbe: true,
            RunId: "run-health-probe"));

        var client = new HttpLlmClient(
            factory,
            "http://llmgw-serve",
            "gateway-key",
            "prd-agent-smoke.chat::chat",
            ModelTypes.Chat,
            maxTokens: 64,
            temperature: 0,
            includeThinking: false,
            expectedModel: null,
            pinnedPlatformId: null,
            pinnedModelId: null,
            jsonOpts: GatewayJsonOptions(),
            logger: NullLogger.Instance,
            ctxAccessor: contextAccessor);

        var chunks = new List<LLMStreamChunk>();
        await foreach (var chunk in client.StreamGenerateAsync(
                           "system",
                           new List<LLMMessage> { new() { Role = "user", Content = "hi" } },
                           enablePromptCache: true))
        {
            chunks.Add(chunk);
        }

        chunks.Count.ShouldBe(1);
        chunks[0].Type.ShouldBe("content");
        chunks[0].Content.ShouldBe("ok");

        capturedBody.ShouldNotBeNull();
        var body = JsonNode.Parse(capturedBody!)!.AsObject();
        var context = body["Context"]!.AsObject();
        context["RequestId"]!.GetValue<string>().ShouldBe("req-health-probe");
        context["RunId"]!.GetValue<string>().ShouldBe("run-health-probe");
        context["UserId"]!.GetValue<string>().ShouldBe("smoke-test");
        context["GatewayTransport"]!.GetValue<string>().ShouldBe(GatewayTransports.Http);
        context["IsHealthProbe"]!.GetValue<bool>().ShouldBeTrue();
    }

    [Fact]
    public void BeginScope_PreservesHealthProbeAcrossNestedScopes()
    {
        var contextAccessor = new LLMRequestContextAccessor();
        using var outer = contextAccessor.BeginScope(new LlmRequestContext(
            RequestId: "outer",
            GroupId: null,
            SessionId: null,
            UserId: "smoke-test",
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: null,
            IsHealthProbe: true,
            RunId: "run-outer"));

        using var inner = contextAccessor.BeginScope(new LlmRequestContext(
            RequestId: "inner",
            GroupId: null,
            SessionId: null,
            UserId: "worker",
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: null));

        contextAccessor.Current!.RequestId.ShouldBe("inner");
        contextAccessor.Current.IsHealthProbe.ShouldBe(true);
        contextAccessor.Current.RunId.ShouldBe("run-outer");
    }

    private static JsonSerializerOptions GatewayJsonOptions()
        => new()
        {
            PropertyNamingPolicy = null,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

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
