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
/// 跨进程 serving 网关「自测」——不依赖 CDS / Mongo / 真实大模型。
///
/// 起一个真实 Kestrel（loopback）host 住 serving 网关的真实端点映射（MapGatewayServingEndpoints，
/// SSOT 与生产 Program.cs 同一份），上游用 stub gateway 顶替，再用**真实的** HttpLlmGatewayClient
/// 经真实 HTTP/SSE 打过去，端到端验证「新增的 HTTP 边界」：序列化往返 / SSE 解析 /
/// 密钥门 / ApiKey 绝不过线。模型解析与真实上游发送是既有实现（inproc 已验、本轮未改），不在本测试范围。
///
/// 本测试**不打** Category=Integration/Manual，故 CI 默认 `dotnet test --filter Category!=Integration&Category!=Manual`
/// 会真正执行它（这是无本地 SDK 时唯一「真跑」的通道）。
/// </summary>
public class CrossProcessServingSelfTest
{
    private const string TestKey = "test-gateway-key";
    private const string SecretApiKey = "SECRET-must-not-cross-http";

    // 进程级共享 IHttpClientFactory：整个测试运行复用同一份，HttpMessageHandler 池永不被 GC 终结。
    // 历史 bug：每次 BuildClient new 一个抛弃式 ServiceProvider 且从不 dispose，其 handler 池被 GC
    // 终结后请求返回空/截断响应，导致 CI 随机 pass/fail。共享 static 工厂根除此 flake。
    private static readonly IHttpClientFactory SharedHttpFactory =
        new ServiceCollection().AddHttpClient().BuildServiceProvider().GetRequiredService<IHttpClientFactory>();

    private static readonly JsonSerializerOptions PascalJson = new()
    {
        PropertyNamingPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    [Fact]
    public async Task CrossProcessServing_FullContract_RoundTripsOverRealHttp()
    {
        // ── 起 serving host（真实 Kestrel + stub gateway）──
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        // 与生产一致：PascalCase 绑定，才能把客户端发来的 PascalCase body 正确反序列化。
        builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = null);
        builder.Services.AddSingleton<PrdAgent.Infrastructure.LlmGateway.ILlmGateway, FakeServingGateway>();
        builder.Services.AddSingleton<ILLMRequestContextAccessor, PrdAgent.Core.Services.LLMRequestContextAccessor>();

        await using var app = builder.Build();
        app.MapGatewayServingEndpoints(PascalJson, TestKey, "selftest-commit");
        await app.StartAsync();

        try
        {
            var baseUrl = ResolveBaseUrl(app);

            // 真实 HttpLlmGatewayClient（指向上面的 host，带正确密钥）。
            var client = BuildClient(baseUrl, TestKey);

            // 1) resolve：字段往返 + ApiKey 绝不过线（serving 端 [JsonIgnore] 已剥离）。
            var resolution = await client.ResolveModelAsync("demo.app::chat", "chat");
            resolution.Success.ShouldBeTrue();
            resolution.ActualModel.ShouldBe("m1");
            resolution.Protocol.ShouldBe("openai");
            resolution.ApiKey.ShouldBeNull("ApiKey 绝不能跨 HTTP 回传（[JsonIgnore]）");

            // 2) send：非流式往返。
            var send = await client.SendAsync(new GatewayRequest { AppCallerCode = "demo.app::chat", ModelType = "chat" });
            send.Success.ShouldBeTrue();
            send.Content.ShouldBe("hello");

            // 3) stream：SSE 逐块解析，类型序列 + Seq 递增 + 文本拼接。
            var chunks = new List<GatewayStreamChunk>();
            await foreach (var c in client.StreamAsync(new GatewayRequest { AppCallerCode = "demo.app::chat", ModelType = "chat" }))
                chunks.Add(c);
            chunks.Select(c => c.Type).ShouldBe(new[]
            {
                GatewayChunkType.Start, GatewayChunkType.Text, GatewayChunkType.Text, GatewayChunkType.Done,
            });
            chunks.Select(c => c.Seq).ShouldBe(new long[] { 1, 2, 3, 4 });
            string.Concat(chunks.Where(c => c.Type == GatewayChunkType.Text).Select(c => c.Content)).ShouldBe("hello");

            // 4) raw：服务端 resolve + 发送往返。
            var raw = await client.SendRawWithResolutionAsync(
                new GatewayRawRequest { AppCallerCode = "demo.app::generation", ModelType = "generation" },
                new GatewayModelResolution { Success = true });
            raw.Success.ShouldBeTrue();
            raw.Content.ShouldBe("raw-ok");

            // 5) pools：列表往返。
            var pools = await client.GetAvailablePoolsAsync("demo.app::chat", "chat");
            pools.Count.ShouldBe(1);
            pools[0].Id.ShouldBe("pool-1");

            // 6) CreateClient → ILLMClient 流式（/gw/v1/client-stream）。
            var llmClient = client.CreateClient("demo.app::chat", "chat");
            llmClient.Provider.ShouldBe("gateway-http");
            var msgs = new List<LLMMessage> { new() { Role = "user", Content = "hi" } };
            var llmChunks = new List<LLMStreamChunk>();
            await foreach (var c in llmClient.StreamGenerateAsync("sys", msgs, CancellationToken.None))
                llmChunks.Add(c);
            llmChunks.Select(c => c.Type).ShouldBe(new[] { "start", "delta", "delta", "done" });
            string.Concat(llmChunks.Where(c => c.Type == "delta").Select(c => c.Content)).ShouldBe("hi-there");

            // 7) 密钥门：错 key 的 client，send 应失败且 401。
            var badClient = BuildClient(baseUrl, "WRONG-KEY");
            var denied = await badClient.SendAsync(new GatewayRequest { AppCallerCode = "demo.app::chat", ModelType = "chat" });
            denied.Success.ShouldBeFalse();
            denied.StatusCode.ShouldBe(401);
        }
        finally
        {
            await app.StopAsync();
        }
    }

