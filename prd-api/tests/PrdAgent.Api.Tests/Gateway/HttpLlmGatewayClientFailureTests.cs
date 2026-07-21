using System.Net;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.ModelPool;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// HTTP 模式故障面守卫：serving 不可达或鉴权失败时，MAP 侧 HttpLlmGatewayClient
/// 必须显式失败，不得伪装成成功、空池或回退到 inproc。
/// </summary>
public class HttpLlmGatewayClientFailureTests
{
    [Fact]
    public async Task ProductionGatewayRoot_AppendsServingPathExactlyOnce()
    {
        var factory = new RecordingHttpClientFactory();
        var client = BuildClient(factory, "http://gateway");

        await client.SendAsync(Request());

        factory.RequestUri.ShouldBe(new Uri("http://gateway/gw/v1/send"));
    }

    [Fact]
    public async Task ServingTransportFailure_FailsClosed_ForEveryHttpBoundary()
    {
        var client = BuildClient(new ThrowingHttpClientFactory(new HttpRequestException("serving down")));

        var send = await client.SendAsync(Request());
        send.Success.ShouldBeFalse();
        send.ErrorCode.ShouldBe("GATEWAY_HTTP_ERROR");
        ShouldContainText(send.ErrorMessage, "serving down");

        var stream = await CollectAsync(client.StreamAsync(Request()));
        stream.Count.ShouldBe(1);
        stream[0].Type.ShouldBe(GatewayChunkType.Error);
        ShouldContainText(stream[0].Error, "serving down");

        var raw = await client.SendRawWithResolutionAsync(
            RawRequest(),
            new GatewayModelResolution { Success = true, ActualModel = "m1" });
        raw.Success.ShouldBeFalse();
        raw.ErrorCode.ShouldBe("GATEWAY_HTTP_ERROR");
        ShouldContainText(raw.ErrorMessage, "serving down");

        var profile = await client.TestUpstreamProfileAsync(ProfileRequest());
        profile.Success.ShouldBeFalse();
        profile.ErrorCode.ShouldBe("GATEWAY_HTTP_ERROR");
        ShouldContainText(profile.ErrorMessage, "serving down");

        var resolution = await client.ResolveModelAsync("demo.app::chat", "chat");
        resolution.Success.ShouldBeFalse();
        ShouldContainText(resolution.ErrorMessage, "serving down");

        var poolsEx = await Should.ThrowAsync<HttpRequestException>(
            () => client.GetAvailablePoolsAsync("demo.app::chat", "chat"));
        poolsEx.Message.ShouldContain("serving down");

        var llm = client.CreateClient("demo.app::chat", "chat");
        var llmStream = await CollectAsync(llm.StreamGenerateAsync(
            "sys",
            new List<LLMMessage> { new() { Role = "user", Content = "hi" } }));
        llmStream.Count.ShouldBe(1);
        llmStream[0].Type.ShouldBe("error");
        ShouldContainText(llmStream[0].ErrorMessage, "serving down");
    }

    [Fact]
    public async Task ServingUnauthorized_FailsClosed_ForEveryHttpBoundary()
    {
        var client = BuildClient(new StaticResponseHttpClientFactory(
            HttpStatusCode.Unauthorized,
            "{\"error\":\"bad gateway key\"}"));

        var send = await client.SendAsync(Request());
        send.Success.ShouldBeFalse();
        send.ErrorCode.ShouldBe("GATEWAY_HTTP_ERROR");
        send.StatusCode.ShouldBe(401);
        ShouldContainText(send.ErrorMessage, "401");

        var stream = await CollectAsync(client.StreamAsync(Request()));
        stream.Count.ShouldBe(1);
        stream[0].Type.ShouldBe(GatewayChunkType.Error);
        ShouldContainText(stream[0].Error, "401");

        var raw = await client.SendRawWithResolutionAsync(
            RawRequest(),
            new GatewayModelResolution { Success = true, ActualModel = "m1" });
        raw.Success.ShouldBeFalse();
        raw.ErrorCode.ShouldBe("GATEWAY_HTTP_ERROR");
        raw.StatusCode.ShouldBe(401);
        ShouldContainText(raw.ErrorMessage, "401");

        var profile = await client.TestUpstreamProfileAsync(ProfileRequest());
        profile.Success.ShouldBeFalse();
        profile.ErrorCode.ShouldBe("GATEWAY_HTTP_ERROR");
        profile.StatusCode.ShouldBe(401);
        ShouldContainText(profile.ErrorMessage, "401");

        var resolution = await client.ResolveModelAsync("demo.app::chat", "chat");
        resolution.Success.ShouldBeFalse();
        ShouldContainText(resolution.ErrorMessage, "401");

        var poolsEx = await Should.ThrowAsync<InvalidOperationException>(
            () => client.GetAvailablePoolsAsync("demo.app::chat", "chat"));
        poolsEx.Message.ShouldContain("401");

        var llm = client.CreateClient("demo.app::chat", "chat");
        var llmStream = await CollectAsync(llm.StreamGenerateAsync(
            "sys",
            new List<LLMMessage> { new() { Role = "user", Content = "hi" } }));
        llmStream.Count.ShouldBe(1);
        llmStream[0].Type.ShouldBe("error");
        ShouldContainText(llmStream[0].ErrorMessage, "401");
    }

