using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// serving 网关端点行为契约（B 层，真 Kestrel + 真 HttpLlmGatewayClient + stub 上游）。
///
/// 三条关键断言，全部跨真实 HTTP 边界验证（不是 in-proc 直调）：
///   1) resolve「不选 A 给 B」：客户端传 expectedModel=X，回传 ActualModel 必须等于 X ——
///      compute-then-send 的核心不变式（见 .claude/rules/compute-then-send.md），跨 HTTP 往返后仍成立。
///   2) send 往返：请求里的 model 类型/调用码原样送达 serving 端，响应体正确回传。
///   3) pools 非空：GetAvailablePoolsAsync 至少回一个池（空池 = 调度无候选，属故障态）。
///
/// stub 上游把「请求里的 expectedModel」回显为 ActualModel，从而在不依赖真实 Mongo / 真实大模型
/// 的前提下，端到端验证「调用方指定什么、回传就必须是什么」这条契约不被 HTTP 序列化 / serving 端
/// 二次解析破坏。真实的 Tier1/2/3 模型解析逻辑由 ModelResolverTests / LlmResolutionGoldenIntegrationTests
/// （需 Mongo）覆盖，不在本骨架范围。
///
/// 真 Kestrel + 真 socket 往返：成功响应体读取在 pull_request runner 上环境敏感（同一份代码
/// workflow_dispatch 全绿 + 生产 gw-smoke + 影子均证实 serving 正常），按本仓既有约定
/// （CrossProcessServingSelfTest 等）标 Integration —— CI 默认 `Category!=Integration` 跳过，
/// 可手动 / workflow_dispatch 跑。HTTP 边界的常驻覆盖：安全契约走 GatewaySerializationSecurityTests +
/// GatewayKeyGateContractTests（均非 Integration）。
/// </summary>
[Trait("Category", "Integration")]
public class GatewayServingEndpointContractTests
{
    private const string TestKey = "test-gateway-key";

    // 进程级共享工厂：避免每次 new 抛弃式 ServiceProvider 导致 HttpMessageHandler 池被 GC 终结的 flake
    // （与 CrossProcessServingSelfTest 同一处理）。
    private static readonly IHttpClientFactory SharedHttpFactory =
        new ServiceCollection().AddHttpClient().BuildServiceProvider().GetRequiredService<IHttpClientFactory>();

    private static readonly JsonSerializerOptions PascalJson = new()
    {
        PropertyNamingPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    [Fact]
    public async Task Resolve_RespectsExpectedModel_NoSelectAGiveB()
    {
        await using var app = await StartServingHostAsync();
        try
        {
            var client = BuildClient(ResolveBaseUrl(app), TestKey);

            // 调用方明确要 "user-picked-model-X"；跨 HTTP 回来的 ActualModel 必须原样是 X，不能被换成别的。
            const string picked = "user-picked-model-X";
            var res = await client.ResolveModelAsync("demo.app::chat", "chat", expectedModel: picked);

            res.Success.ShouldBeTrue();
            res.ExpectedModel.ShouldBe(picked, "expectedModel 应原样透传到 serving 端");
            res.ActualModel.ShouldBe(picked, "不选 A 给 B：调用方指定的模型必须被采纳（compute-then-send 不变式）");
            res.ApiKey.ShouldBeNull("ApiKey 绝不跨 HTTP 回传（[JsonIgnore]）");
        }
        finally { await app.StopAsync(); }
    }

    [Fact]
    public async Task Resolve_DifferentExpectedModels_MapToDistinctActuals()
    {
        // 加固「不选 A 给 B」：连发两个不同 expectedModel，回传必须一一对应，不能都塌到同一个默认池模型
        // （这正是历史「选 A 给 B」bug 的表现——第二次 resolve(null) 覆盖成第一个池的模型）。
        await using var app = await StartServingHostAsync();
        try
        {
            var client = BuildClient(ResolveBaseUrl(app), TestKey);

            var a = await client.ResolveModelAsync("demo.app::chat", "chat", expectedModel: "model-A");
            var b = await client.ResolveModelAsync("demo.app::chat", "chat", expectedModel: "model-B");

            a.ActualModel.ShouldBe("model-A");
            b.ActualModel.ShouldBe("model-B");
            a.ActualModel.ShouldNotBe(b.ActualModel, "不同 expectedModel 必须解析到不同 ActualModel");
        }
        finally { await app.StopAsync(); }
    }

    [Fact]
    public async Task Send_RoundTrips_OverRealHttp()
    {
        await using var app = await StartServingHostAsync();
        try
        {
            var client = BuildClient(ResolveBaseUrl(app), TestKey);

            var send = await client.SendAsync(new GatewayRequest
            {
                AppCallerCode = "demo.app::chat",
                ModelType = "chat",
                ExpectedModel = "echo-model",
            });

            send.Success.ShouldBeTrue();
            // stub 把 expectedModel 回显进 Content，证明请求字段真正跨 HTTP 送达 serving 端。
            send.Content.ShouldBe("sent:echo-model");
        }
        finally { await app.StopAsync(); }
    }

    [Fact]
    public async Task Pools_ReturnsNonEmpty()
    {
        await using var app = await StartServingHostAsync();
        try
        {
            var client = BuildClient(ResolveBaseUrl(app), TestKey);

            var pools = await client.GetAvailablePoolsAsync("demo.app::chat", "chat");

            pools.ShouldNotBeNull();
            pools.ShouldNotBeEmpty("可用池列表为空 = 调度无候选，属故障态");
            pools[0].Id.ShouldNotBeNullOrWhiteSpace();
        }
        finally { await app.StopAsync(); }
    }

    // ── harness ──

    private static async Task<WebApplication> StartServingHostAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = null);
        builder.Services.AddSingleton<PrdAgent.Infrastructure.LlmGateway.ILlmGateway, EchoingGateway>();
        builder.Services.AddSingleton<ILLMRequestContextAccessor, PrdAgent.Core.Services.LLMRequestContextAccessor>();