    private static string ResolveBaseUrl(WebApplication app)
    {
        var server = app.Services.GetRequiredService<IServer>();
        var addresses = server.Features.Get<IServerAddressesFeature>();
        var addr = addresses?.Addresses.FirstOrDefault();
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

    // ─── stub 上游：顶替真实 LlmGateway，专测 HTTP 边界 ───
    private sealed class FakeServingGateway : PrdAgent.Infrastructure.LlmGateway.ILlmGateway
    {
        private static GatewayModelResolution Res() => new()
        {
            Success = true,
            ActualModel = "m1",
            ActualPlatformId = "plat-1",
            Protocol = "openai",
            ResolutionType = "directModel",
            ApiKey = SecretApiKey, // 必须被 [JsonIgnore] 拦在服务端
        };

        public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
            => Task.FromResult(GatewayResponse.Ok("hello", Res()));

        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
            GatewayRequest request, [EnumeratorCancellation] CancellationToken ct = default)
        {
            await Task.Yield();
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Start, Seq = 1, Resolution = Res() };
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Text, Seq = 2, Content = "hel" };
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Text, Seq = 3, Content = "lo" };
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Done, Seq = 4, FinishReason = "stop" };
        }

        public Task<GatewayRawResponse> SendRawWithResolutionAsync(
            GatewayRawRequest request, GatewayModelResolution resolution, CancellationToken ct = default)
            => Task.FromResult(new GatewayRawResponse { Success = true, StatusCode = 200, Content = "raw-ok" });

        public Task<GatewayModelResolution> ResolveModelAsync(
            string appCallerCode, string modelType, string? expectedModel = null, CancellationToken ct = default)
            => Task.FromResult(Res());

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
            string appCallerCode, string modelType, CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool>
            {
                new() { Id = "pool-1", Name = "默认池", Code = "default", Priority = 1, ResolutionType = "defaultPool", Models = new() },
            });

        public ILLMClient CreateClient(
            string appCallerCode, string modelType, int maxTokens = 4096,
            double temperature = 0.2, bool includeThinking = false, string? expectedModel = null)
            => new FakeLlmClient();
    }

    private sealed class FakeLlmClient : ILLMClient
    {
        public string Provider => "fake";

        public IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
            string systemPrompt, List<LLMMessage> messages, CancellationToken cancellationToken = default)
            => StreamGenerateAsync(systemPrompt, messages, false, cancellationToken);

        public async IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
            string systemPrompt, List<LLMMessage> messages, bool enablePromptCache,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.Yield();
            yield return new LLMStreamChunk { Type = "start" };
            yield return new LLMStreamChunk { Type = "delta", Content = "hi-" };
            yield return new LLMStreamChunk { Type = "delta", Content = "there" };
            yield return new LLMStreamChunk { Type = "done", OutputTokens = 2 };
        }
    }
}
