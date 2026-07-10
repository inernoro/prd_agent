using System.Net;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// serving 网关「密钥门」安全契约（纯 in-process TestServer，CI 常驻，非 Integration）。
///
/// 为什么单独拆出来常开：CrossProcessServingSelfTest / CrossProcessServingErrorLoadTests 里也顺带
/// 断言了错 key → 401，但那两个用真 Kestrel + 真 socket 往返，成功响应体读取在 pull_request runner
/// 上环境敏感，按本仓约定标 [Trait(Category,Integration)]（CI 默认跳过）。而「无 / 错 X-Gateway-Key
/// 一律 401」是 M2M 边界最基本的安全契约，绝不该只在手动 dispatch 才验。
///
/// 本测试用 Microsoft.AspNetCore.TestHost 的 in-process TestServer（无 socket、无端口、无流式成功体
/// 读取），只走 401 短路分支，完全确定性，故可安全地作为非 Integration [Fact] 每次 CI 跑。
/// 端点映射复用生产同一份 MapGatewayServingEndpoints（SSOT，见 GatewayHttpEndpoints）。
/// 见 doc/design.llm-gateway-physical-isolation.md。
/// </summary>
public class GatewayKeyGateContractTests
{
    private const string GatewayKey = "correct-gateway-key";

    /// <summary>
    /// 起一个 in-process TestServer host 住 serving 端点，上游用永不被触达的 stub
    /// （401 短路发生在中间件层，永远到不了 gateway，故 stub 内部若被调用即抛，反证 401 真短路）。
    /// </summary>
    private static WebApplication BuildHost()
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseTestServer();
        builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = null);
        builder.Services.AddSingleton<PrdAgent.Infrastructure.LlmGateway.ILlmGateway, ThrowingGateway>();
        builder.Services.AddSingleton<ILLMRequestContextAccessor, PrdAgent.Core.Services.LLMRequestContextAccessor>();
        builder.Services.AddSingleton<GatewayCancellationRegistry>();

        var app = builder.Build();
        var pascalJson = new JsonSerializerOptions
        {
            PropertyNamingPolicy = null,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };
        app.MapGatewayServingEndpoints(pascalJson, GatewayKey, "keygate-contract-test");
        return app;
    }

    // /gw/v1/* 的写端点（send/resolve/raw）与读端点（pools）都覆盖，证明密钥门是全 /gw/v1 前缀级。
    public static IEnumerable<object[]> ProtectedRequests() => new[]
    {
        new object[] { HttpMethod.Post, "/gw/v1/invoke" },
        new object[] { HttpMethod.Post, "/gw/v1/send" },
        new object[] { HttpMethod.Post, "/gw/v1/resolve" },
        new object[] { HttpMethod.Post, "/gw/v1/raw" },
        new object[] { HttpMethod.Post, "/gw/v1/profile-test" },
        new object[] { HttpMethod.Post, "/gw/v1/stream" },
        new object[] { HttpMethod.Post, "/gw/v1/client-stream" },
        new object[] { HttpMethod.Get, "/gw/v1/route-self-test" },
        new object[] { HttpMethod.Get, "/gw/v1/readyz" },
        new object[] { HttpMethod.Get, "/gw/v1/requests/test/status?operation=raw-submit" },
        new object[] { HttpMethod.Post, "/v1/chat/completions" },
        new object[] { HttpMethod.Post, "/v1/responses" },
        new object[] { HttpMethod.Post, "/v1/images/generations" },
        new object[] { HttpMethod.Post, "/v1/images/edits" },
        new object[] { HttpMethod.Post, "/v1/messages" },
        new object[] { HttpMethod.Post, "/v1beta/models/gemini-test:generateContent" },
        new object[] { HttpMethod.Post, "/v1beta/models/gemini-test:streamGenerateContent" },
        new object[] { HttpMethod.Post, "/gemini/v1beta/models/gemini-test:generateContent" },
        new object[] { HttpMethod.Post, "/gemini/v1beta/models/gemini-test:streamGenerateContent" },
        new object[] { HttpMethod.Get, "/gw/v1/pools?appCallerCode=demo.app::chat&modelType=chat" },
        new object[] { HttpMethod.Get, "/gw/v1/shadow-comparisons?sinceHours=24" },
    };

    [Theory]
    [MemberData(nameof(ProtectedRequests))]
    public async Task NoGatewayKey_Returns401_OnEveryProtectedEndpoint(HttpMethod method, string path)
    {
        await using var app = BuildHost();
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(method, path);
            if (method == HttpMethod.Post) req.Content = JsonContent.Create(new { AppCallerCode = "demo.app::chat", ModelType = "chat" });

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.Unauthorized,
                $"{method} {path} 缺 X-Gateway-Key 必须 401（M2M 密钥门）");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task WrongGatewayKey_Returns401()
    {
        await using var app = BuildHost();
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/send")
            {
                Content = JsonContent.Create(new { AppCallerCode = "demo.app::chat", ModelType = "chat" }),
            };
            req.Headers.Add("X-Gateway-Key", "WRONG-KEY");

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.Unauthorized, "错 X-Gateway-Key 必须 401");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task Readyz_WithKey_Returns503WhenDependencyProbeFails()
    {
        var snapshot = new GatewayServingReadinessSnapshot(
            false,
            DateTime.UtcNow,
            new[]
            {
                new GatewayServingReadinessComponent("gateway-mongo", false, 3, "probe failed"),
            });
        await using var app = BuildHostWithGateway(new EchoingGateway(), new StubReadinessProbe(snapshot));
        await app.StartAsync();
        try
        {
            var request = new HttpRequestMessage(HttpMethod.Get, "/gw/v1/readyz");
            request.Headers.Add("X-Gateway-Key", GatewayKey);
            var response = await app.GetTestClient().SendAsync(request);
            var body = await response.Content.ReadAsStringAsync();

            response.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
            body.ShouldContain("not-ready");
            body.ShouldContain("gateway-mongo");
            body.ShouldNotContain(GatewayKey);
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task Readyz_FailsClosed_WhenProbeIsNotRegistered()
    {
        await using var app = BuildHostWithGateway(new EchoingGateway());
        await app.StartAsync();
        try
        {
            var request = new HttpRequestMessage(HttpMethod.Get, "/gw/v1/readyz");
            request.Headers.Add("X-Gateway-Key", GatewayKey);
            var response = await app.GetTestClient().SendAsync(request);
            var body = await response.Content.ReadAsStringAsync();

            response.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
            body.ShouldContain("readiness-probe-not-registered");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task Readyz_Returns200WhenAllDependencyProbesPass()
    {
        var snapshot = new GatewayServingReadinessSnapshot(
            true,
            DateTime.UtcNow,
            new[]
            {
                new GatewayServingReadinessComponent("gateway-mongo", true, 2, "ping ok"),
                new GatewayServingReadinessComponent("router", true, 4, "2 pools ready"),
            });
        await using var app = BuildHostWithGateway(new EchoingGateway(), new StubReadinessProbe(snapshot));
        await app.StartAsync();
        try
        {
            var request = new HttpRequestMessage(HttpMethod.Get, "/gw/v1/readyz");
            request.Headers.Add("X-Gateway-Key", GatewayKey);
            var response = await app.GetTestClient().SendAsync(request);
            var body = await response.Content.ReadAsStringAsync();

            response.StatusCode.ShouldBe(HttpStatusCode.OK);
            body.ShouldContain("ready");
            body.ShouldContain("router");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task CancelEndpoint_CancelsOnlyRegisteredRequest()
    {
        await using var app = BuildHostWithGateway(new EchoingGateway());
        await app.StartAsync();
        try
        {
            var registry = app.Services.GetRequiredService<GatewayCancellationRegistry>();
            using var lease = registry.Register("demo.app::chat", "cancel-me");
            var request = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/requests/cancel-me/cancel");
            request.Headers.Add("X-Gateway-Key", GatewayKey);
            request.Headers.Add("X-Gateway-App-Caller", "demo.app::chat");

            var response = await app.GetTestClient().SendAsync(request);

            response.StatusCode.ShouldBe(HttpStatusCode.Accepted);
            lease.Token.IsCancellationRequested.ShouldBeTrue();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task CancelEndpoint_CannotCancelAnotherAppCallerRequest()
    {
        await using var app = BuildHostWithGateway(new EchoingGateway());
        await app.StartAsync();
        try
        {
            var registry = app.Services.GetRequiredService<GatewayCancellationRegistry>();
            using var lease = registry.Register("caller-b::chat", "shared-request-id");
            var request = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/requests/shared-request-id/cancel");
            request.Headers.Add("X-Gateway-Key", GatewayKey);
            request.Headers.Add("X-Gateway-App-Caller", "caller-a::chat");

            var response = await app.GetTestClient().SendAsync(request);

            response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
            lease.Token.IsCancellationRequested.ShouldBeFalse();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task CancelEndpoint_StopsOpenAiCompatibleRequestWithSameRequestId()
    {
        var gateway = new CancellableGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var send = new HttpRequestMessage(HttpMethod.Post, "/v1/chat/completions")
            {
                Content = JsonContent.Create(new
                {
                    model = "auto",
                    messages = new[] { new { role = "user", content = "wait" } },
                }),
            };
            send.Headers.Add("X-Gateway-Key", GatewayKey);
            send.Headers.Add("X-Request-Id", "cancel-openai-compatible");
            send.Headers.Add("X-Gateway-App-Caller", AppCallerRegistry.PageAgent.Generate);
            var pending = client.SendAsync(send);
            await gateway.Started.Task.WaitAsync(TimeSpan.FromSeconds(2));

            var cancel = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/requests/cancel-openai-compatible/cancel");
            cancel.Headers.Add("X-Gateway-Key", GatewayKey);
            cancel.Headers.Add("X-Gateway-App-Caller", AppCallerRegistry.PageAgent.Generate);
            var cancelResponse = await client.SendAsync(cancel);
            var sendResponse = await pending;

            cancelResponse.StatusCode.ShouldBe(HttpStatusCode.Accepted);
            sendResponse.StatusCode.ShouldBe(HttpStatusCode.Conflict);
            gateway.Cancelled.Task.IsCompleted.ShouldBeTrue();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiCompatibleEndpoint_AcceptsBearerGatewayKey()
    {
        await using var app = BuildHostWithGateway(new EchoingGateway());
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/chat/completions")
            {
                Content = JsonContent.Create(new
                {
                    model = "sidecar-picked",
                    messages = new[] { new { role = "user", content = "hi" } },
                    stream = false,
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            body.ShouldContain("\"model\":\"sidecar-picked\"");
            body.ShouldContain("\"content\":\"sent:sidecar-picked\"");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiCompatibleEndpoint_PreservesLogprobsExtension()
    {
        await using var app = BuildHostWithGateway(new EchoingGateway());
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/chat/completions")
            {
                Content = JsonContent.Create(new
                {
                    model = "sidecar-picked",
                    messages = new[] { new { role = "user", content = "hi" } },
                    logprobs = true,
                    top_logprobs = 1,
                    stream = false,
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            using var doc = JsonDocument.Parse(body);
            var logprobs = doc.RootElement
                .GetProperty("choices")[0]
                .GetProperty("logprobs");
            logprobs.GetProperty("content")[0].GetProperty("token").GetString().ShouldBe("sent");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiCompatibleEndpoint_PreservesPoolModelPolicy()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/chat/completions")
            {
                Content = JsonContent.Create(new
                {
                    model = "premium-chat-pool",
                    messages = new[] { new { role = "user", content = "hi" } },
                    provider = new { model_policy = "pool", model_pool_id = "pool-chat-premium" },
                    stream = false,
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ExpectedModel.ShouldBe("pool-chat-premium");
            gateway.LastRequest.Context.ShouldNotBeNull();
            gateway.LastRequest.Context!.ModelPolicy.ShouldBe("pool");
            gateway.LastRequest.Context.ModelPoolId.ShouldBe("pool-chat-premium");
            AssertRoutingContext(gateway.LastRequest.Context, "openai-compatible", "pool", "pool-chat-premium");
            var upstreamBody = gateway.LastRequest.RequestBody!.ToJsonString();
            upstreamBody.ShouldNotContain("model_policy");
            upstreamBody.ShouldNotContain("model_pool_id");
            upstreamBody.ShouldContain("messages");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiCompatibleEndpoint_PreservesPinnedTargetHeaders()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/chat/completions")
            {
                Content = JsonContent.Create(new
                {
                    messages = new[] { new { role = "user", content = "hi" } },
                    stream = false,
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);
            req.Headers.Add("X-Gateway-Pinned-Platform-Id", "plat-openrouter");
            req.Headers.Add("X-Gateway-Pinned-Model-Id", "anthropic/claude-sonnet-4");

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ExpectedModel.ShouldBeNull();
            gateway.LastRequest.PinnedPlatformId.ShouldBe("plat-openrouter");
            gateway.LastRequest.PinnedModelId.ShouldBe("anthropic/claude-sonnet-4");
            gateway.LastRequest.Context.ShouldNotBeNull();
            gateway.LastRequest.Context!.ModelPolicy.ShouldBe("pinned");
            AssertRoutingContext(gateway.LastRequest.Context, "openai-compatible", "pinned");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task GwNativeInvoke_PreservesExplicitPoolModelPolicy()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/invoke")
            {
                Content = JsonContent.Create(new
                {
                    AppCallerCode = "demo.app::chat",
                    ModelType = "chat",
                    ExpectedModel = "native-chat-pool",
                    RequestBody = new { messages = new[] { new { role = "user", content = "hi" } } },
                    Context = new { ModelPolicy = "pool", ModelPoolId = "pool-native-chat", RequestId = "native-invoke-pool-test" },
                }),
            };
            req.Headers.Add("X-Gateway-Key", GatewayKey);

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ExpectedModel.ShouldBe("pool-native-chat");
            gateway.LastRequest.Context.ShouldNotBeNull();
            gateway.LastRequest.Context!.IngressProtocol.ShouldBe("gw-native");
            gateway.LastRequest.Context.ModelPolicy.ShouldBe("pool");
            gateway.LastRequest.Context.ModelPoolId.ShouldBe("pool-native-chat");
            AssertRoutingContext(gateway.LastRequest.Context, "gw-native", "pool", "pool-native-chat", sourceSystem: "map");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task GwNativeSend_PreservesExplicitPoolModelPolicy()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/send")
            {
                Content = JsonContent.Create(new
                {
                    AppCallerCode = "demo.app::chat",
                    ModelType = "chat",
                    ExpectedModel = "native-chat-pool",
                    RequestBody = new { messages = new[] { new { role = "user", content = "hi" } } },
                    Context = new { ModelPolicy = "pool", ModelPoolId = "pool-native-chat", RequestId = "native-pool-test" },
                }),
            };
            req.Headers.Add("X-Gateway-Key", GatewayKey);

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ExpectedModel.ShouldBe("pool-native-chat");
            gateway.LastRequest.Context.ShouldNotBeNull();
            gateway.LastRequest.Context!.ModelPolicy.ShouldBe("pool");
            gateway.LastRequest.Context.ModelPoolId.ShouldBe("pool-native-chat");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task GwNativeRaw_PreservesExplicitPoolModelPolicy()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/raw")
            {
                Content = JsonContent.Create(new
                {
                    AppCallerCode = "demo.app::generation",
                    ModelType = "generation",
                    EndpointPath = "/v1/images/generations",
                    ExpectedModel = "native-image-default",
                    RequestBody = new { prompt = "draw" },
                    Context = new { ModelPolicy = "pool", ModelPoolId = "pool-native-image", RequestId = "native-raw-pool-test" },
                }),
            };
            req.Headers.Add("X-Gateway-Key", GatewayKey);

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRawRequest.ShouldNotBeNull();
            gateway.LastRawRequest.ExpectedModel.ShouldBe("pool-native-image");
            gateway.LastRawRequest.Context.ShouldNotBeNull();
            gateway.LastRawRequest.Context!.ModelPolicy.ShouldBe("pool");
            gateway.LastRawRequest.Context.ModelPoolId.ShouldBe("pool-native-image");
            gateway.LastResolveExpectedModel.ShouldBe("pool-native-image");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiResponsesCompatibleEndpoint_AcceptsBearerGatewayKey()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/responses")
            {
                Content = JsonContent.Create(new
                {
                    model = "responses-picked",
                    instructions = "Be brief.",
                    input = "hi",
                    max_output_tokens = 32,
                    parallel_tool_calls = true,
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            body.ShouldContain("\"model\":\"responses-picked\"");
            body.ShouldContain("\"output_text\":\"sent:responses-picked\"");
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ModelType.ShouldBe("chat");
            gateway.LastRequest.Context.ShouldNotBeNull();
            var dropped = gateway.LastRequest.Context!.DroppedParameters;
            dropped.ShouldNotBeNull();
            dropped!.ShouldNotContain("parallel_tool_calls");
            gateway.LastRequest.RequestBody!.ContainsKey("parallel_tool_calls").ShouldBeTrue();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiResponsesCompatibleEndpoint_StrictRequirePreservesParallelToolCalls()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/responses")
            {
                Content = JsonContent.Create(new
                {
                    model = "responses-picked",
                    input = "hi",
                    parallel_tool_calls = true,
                    provider = new { require_parameters = true },
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            body.ShouldContain("\"model\":\"responses-picked\"");
            gateway.LastRequest.ShouldNotBeNull();
            var droppedParameters = gateway.LastRequest.Context!.DroppedParameters;
            droppedParameters.ShouldNotBeNull();
            droppedParameters.ShouldNotContain("parallel_tool_calls");
            gateway.LastRequest.Context.ParameterPolicy.ShouldBe("strict-require");
            gateway.LastRequest.RequestBody!.ContainsKey("parallel_tool_calls").ShouldBeTrue();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiChatCompatibleEndpoint_StrictRequirePreservesParallelToolCalls()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/chat/completions")
            {
                Content = JsonContent.Create(new
                {
                    model = "chat-picked",
                    messages = new[] { new { role = "user", content = "hi" } },
                    parallel_tool_calls = true,
                    provider = new { require_parameters = true },
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            body.ShouldContain("\"model\":\"chat-picked\"");
            gateway.LastRequest.ShouldNotBeNull();
            var droppedParameters = gateway.LastRequest.Context!.DroppedParameters;
            droppedParameters.ShouldNotBeNull();
            droppedParameters.ShouldNotContain("parallel_tool_calls");
            gateway.LastRequest.RequestBody!.ContainsKey("parallel_tool_calls").ShouldBeTrue();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiResponsesCompatibleEndpoint_PreservesToolCalls()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/responses")
            {
                Content = JsonContent.Create(new
                {
                    model = "responses-tool-picked",
                    input = "check weather",
                    tools = new[]
                    {
                        new
                        {
                            type = "function",
                            function = new
                            {
                                name = "get_weather",
                                parameters = new { type = "object" },
                            },
                        },
                    },
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            using var doc = JsonDocument.Parse(body);
            var output = doc.RootElement.GetProperty("output");
            var functionCall = output.EnumerateArray()
                .First(x => x.GetProperty("type").GetString() == "function_call");
            functionCall.GetProperty("name").GetString().ShouldBe("get_weather");
            functionCall.GetProperty("arguments").GetString().ShouldBe("{\"city\":\"Shanghai\"}");
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.RequestBody.ShouldNotBeNull();
            gateway.LastRequest.RequestBody!.ContainsKey("tools").ShouldBeTrue();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiResponsesCompatibleEndpoint_WithImageInput_UsesVisionRequestType()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/responses")
            {
                Content = JsonContent.Create(new
                {
                    model = "responses-vision-picked",
                    input = new[]
                    {
                        new
                        {
                            role = "user",
                            content = new object[]
                            {
                                new { type = "input_text", text = "describe this image" },
                                new { type = "input_image", image_url = "data:image/png;base64,AAAA", detail = "high" },
                            },
                        },
                    },
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            body.ShouldContain("\"model\":\"responses-vision-picked\"");
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ModelType.ShouldBe("vision");
            gateway.LastRequest.AppCallerCode.ShouldBe("open-api.proxy::vision");
            gateway.LastRequest.RequestBody.ShouldNotBeNull();
            var requestBody = gateway.LastRequest.RequestBody!.ToJsonString();
            requestBody.ShouldContain("\"type\":\"image_url\"");
            requestBody.ShouldContain("data:image/png;base64,AAAA");
            requestBody.ShouldContain("\"detail\":\"high\"");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiResponsesCompatibleEndpoint_StreamsToolCallEvents()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/responses")
            {
                Content = JsonContent.Create(new
                {
                    model = "responses-stream-tool-picked",
                    input = "check weather",
                    stream = true,
                    tools = new[]
                    {
                        new
                        {
                            type = "function",
                            function = new
                            {
                                name = "get_weather",
                                parameters = new { type = "object" },
                            },
                        },
                    },
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            body.ShouldContain("event: response.output_item.added");
            body.ShouldContain("event: response.function_call_arguments.delta");
            body.ShouldContain("event: response.function_call_arguments.done");
            body.ShouldContain("event: response.output_item.done");
            body.ShouldContain("\"name\":\"get_weather\"");
            var deltaLine = body.Split('\n')
                .First(line => line.StartsWith("data: ", StringComparison.Ordinal)
                               && line.Contains("\"response.function_call_arguments.delta\"", StringComparison.Ordinal));
            using var deltaDoc = JsonDocument.Parse(deltaLine["data: ".Length..]);
            deltaDoc.RootElement.GetProperty("delta").GetString().ShouldBe("{\"city\":\"Shanghai\"}");
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.Stream.ShouldBeTrue();
            gateway.LastRequest.RequestBody.ShouldNotBeNull();
            gateway.LastRequest.RequestBody!.ContainsKey("tools").ShouldBeTrue();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiImagesCompatibleEndpoint_AcceptsBearerGatewayKey()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/images/generations")
            {
                Content = JsonContent.Create(new
                {
                    model = "image-picked",
                    prompt = "a clean product diagram",
                    size = "1024x1024",
                    background = "transparent",
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            body.ShouldContain("\"model\":\"image-picked\"");
            body.ShouldContain("\"endpoint\":\"/v1/images/generations\"");
            gateway.LastRawRequest.ShouldNotBeNull();
            gateway.LastRawRequest.ModelType.ShouldBe("generation");
            gateway.LastRawRequest.ExpectedModel.ShouldBe("image-picked");
            gateway.LastRawRequest.Context.ShouldNotBeNull();
            var dropped = gateway.LastRawRequest.Context!.DroppedParameters;
            dropped.ShouldNotBeNull();
            dropped!.ShouldContain("background");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiImagesCompatibleEndpoint_PreservesPinnedTargetProviderMetadata()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/images/generations")
            {
                Content = JsonContent.Create(new
                {
                    prompt = "a clean product render",
                    provider = new
                    {
                        model_policy = "pinned",
                        pinned_platform_id = "plat-image",
                        pinned_model_id = "openai/gpt-image-1",
                    },
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRawRequest.ShouldNotBeNull();
            gateway.LastRawRequest.PinnedPlatformId.ShouldBe("plat-image");
            gateway.LastRawRequest.PinnedModelId.ShouldBe("openai/gpt-image-1");
            gateway.LastRawRequest.Context.ShouldNotBeNull();
            gateway.LastRawRequest.Context!.ModelPolicy.ShouldBe("pinned");
            gateway.LastResolvePinnedPlatformId.ShouldBe("plat-image");
            gateway.LastResolvePinnedModelId.ShouldBe("openai/gpt-image-1");
            var upstreamBody = gateway.LastRawRequest.RequestBody!.ToJsonString();
            upstreamBody.ShouldNotContain("model_policy");
            upstreamBody.ShouldNotContain("pinned_platform_id");
            upstreamBody.ShouldNotContain("pinned_model_id");
            upstreamBody.ShouldContain("prompt");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiImageEditsCompatibleEndpoint_AcceptsBearerGatewayKey()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            using var content = new MultipartFormDataContent();
            content.Add(new StringContent("image-edit-picked"), "model");
            content.Add(new StringContent("replace the logo with clean text"), "prompt");
            content.Add(new StringContent("1024x1024"), "size");
            content.Add(new StringContent("ignored"), "background");
            var imageBytes = new ByteArrayContent(new byte[] { 1, 2, 3, 4 });
            imageBytes.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
            content.Add(imageBytes, "image", "input.png");
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/images/edits")
            {
                Content = content,
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            body.ShouldContain("\"model\":\"image-edit-picked\"");
            body.ShouldContain("\"endpoint\":\"/v1/images/edits\"");
            gateway.LastRawRequest.ShouldNotBeNull();
            gateway.LastRawRequest.ModelType.ShouldBe("generation");
            gateway.LastRawRequest.ExpectedModel.ShouldBe("image-edit-picked");
            gateway.LastRawRequest.IsMultipart.ShouldBeTrue();
            gateway.LastRawRequest.MultipartFields.ShouldNotBeNull();
            gateway.LastRawRequest.MultipartFields!["prompt"].ShouldBe("replace the logo with clean text");
            gateway.LastRawRequest.MultipartFiles.ShouldNotBeNull();
            gateway.LastRawRequest.MultipartFiles!.ShouldContainKey("image");
            gateway.LastRawRequest.MultipartFiles["image"].MimeType.ShouldBe("image/png");
            gateway.LastRawRequest.Context.ShouldNotBeNull();
            var dropped = gateway.LastRawRequest.Context!.DroppedParameters;
            dropped.ShouldNotBeNull();
            dropped!.ShouldContain("background");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiImageEditsCompatibleEndpoint_PreservesPinnedTargetMultipartFields()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            using var content = new MultipartFormDataContent();
            content.Add(new StringContent("replace the background"), "prompt");
            content.Add(new StringContent("pinned"), "model_policy");
            content.Add(new StringContent("plat-image-edit"), "pinned_platform_id");
            content.Add(new StringContent("openai/gpt-image-edit"), "pinned_model_id");
            var imageBytes = new ByteArrayContent(new byte[] { 9, 8, 7, 6 });
            imageBytes.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
            content.Add(imageBytes, "image", "input.png");
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/images/edits")
            {
                Content = content,
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRawRequest.ShouldNotBeNull();
            gateway.LastRawRequest.PinnedPlatformId.ShouldBe("plat-image-edit");
            gateway.LastRawRequest.PinnedModelId.ShouldBe("openai/gpt-image-edit");
            gateway.LastRawRequest.Context.ShouldNotBeNull();
            gateway.LastRawRequest.Context!.ModelPolicy.ShouldBe("pinned");
            gateway.LastResolvePinnedPlatformId.ShouldBe("plat-image-edit");
            gateway.LastResolvePinnedModelId.ShouldBe("openai/gpt-image-edit");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task OpenAiImageEditsCompatibleEndpoint_PreservesMultiImageArrayFields()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            using var content = new MultipartFormDataContent();
            content.Add(new StringContent("combine both references"), "prompt");
            var firstImage = new ByteArrayContent(new byte[] { 1, 1, 1 });
            firstImage.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
            var secondImage = new ByteArrayContent(new byte[] { 2, 2, 2 });
            secondImage.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/jpeg");
            content.Add(firstImage, "image[]", "first.png");
            content.Add(secondImage, "image[]", "second.jpg");
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/images/edits")
            {
                Content = content,
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRawRequest.ShouldNotBeNull();
            gateway.LastRawRequest.MultipartFiles.ShouldNotBeNull();
            gateway.LastRawRequest.MultipartFiles!.ShouldContainKey("image[0]");
            gateway.LastRawRequest.MultipartFiles.ShouldContainKey("image[1]");
            gateway.LastRawRequest.MultipartFiles["image[0]"].MimeType.ShouldBe("image/png");
            gateway.LastRawRequest.MultipartFiles["image[1]"].MimeType.ShouldBe("image/jpeg");
            var dropped = gateway.LastRawRequest.Context!.DroppedParameters;
            dropped.ShouldNotBeNull();
            dropped!.ShouldNotContain("image[]");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task ClaudeCompatibleEndpoint_AcceptsBearerGatewayKey()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/messages")
            {
                Content = JsonContent.Create(new
                {
                    model = "claude-picked",
                    max_tokens = 32,
                    messages = new[] { new { role = "user", content = "hi" } },
                    metadata = new { trace = "drop-me" },
                    stream = false,
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            body.ShouldContain("\"model\":\"claude-picked\"");
            body.ShouldContain("\"text\":\"sent:claude-picked\"");
            body.ShouldContain("\"type\":\"message\"");
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.Context.ShouldNotBeNull();
            var dropped = gateway.LastRequest.Context.DroppedParameters;
            dropped.ShouldNotBeNull();
            dropped!.ShouldContain("metadata");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task ClaudeCompatibleEndpoint_PreservesPinnedTargetHeaders()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/messages")
            {
                Content = JsonContent.Create(new
                {
                    max_tokens = 32,
                    messages = new[] { new { role = "user", content = "hi" } },
                    stream = false,
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);
            req.Headers.Add("X-Gateway-Pinned-Platform-Id", "plat-anthropic");
            req.Headers.Add("X-Gateway-Pinned-Model-Id", "claude-3-7-sonnet-latest");

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ExpectedModel.ShouldBeNull();
            gateway.LastRequest.PinnedPlatformId.ShouldBe("plat-anthropic");
            gateway.LastRequest.PinnedModelId.ShouldBe("claude-3-7-sonnet-latest");
            gateway.LastRequest.Context.ShouldNotBeNull();
            gateway.LastRequest.Context!.ModelPolicy.ShouldBe("pinned");
            AssertRoutingContext(gateway.LastRequest.Context, "claude-compatible", "pinned");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task ClaudeCompatibleEndpoint_PreservesPoolModelPolicyHeader()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/messages")
            {
                Content = JsonContent.Create(new
                {
                    model = "claude-quality-pool",
                    max_tokens = 32,
                    messages = new[] { new { role = "user", content = "hi" } },
                    stream = false,
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);
            req.Headers.Add("X-Gateway-Model-Policy", "pool");
            req.Headers.Add("X-Gateway-Model-Pool-Id", "pool-claude-quality");

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ExpectedModel.ShouldBe("pool-claude-quality");
            gateway.LastRequest.Context.ShouldNotBeNull();
            gateway.LastRequest.Context!.ModelPolicy.ShouldBe("pool");
            gateway.LastRequest.Context.ModelPoolId.ShouldBe("pool-claude-quality");
            AssertRoutingContext(gateway.LastRequest.Context, "claude-compatible", "pool", "pool-claude-quality");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task ClaudeCompatibleEndpoint_WithImageBlock_UsesVisionRequestType()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var payload = new JsonObject
            {
                ["model"] = "claude-vision-picked",
                ["max_tokens"] = 32,
                ["messages"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["content"] = new JsonArray
                        {
                            new JsonObject
                            {
                                ["type"] = "text",
                                ["text"] = "describe this image",
                            },
                            new JsonObject
                            {
                                ["type"] = "image",
                                ["source"] = new JsonObject
                                {
                                    ["type"] = "base64",
                                    ["media_type"] = "image/png",
                                    ["data"] = "AAAA",
                                },
                            },
                        },
                    },
                },
            };
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/messages")
            {
                Content = JsonContent.Create(payload),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ModelType.ShouldBe("vision");
            gateway.LastRequest.AppCallerCode.ShouldBe("open-api.proxy::vision");
            gateway.LastRequest.RequestBody.ShouldNotBeNull();
            var body = gateway.LastRequest.RequestBody!.ToJsonString();
            body.ShouldContain("\"type\":\"image_url\"");
            body.ShouldContain("data:image/png;base64,AAAA");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task ClaudeCompatibleEndpoint_WithImageUrlSource_UsesVisionRequestType()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var payload = new JsonObject
            {
                ["model"] = "claude-vision-url-picked",
                ["max_tokens"] = 32,
                ["messages"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["content"] = new JsonArray
                        {
                            new JsonObject { ["type"] = "text", ["text"] = "describe this image" },
                            new JsonObject
                            {
                                ["type"] = "image",
                                ["source"] = new JsonObject
                                {
                                    ["type"] = "url",
                                    ["url"] = "https://cdn.example.com/ref.png",
                                },
                            },
                        },
                    },
                },
            };
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/messages")
            {
                Content = JsonContent.Create(payload),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ModelType.ShouldBe("vision");
            gateway.LastRequest.AppCallerCode.ShouldBe("open-api.proxy::vision");
            gateway.LastRequest.RequestBody.ShouldNotBeNull();
            var body = gateway.LastRequest.RequestBody!.ToJsonString();
            body.ShouldContain("\"type\":\"image_url\"");
            body.ShouldContain("https://cdn.example.com/ref.png");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task ClaudeCompatibleEndpoint_PreservesToolUse()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/messages")
            {
                Content = JsonContent.Create(new
                {
                    model = "claude-tool-picked",
                    max_tokens = 32,
                    messages = new[] { new { role = "user", content = "check weather" } },
                    tools = new[]
                    {
                        new
                        {
                            name = "get_weather",
                            input_schema = new { type = "object" },
                        },
                    },
                    stream = false,
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            using var doc = JsonDocument.Parse(body);
            var content = doc.RootElement.GetProperty("content");
            var toolUse = content.EnumerateArray()
                .First(x => x.GetProperty("type").GetString() == "tool_use");
            toolUse.GetProperty("name").GetString().ShouldBe("get_weather");
            toolUse.GetProperty("input").GetProperty("city").GetString().ShouldBe("Shanghai");
            doc.RootElement.GetProperty("stop_reason").GetString().ShouldBe("tool_use");
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.RequestBody.ShouldNotBeNull();
            gateway.LastRequest.RequestBody!.ContainsKey("tools").ShouldBeTrue();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task ClaudeCompatibleEndpoint_StreamsToolUseEvents()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1/messages")
            {
                Content = JsonContent.Create(new
                {
                    model = "claude-stream-tool-picked",
                    max_tokens = 32,
                    messages = new[] { new { role = "user", content = "check weather" } },
                    tools = new[]
                    {
                        new
                        {
                            name = "get_weather",
                            input_schema = new { type = "object" },
                        },
                    },
                    stream = true,
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            body.ShouldContain("event: content_block_start");
            body.ShouldContain("\"type\":\"tool_use\"");
            body.ShouldContain("\"name\":\"get_weather\"");
            body.ShouldContain("event: content_block_delta");
            body.ShouldContain("\"type\":\"input_json_delta\"");
            var deltaLine = body.Split('\n')
                .First(line => line.StartsWith("data: ", StringComparison.Ordinal)
                               && line.Contains("\"input_json_delta\"", StringComparison.Ordinal));
            using var deltaDoc = JsonDocument.Parse(deltaLine["data: ".Length..]);
            deltaDoc.RootElement
                .GetProperty("delta")
                .GetProperty("partial_json")
                .GetString()
                .ShouldBe("{\"city\":\"Shanghai\"}");
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.Stream.ShouldBeTrue();
            gateway.LastRequest.RequestBody.ShouldNotBeNull();
            gateway.LastRequest.RequestBody!.ContainsKey("tools").ShouldBeTrue();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task GeminiCompatibleEndpoint_AcceptsBearerGatewayKey()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1beta/models/gemini-picked:generateContent")
            {
                Content = JsonContent.Create(new
                {
                    contents = new[] { new { role = "user", parts = new[] { new { text = "hi" } } } },
                    generationConfig = new { maxOutputTokens = 32 },
                    safetySettings = new[] { new { category = "x", threshold = "y" } },
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            body.ShouldContain("\"modelVersion\":\"gemini-picked\"");
            body.ShouldContain("\"text\":\"sent:gemini-picked\"");
            body.ShouldContain("\"usageMetadata\"");
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.Context.ShouldNotBeNull();
            var dropped = gateway.LastRequest.Context.DroppedParameters;
            dropped.ShouldNotBeNull();
            dropped!.ShouldContain("safetySettings");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task GeminiCompatibleEndpoint_WithInlineImage_UsesVisionRequestType()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var payload = new JsonObject
            {
                ["contents"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray
                        {
                            new JsonObject { ["text"] = "describe this image" },
                            new JsonObject
                            {
                                ["inlineData"] = new JsonObject
                                {
                                    ["mimeType"] = "image/jpeg",
                                    ["data"] = "BBBB",
                                },
                            },
                        },
                    },
                },
            };
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1beta/models/gemini-vision-picked:generateContent")
            {
                Content = JsonContent.Create(payload),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ModelType.ShouldBe("vision");
            gateway.LastRequest.AppCallerCode.ShouldBe("open-api.proxy::vision");
            gateway.LastRequest.RequestBody.ShouldNotBeNull();
            var body = gateway.LastRequest.RequestBody!.ToJsonString();
            body.ShouldContain("\"type\":\"image_url\"");
            body.ShouldContain("data:image/jpeg;base64,BBBB");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task GeminiCompatibleEndpoint_WithImageFileData_UsesVisionRequestType()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var payload = new JsonObject
            {
                ["contents"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray
                        {
                            new JsonObject { ["text"] = "describe this image" },
                            new JsonObject
                            {
                                ["fileData"] = new JsonObject
                                {
                                    ["mimeType"] = "image/png",
                                    ["fileUri"] = "https://cdn.example.com/gemini-ref.png",
                                },
                            },
                        },
                    },
                },
            };
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1beta/models/gemini-filedata-picked:generateContent")
            {
                Content = JsonContent.Create(payload),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ModelType.ShouldBe("vision");
            gateway.LastRequest.AppCallerCode.ShouldBe("open-api.proxy::vision");
            gateway.LastRequest.RequestBody.ShouldNotBeNull();
            var body = gateway.LastRequest.RequestBody!.ToJsonString();
            body.ShouldContain("\"type\":\"image_url\"");
            body.ShouldContain("https://cdn.example.com/gemini-ref.png");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task GeminiCompatibleEndpoint_PreservesPoolModelPolicyHeader()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1beta/models/gemini-quality-pool:generateContent")
            {
                Content = JsonContent.Create(new
                {
                    contents = new[] { new { role = "user", parts = new[] { new { text = "hi" } } } },
                    generationConfig = new { maxOutputTokens = 32 },
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);
            req.Headers.Add("X-Gateway-Model-Policy", "pool");
            req.Headers.Add("X-Gateway-Model-Pool-Id", "pool-gemini-quality");

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ExpectedModel.ShouldBe("pool-gemini-quality");
            gateway.LastRequest.Context.ShouldNotBeNull();
            gateway.LastRequest.Context!.ModelPolicy.ShouldBe("pool");
            gateway.LastRequest.Context.ModelPoolId.ShouldBe("pool-gemini-quality");
            AssertRoutingContext(gateway.LastRequest.Context, "gemini-compatible", "pool", "pool-gemini-quality");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task GeminiCompatibleEndpoint_PreservesPinnedTargetProviderMetadata()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1beta/models/gemini-2.5-pro:generateContent")
            {
                Content = JsonContent.Create(new
                {
                    contents = new[] { new { role = "user", parts = new[] { new { text = "hi" } } } },
                    provider = new
                    {
                        model_policy = "pinned",
                        pinned_platform_id = "plat-google",
                        pinned_model_id = "gemini-2.5-pro",
                    },
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.ExpectedModel.ShouldBe("gemini-2.5-pro");
            gateway.LastRequest.PinnedPlatformId.ShouldBe("plat-google");
            gateway.LastRequest.PinnedModelId.ShouldBe("gemini-2.5-pro");
            gateway.LastRequest.Context.ShouldNotBeNull();
            gateway.LastRequest.Context!.ModelPolicy.ShouldBe("pinned");
            AssertRoutingContext(gateway.LastRequest.Context, "gemini-compatible", "pinned");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task GeminiCompatibleEndpoint_PreservesFunctionDeclarationsAndFunctionCalls()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1beta/models/gemini-picked:generateContent")
            {
                Content = JsonContent.Create(new
                {
                    contents = new[] { new { role = "user", parts = new[] { new { text = "weather" } } } },
                    tools = new[]
                    {
                        new
                        {
                            functionDeclarations = new[]
                            {
                                new
                                {
                                    name = "get_weather",
                                    description = "查询天气",
                                    parameters = new
                                    {
                                        type = "object",
                                        properties = new
                                        {
                                            city = new { type = "string" },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    toolConfig = new
                    {
                        functionCallingConfig = new
                        {
                            mode = "ANY",
                            allowedFunctionNames = new[] { "get_weather" },
                        },
                    },
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            using var doc = JsonDocument.Parse(body);
            var part = doc.RootElement
                .GetProperty("candidates")[0]
                .GetProperty("content")
                .GetProperty("parts")[0];
            part.GetProperty("functionCall").GetProperty("name").GetString().ShouldBe("get_weather");
            part.GetProperty("functionCall").GetProperty("args").GetProperty("city").GetString().ShouldBe("Shanghai");
            doc.RootElement.GetProperty("candidates")[0].GetProperty("finishReason").GetString().ShouldBe("FUNCTION_CALL");

            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.RequestBody.ShouldNotBeNull();
            var tools = gateway.LastRequest.RequestBody!["tools"] as JsonArray;
            tools.ShouldNotBeNull();
            tools!.Count.ShouldBe(1);
            var tool = tools[0]!.AsObject();
            tool["type"]!.GetValue<string>().ShouldBe("function");
            tool["function"]!.AsObject()["name"]!.GetValue<string>().ShouldBe("get_weather");
            gateway.LastRequest.RequestBody!["tool_choice"].ShouldNotBeNull();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task GeminiCompatibleEndpoint_PreservesFunctionResponsesAsToolMessages()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1beta/models/gemini-picked:generateContent")
            {
                Content = JsonContent.Create(new
                {
                    contents = new[]
                    {
                        new
                        {
                            role = "function",
                            parts = new[]
                            {
                                new
                                {
                                    functionResponse = new
                                    {
                                        name = "get_weather",
                                        response = new { city = "Shanghai", result = "sunny" },
                                    },
                                },
                            },
                        },
                    },
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.RequestBody.ShouldNotBeNull();
            var messages = gateway.LastRequest.RequestBody!["messages"]!.AsArray();
            messages.Count.ShouldBe(1);
            var toolMessage = messages[0]!.AsObject();
            toolMessage["role"]!.GetValue<string>().ShouldBe("tool");
            toolMessage["tool_call_id"]!.GetValue<string>().ShouldBe("gemini-call-get_weather");
            toolMessage["name"]!.GetValue<string>().ShouldBe("get_weather");
            using var content = JsonDocument.Parse(toolMessage["content"]!.GetValue<string>());
            content.RootElement.GetProperty("city").GetString().ShouldBe("Shanghai");
            content.RootElement.GetProperty("result").GetString().ShouldBe("sunny");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task GeminiCompatibleEndpoint_StreamsTextAndFunctionCalls()
    {
        var gateway = new EchoingGateway();
        await using var app = BuildHostWithGateway(gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Post, "/v1beta/models/gemini-picked:streamGenerateContent")
            {
                Content = JsonContent.Create(new
                {
                    contents = new[] { new { role = "user", parts = new[] { new { text = "weather" } } } },
                    tools = new[]
                    {
                        new
                        {
                            functionDeclarations = new[]
                            {
                                new { name = "get_weather", parameters = new { type = "object" } },
                            },
                        },
                    },
                }),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            body.ShouldContain("data: ");
            body.ShouldContain("\"functionCall\"");
            body.ShouldContain("\"name\":\"get_weather\"");
            body.ShouldContain("\"city\":\"Shanghai\"");
            gateway.LastRequest.ShouldNotBeNull();
            gateway.LastRequest.Stream.ShouldBeTrue();
            gateway.LastRequest.RequestBody.ShouldNotBeNull();
            gateway.LastRequest.RequestBody!.ContainsKey("tools").ShouldBeTrue();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task Healthz_IsExemptFromKeyGate()
    {
        // healthz 是密钥门的显式豁免（存活探针），无 key 也应 200——反证密钥门是「白名单 healthz + 其余全拦」。
        await using var app = BuildHost();
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var resp = await client.GetAsync("/gw/v1/healthz");
            resp.StatusCode.ShouldBe(HttpStatusCode.OK, "healthz 应豁免密钥门");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task RouteSelfTest_IsProtectedDryRunAndCoversProtocolIngresses()
    {
        await using var app = BuildHost();
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var req = new HttpRequestMessage(HttpMethod.Get, "/gw/v1/route-self-test");
            req.Headers.Add("X-Gateway-Key", GatewayKey);

            var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();

            resp.StatusCode.ShouldBe(HttpStatusCode.OK);
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            root.GetProperty("Status").GetString().ShouldBe("ok");
            root.GetProperty("Mode").GetString().ShouldBe("dry-run");
            root.GetProperty("UpstreamCalled").GetBoolean().ShouldBeFalse();
            root.GetProperty("Total").GetInt32().ShouldBe(4);
            root.GetProperty("Passed").GetInt32().ShouldBe(4);

            var protocols = root.GetProperty("Cases").EnumerateArray()
                .Select(x => x.GetProperty("IngressProtocol").GetString())
                .ToHashSet();
            protocols.ShouldContain("gw-native");
            protocols.ShouldContain("openai-compatible");
            protocols.ShouldContain("claude-compatible");
            protocols.ShouldContain("gemini-compatible");

            var poolCases = root.GetProperty("Cases").EnumerateArray()
                .Where(x => x.GetProperty("ModelPolicy").GetString() == "pool")
                .ToList();
            poolCases.Count.ShouldBe(2);
            poolCases.All(x => string.Equals(
                x.GetProperty("ExpectedModel").GetString(),
                x.GetProperty("ModelPoolId").GetString(),
                StringComparison.Ordinal)).ShouldBeTrue();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    /// <summary>
    /// 上游 stub：任何方法被调用即抛。401 应在中间件层短路，永远到不了这里；
    /// 若哪个受保护端点在无 key 时仍触达 gateway，会抛出而不是静默 200，暴露密钥门漏洞。
    /// </summary>
    private sealed class ThrowingGateway : PrdAgent.Infrastructure.LlmGateway.ILlmGateway
    {
        private static InvalidOperationException Boom([CallerMemberName] string m = "")
            => new($"密钥门未短路：无授权请求触达了 gateway.{m}()");

        public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default) => throw Boom();

        public IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest request, CancellationToken ct = default) => throw Boom();

        public Task<GatewayRawResponse> SendRawWithResolutionAsync(GatewayRawRequest request, GatewayModelResolution resolution, CancellationToken ct = default) => throw Boom();

        public Task<GatewayModelResolution> ResolveModelAsync(string appCallerCode, string modelType, string? expectedModel = null, string? pinnedPlatformId = null, string? pinnedModelId = null, CancellationToken ct = default) => throw Boom();

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string appCallerCode, string modelType, CancellationToken ct = default) => throw Boom();

        public ILLMClient CreateClient(string appCallerCode, string modelType, int maxTokens = 4096, double temperature = 0.2, bool includeThinking = false, string? expectedModel = null, string? pinnedPlatformId = null, string? pinnedModelId = null) => throw Boom();
    }

    private static WebApplication BuildHostWithGateway(
        PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
        IGatewayServingReadinessProbe? readinessProbe = null)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseTestServer();
        builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = null);
        builder.Services.AddSingleton(gateway);
        builder.Services.AddSingleton<ILLMRequestContextAccessor, PrdAgent.Core.Services.LLMRequestContextAccessor>();
        builder.Services.AddSingleton<GatewayCancellationRegistry>();
        if (readinessProbe != null)
            builder.Services.AddSingleton(readinessProbe);

        var app = builder.Build();
        var pascalJson = new JsonSerializerOptions
        {
            PropertyNamingPolicy = null,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };
        app.MapGatewayServingEndpoints(pascalJson, GatewayKey, "keygate-contract-test");
        return app;
    }

    private sealed class StubReadinessProbe : IGatewayServingReadinessProbe
    {
        private readonly GatewayServingReadinessSnapshot _snapshot;

        public StubReadinessProbe(GatewayServingReadinessSnapshot snapshot) => _snapshot = snapshot;

        public Task<GatewayServingReadinessSnapshot> CheckAsync(CancellationToken cancellationToken)
            => Task.FromResult(_snapshot);
    }

    private sealed class CancellableGateway : PrdAgent.Infrastructure.LlmGateway.ILlmGateway
    {
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Cancelled { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
        {
            Started.TrySetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
                throw new InvalidOperationException("cancellable test request unexpectedly completed");
            }
            catch (OperationCanceledException)
            {
                Cancelled.TrySetResult();
                throw;
            }
        }

        public IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest request, CancellationToken ct = default)
            => throw new NotSupportedException();

        public Task<GatewayRawResponse> SendRawWithResolutionAsync(GatewayRawRequest request, GatewayModelResolution resolution, CancellationToken ct = default)
            => throw new NotSupportedException();

        public Task<GatewayModelResolution> ResolveModelAsync(string appCallerCode, string modelType, string? expectedModel = null, string? pinnedPlatformId = null, string? pinnedModelId = null, CancellationToken ct = default)
            => throw new NotSupportedException();

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string appCallerCode, string modelType, CancellationToken ct = default)
            => throw new NotSupportedException();

        public ILLMClient CreateClient(string appCallerCode, string modelType, int maxTokens = 4096, double temperature = 0.2, bool includeThinking = false, string? expectedModel = null, string? pinnedPlatformId = null, string? pinnedModelId = null)
            => throw new NotSupportedException();
    }

    private static void AssertRoutingContext(
        GatewayRequestContext? context,
        string ingressProtocol,
        string modelPolicy,
        string? modelPoolId = null,
        string parameterPolicy = "default-drop",
        string sourceSystem = "external")
    {
        context.ShouldNotBeNull();
        context!.SourceSystem.ShouldBe(sourceSystem);
        context.IngressProtocol.ShouldBe(ingressProtocol);
        context.GatewayTransport.ShouldBe(GatewayTransports.Http);
        context.ModelPolicy.ShouldBe(modelPolicy);
        context.ModelPoolId.ShouldBe(modelPoolId);
        context.ParameterPolicy.ShouldBe(parameterPolicy);
    }

    private sealed class EchoingGateway : PrdAgent.Infrastructure.LlmGateway.ILlmGateway
    {
        public GatewayRequest? LastRequest { get; private set; }
        public GatewayRawRequest? LastRawRequest { get; private set; }
        public string? LastResolveExpectedModel { get; private set; }
        public string? LastResolvePinnedPlatformId { get; private set; }
        public string? LastResolvePinnedModelId { get; private set; }

        private static GatewayModelResolution Resolve(string? expected) => new()
        {
            Success = true,
            ExpectedModel = expected,
            ActualModel = expected ?? "default-model",
            ActualPlatformId = "plat-1",
            Protocol = "openai",
            ResolutionType = expected != null ? "directModel" : "defaultPool",
        };

        public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
        {
            LastRequest = request;
            if (request.RequestBody?.ContainsKey("tools") == true)
            {
                return Task.FromResult(new GatewayResponse
                {
                    Success = true,
                    StatusCode = 200,
                    Content = string.Empty,
                    Resolution = Resolve(request.ExpectedModel),
                    ToolCalls = new JsonArray
                    {
                        new JsonObject
                        {
                            ["id"] = "call-weather-1",
                            ["type"] = "function",
                            ["function"] = new JsonObject
                            {
                                ["name"] = "get_weather",
                                ["arguments"] = "{\"city\":\"Shanghai\"}",
                            },
                        },
                    },
                });
            }
            if (request.RequestBody?["logprobs"]?.GetValue<bool>() == true)
            {
                return Task.FromResult(new GatewayResponse
                {
                    Success = true,
                    StatusCode = 200,
                    Content = $"sent:{request.ExpectedModel}",
                    Resolution = Resolve(request.ExpectedModel),
                    Extensions = new Dictionary<string, JsonNode?>
                    {
                        ["logprobs"] = new JsonObject
                        {
                            ["content"] = new JsonArray
                            {
                                new JsonObject
                                {
                                    ["token"] = "sent",
                                    ["logprob"] = -0.01,
                                },
                            },
                        },
                    },
                });
            }
            return Task.FromResult(GatewayResponse.Ok($"sent:{request.ExpectedModel}", Resolve(request.ExpectedModel)));
        }

        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
            GatewayRequest request,
            [EnumeratorCancellation] CancellationToken ct = default)
        {
            LastRequest = request;
            await Task.Yield();
            yield return GatewayStreamChunk.Start(Resolve(request.ExpectedModel));
            if (request.RequestBody?.ContainsKey("tools") == true)
            {
                yield return GatewayStreamChunk.ToolCallChunk(new JsonArray
                {
                    new JsonObject
                    {
                        ["index"] = 0,
                        ["id"] = "call-weather-1",
                        ["type"] = "function",
                        ["function"] = new JsonObject
                        {
                            ["name"] = "get_weather",
                            ["arguments"] = "{\"city\":\"Shanghai\"}",
                        },
                    },
                });
            }
            else
            {
                yield return GatewayStreamChunk.Text($"stream:{request.ExpectedModel}");
            }
            yield return GatewayStreamChunk.Done("stop", null);
        }

        public Task<GatewayRawResponse> SendRawWithResolutionAsync(GatewayRawRequest request, GatewayModelResolution resolution, CancellationToken ct = default)
        {
            LastRawRequest = request;
            return Task.FromResult(new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                ContentType = "application/json",
                Content = JsonSerializer.Serialize(new
                {
                    model = resolution.ActualModel,
                    endpoint = request.EndpointPath,
                    data = new[] { new { url = "https://example.test/generated.png" } },
                }),
                Resolution = resolution,
            });
        }

        public Task<GatewayModelResolution> ResolveModelAsync(string appCallerCode, string modelType, string? expectedModel = null, string? pinnedPlatformId = null, string? pinnedModelId = null, CancellationToken ct = default)
        {
            LastResolveExpectedModel = expectedModel;
            LastResolvePinnedPlatformId = pinnedPlatformId;
            LastResolvePinnedModelId = pinnedModelId;
            return Task.FromResult(Resolve(expectedModel));
        }

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string appCallerCode, string modelType, CancellationToken ct = default) => throw new NotSupportedException();

        public ILLMClient CreateClient(string appCallerCode, string modelType, int maxTokens = 4096, double temperature = 0.2, bool includeThinking = false, string? expectedModel = null, string? pinnedPlatformId = null, string? pinnedModelId = null) => throw new NotSupportedException();
    }
}