    [Fact]
    public async Task StructuredRawFailure_PreservesGatewayErrorEnvelope()
    {
        const string body = "{\"Success\":false,\"StatusCode\":422,\"ErrorCode\":\"UPSTREAM_REJECTED\",\"ErrorMessage\":\"invalid image input\",\"LogId\":\"log-123\"}";
        var client = BuildClient(new StaticResponseHttpClientFactory(HttpStatusCode.UnprocessableEntity, body));

        var raw = await client.SendRawWithResolutionAsync(
            RawRequest(),
            new GatewayModelResolution { Success = true, ActualModel = "m1" });
        var profile = await client.TestUpstreamProfileAsync(ProfileRequest());

        raw.ErrorCode.ShouldBe("UPSTREAM_REJECTED");
        raw.ErrorMessage.ShouldBe("invalid image input");
        raw.StatusCode.ShouldBe(422);
        raw.LogId.ShouldBe("log-123");
        profile.ErrorCode.ShouldBe("UPSTREAM_REJECTED");
        profile.StatusCode.ShouldBe(422);
    }

    [Fact]
    public async Task StructuredSendFailure_PreservesGatewayErrorEnvelope()
    {
        const string body = "{\"Success\":false,\"StatusCode\":503,\"ErrorCode\":\"MODEL_POOL_UNAVAILABLE\",\"ErrorMessage\":\"no healthy model\",\"LogId\":\"log-send-123\"}";
        var client = BuildClient(new StaticResponseHttpClientFactory(HttpStatusCode.ServiceUnavailable, body));

        var response = await client.SendAsync(Request());

        response.Success.ShouldBeFalse();
        response.ErrorCode.ShouldBe("MODEL_POOL_UNAVAILABLE");
        response.ErrorMessage.ShouldBe("no healthy model");
        response.StatusCode.ShouldBe(503);
        response.LogId.ShouldBe("log-send-123");
    }

    [Fact]
    public async Task StructuredRawQuotaFailure_NotifiesAdminInHttpMode()
    {
        const string body = "{\"Success\":false,\"StatusCode\":402,\"ErrorCode\":\"LLM_QUOTA_EXCEEDED\",\"ErrorMessage\":\"大模型平台额度已用尽或被限额\"}";
        var notifier = new Mock<IPoolFailoverNotifier>();
        var client = BuildClient(
            new StaticResponseHttpClientFactory(HttpStatusCode.PaymentRequired, body),
            failoverNotifier: notifier.Object);

        var raw = await client.SendRawWithResolutionAsync(
            RawRequest(),
            new GatewayModelResolution
            {
                Success = true,
                ActualModel = "openai/gpt-audio",
                ActualPlatformName = "openrouter.ai",
            });

        raw.ErrorCode.ShouldBe("LLM_QUOTA_EXCEEDED");
        notifier.Verify(x => x.NotifyQuotaExceededAsync(
                "openrouter.ai",
                It.Is<string>(message => message.Contains("额度已用尽")),
                CancellationToken.None),
            Times.Once);
    }