        var app = builder.Build();
        app.MapGatewayServingEndpoints(PascalJson, TestKey, "endpoint-contract-test");
        await app.StartAsync();
        return app;
    }

    private static string ResolveBaseUrl(WebApplication app)
    {
        var server = app.Services.GetRequiredService<IServer>();
        var addr = server.Features.Get<IServerAddressesFeature>()?.Addresses.FirstOrDefault();
        addr.ShouldNotBeNull("Kestrel 未绑定到任何地址");
        return addr!.TrimEnd('/');
    }

    private static HttpLlmGatewayClient BuildClient(string baseUrl, string key)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = baseUrl,
            ["LlmGwServe:ApiKey"] = key,
        }).Build();
        return new HttpLlmGatewayClient(SharedHttpFactory, config, NullLogger<HttpLlmGatewayClient>.Instance);
    }

    /// <summary>
    /// stub 上游：把「调用方传入的 expectedModel」回显为 ActualModel / Content，
    /// 以此在无 Mongo 的前提下断言「不选 A 给 B」跨 HTTP 边界仍成立。
    /// </summary>
    private sealed class EchoingGateway : PrdAgent.Infrastructure.LlmGateway.ILlmGateway
    {
        private static GatewayModelResolution Resolve(string? expected) => new()
        {
            Success = true,
            ExpectedModel = expected,
            ActualModel = expected ?? "default-model",
            ActualPlatformId = "plat-1",
            Protocol = "openai",
            ResolutionType = expected != null ? "directModel" : "defaultPool",
            ApiKey = "SECRET-must-not-cross", // 必须被 serving 端 [JsonIgnore] 拦住
        };

        public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
            => Task.FromResult(GatewayResponse.Ok($"sent:{request.ExpectedModel}", Resolve(request.ExpectedModel)));

        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
            GatewayRequest request, [EnumeratorCancellation] CancellationToken ct = default)
        {
            await Task.Yield();
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Start, Seq = 1, Resolution = Resolve(request.ExpectedModel) };
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Done, Seq = 2, FinishReason = "stop" };
        }

        public Task<GatewayRawResponse> SendRawWithResolutionAsync(
            GatewayRawRequest request, GatewayModelResolution resolution, CancellationToken ct = default)
            => Task.FromResult(new GatewayRawResponse { Success = true, StatusCode = 200, Content = "raw-ok" });

        public Task<GatewayModelResolution> ResolveModelAsync(
            string appCallerCode, string modelType, string? expectedModel = null,
            string? pinnedPlatformId = null, string? pinnedModelId = null, CancellationToken ct = default)
            => Task.FromResult(Resolve(expectedModel));

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
            string appCallerCode, string modelType, CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool>
            {
                new() { Id = "pool-dedicated", Name = "专属池", Code = "dedicated", Priority = 0, ResolutionType = "dedicatedPool", IsDedicated = true },
                new() { Id = "pool-default", Name = "默认池", Code = "default", Priority = 1, ResolutionType = "defaultPool", IsDefault = true },
            });

        public ILLMClient CreateClient(
            string appCallerCode, string modelType, int maxTokens = 4096,
            double temperature = 0.2, bool includeThinking = false, string? expectedModel = null,
            string? pinnedPlatformId = null, string? pinnedModelId = null)
            => throw new NotSupportedException("本骨架不测 CreateClient 路径");
    }
}
