using System.Net;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
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
        new object[] { HttpMethod.Post, "/gw/v1/send" },
        new object[] { HttpMethod.Post, "/gw/v1/resolve" },
        new object[] { HttpMethod.Post, "/gw/v1/raw" },
        new object[] { HttpMethod.Post, "/gw/v1/stream" },
        new object[] { HttpMethod.Post, "/gw/v1/client-stream" },
        new object[] { HttpMethod.Get, "/gw/v1/pools?appCallerCode=demo.app::chat&modelType=chat" },
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
}