    [Fact]
    public async Task ClientStreamQuotaFailure_NotifiesAdminInHttpMode()
    {
        const string body = "{\"ErrorCode\":\"LLM_QUOTA_EXCEEDED\",\"ErrorMessage\":\"Key limit exceeded (total limit)\"}";
        var notifier = new Mock<IPoolFailoverNotifier>();
        var client = BuildClient(
            new StaticResponseHttpClientFactory(HttpStatusCode.PaymentRequired, body),
            failoverNotifier: notifier.Object);

        var chunks = await CollectAsync(client.CreateClient("demo.app::chat", "chat").StreamGenerateAsync(
            "sys",
            new List<LLMMessage> { new() { Role = "user", Content = "hi" } }));

        chunks.Count.ShouldBe(1);
        chunks[0].Type.ShouldBe("error");
        notifier.Verify(x => x.NotifyQuotaExceededAsync(
                "独立 LLM 网关",
                It.Is<string>(message => message.Contains("Key limit exceeded")),
                CancellationToken.None),
            Times.Once);
    }

    private static HttpLlmGatewayClient BuildClient(
        IHttpClientFactory factory,
        string baseUrl = "http://llmgw-serve.test",
        IPoolFailoverNotifier? failoverNotifier = null)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = baseUrl,
            ["LlmGwServe:ApiKey"] = "test-key",
        }).Build();

        return new HttpLlmGatewayClient(
            factory,
            config,
            NullLogger<HttpLlmGatewayClient>.Instance,
            failoverNotifier: failoverNotifier);
    }

    private static GatewayRequest Request() => new()
    {
        AppCallerCode = "demo.app::chat",
        ModelType = "chat",
    };

    private static GatewayRawRequest RawRequest() => new()
    {
        AppCallerCode = "demo.app::generation",
        ModelType = "generation",
    };

    private static GatewayUpstreamProfileTestRequest ProfileRequest() => new()
    {
        AppCallerCode = "infra-agent.runtime-profile-test::chat",
        Protocol = "openai",
        BaseUrl = "https://example.invalid/v1",
        Model = "runtime-model",
        ApiKey = "SECRET-profile-test-key",
    };

    private static async Task<List<T>> CollectAsync<T>(IAsyncEnumerable<T> source)
    {
        var items = new List<T>();
        await foreach (var item in source)
            items.Add(item);
        return items;
    }

    private static void ShouldContainText(string? actual, string expected)
    {
        actual.ShouldNotBeNullOrWhiteSpace();
        actual!.ShouldContain(expected);
    }

    private sealed class ThrowingHttpClientFactory : IHttpClientFactory
    {
        private readonly Exception _exception;

        public ThrowingHttpClientFactory(Exception exception)
        {
            _exception = exception;
        }

        public HttpClient CreateClient(string name)
            => new(new ThrowingHandler(_exception));
    }

    private sealed class StaticResponseHttpClientFactory : IHttpClientFactory
    {
        private readonly HttpStatusCode _statusCode;
        private readonly string _body;

        public StaticResponseHttpClientFactory(HttpStatusCode statusCode, string body)
        {
            _statusCode = statusCode;
            _body = body;
        }

        public HttpClient CreateClient(string name)
            => new(new StaticResponseHandler(_statusCode, _body));
    }

    private sealed class RecordingHttpClientFactory : IHttpClientFactory
    {
        private readonly RecordingHandler _handler = new();

        public Uri? RequestUri => _handler.RequestUri;

        public HttpClient CreateClient(string name) => new(_handler, disposeHandler: false);

        private sealed class RecordingHandler : HttpMessageHandler
        {
            public Uri? RequestUri { get; private set; }

            protected override Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request,
                CancellationToken cancellationToken)
            {
                RequestUri = request.RequestUri;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized)
                {
                    Content = new StringContent("{\"error\":\"test\"}"),
                });
            }
        }
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        private readonly Exception _exception;

        public ThrowingHandler(Exception exception)
        {
            _exception = exception;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromException<HttpResponseMessage>(_exception);
    }

    private sealed class StaticResponseHandler : HttpMessageHandler
    {
        private readonly HttpStatusCode _statusCode;
        private readonly string _body;

        public StaticResponseHandler(HttpStatusCode statusCode, string body)
        {
            _statusCode = statusCode;
            _body = body;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(new HttpResponseMessage(_statusCode)
            {
                Content = new StringContent(_body),
            });
    }
}
