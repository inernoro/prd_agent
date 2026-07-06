using System.Net;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.LlmGateway;
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

    private static HttpLlmGatewayClient BuildClient(IHttpClientFactory factory)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "http://llmgw-serve.test",
            ["LlmGwServe:ApiKey"] = "test-key",
        }).Build();

        return new HttpLlmGatewayClient(
            factory,
            config,
            NullLogger<HttpLlmGatewayClient>.Instance);
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
