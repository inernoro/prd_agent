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
/// C 层补充：跨进程传输的 D11(上游中断→Fail) / D12(并发) / canary 探测有效性。
/// 真 Kestrel + 真 HttpLlmGatewayClient；stub gateway 控制成功/失败。
/// 对应 doc/spec.llm-gateway-test-matrix.md C 层。
/// </summary>
public class CrossProcessServingErrorLoadTests
{
    private const string TestKey = "test-gateway-key";

    private static readonly JsonSerializerOptions PascalJson = new()
    {
        PropertyNamingPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    // ── D11：上游返回失败 → 跨进程后 GatewayResponse.Success==false（canary：必败被抓）──
    [Fact]
    public async Task UpstreamFailure_ShouldSurfaceAsFailedResponse()
    {
        await using var host = await GatewayTestHost.StartAsync(new FailingGateway());
        var client = host.BuildClient(TestKey);

        var resp = await client.SendAsync(new GatewayRequest { AppCallerCode = "demo::chat", ModelType = "chat" });

        // canary 元断言：一个"一定会异常"的上游，用例必须把它判为失败（而不是误判成功）。
        resp.Success.ShouldBeFalse();
        resp.ErrorCode.ShouldNotBeNullOrEmpty();
    }

    // ── D11：上游抛异常 → 端点 500 → 客户端归一为失败（不崩）──
    [Fact]
    public async Task UpstreamThrows_ShouldSurfaceAsFailedResponseNotCrash()
    {
        await using var host = await GatewayTestHost.StartAsync(new ThrowingGateway());
        var client = host.BuildClient(TestKey);

        var resp = await client.SendAsync(new GatewayRequest { AppCallerCode = "demo::chat", ModelType = "chat" });

        resp.Success.ShouldBeFalse();
    }

    // ── D12：并发 N 请求，互不串扰，全部成功（每个回显自己的 appCallerCode）──
    [Fact]
    public async Task ConcurrentRequests_ShouldNotCrossTalk()
    {
        await using var host = await GatewayTestHost.StartAsync(new EchoGateway());
        var client = host.BuildClient(TestKey);

        const int n = 16;
        var tasks = Enumerable.Range(0, n).Select(async i =>
        {
            var resp = await client.SendAsync(new GatewayRequest { AppCallerCode = $"demo::chat#{i}", ModelType = "chat" });
            return (i, resp);
        }).ToArray();

        var results = await Task.WhenAll(tasks);
        foreach (var (i, resp) in results)
        {
            resp.Success.ShouldBeTrue();
            // EchoGateway 把 appCallerCode 回显到 Content；断言每个并发请求拿到的是自己的，没串号。
            resp.Content.ShouldBe($"demo::chat#{i}");
        }
    }

    // ── canary：错 key → 401（密钥门有效）──
    [Fact]
    public async Task WrongGatewayKey_ShouldReturn401()
    {
        await using var host = await GatewayTestHost.StartAsync(new EchoGateway());
        var client = host.BuildClient("WRONG-KEY");

        var resp = await client.SendAsync(new GatewayRequest { AppCallerCode = "demo::chat", ModelType = "chat" });

        resp.Success.ShouldBeFalse();
        resp.StatusCode.ShouldBe(401);
    }

    // ─────────────────────── host + fakes ───────────────────────

    private sealed class GatewayTestHost : IAsyncDisposable
    {
        private readonly WebApplication _app;
        public string BaseUrl { get; }

        private GatewayTestHost(WebApplication app, string baseUrl) { _app = app; BaseUrl = baseUrl; }

        public static async Task<GatewayTestHost> StartAsync(PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway)
        {
            var builder = WebApplication.CreateBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = null);
            builder.Services.AddSingleton(gateway);
            builder.Services.AddSingleton<ILLMRequestContextAccessor, PrdAgent.Core.Services.LLMRequestContextAccessor>();
            var app = builder.Build();
            app.MapGatewayServingEndpoints(PascalJson, TestKey, "selftest-commit");
            await app.StartAsync();
            var addr = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();
            return new GatewayTestHost(app, addr.TrimEnd('/'));
        }

        public HttpLlmGatewayClient BuildClient(string key)
        {
            var httpFactory = new ServiceCollection().AddHttpClient().BuildServiceProvider()
                .GetRequiredService<IHttpClientFactory>();
            var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["LlmGateway:ServeBaseUrl"] = BaseUrl,
                ["LlmGwServe:ApiKey"] = key,
            }).Build();
            return new HttpLlmGatewayClient(httpFactory, config, NullLogger<HttpLlmGatewayClient>.Instance);
        }

        public async ValueTask DisposeAsync() => await _app.DisposeAsync();
    }

    private static GatewayModelResolution Ok() => new() { Success = true, ActualModel = "m1", Protocol = "openai" };

    // 必败：SendAsync 返回 Fail。
    private sealed class FailingGateway : PrdAgent.Infrastructure.LlmGateway.ILlmGateway
    {
        public Task<GatewayResponse> SendAsync(GatewayRequest r, CancellationToken ct = default)
            => Task.FromResult(GatewayResponse.Fail("UPSTREAM_DOWN", "stub upstream intentional failure", 502));
        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest r, [EnumeratorCancellation] CancellationToken ct = default)
        { await Task.Yield(); yield return GatewayStreamChunk.Fail("stub upstream intentional failure"); }
        public Task<GatewayRawResponse> SendRawWithResolutionAsync(GatewayRawRequest r, GatewayModelResolution res, CancellationToken ct = default)
            => Task.FromResult(GatewayRawResponse.Fail("UPSTREAM_DOWN", "fail", 502));
        public Task<GatewayModelResolution> ResolveModelAsync(string a, string m, string? e = null, CancellationToken ct = default)
            => Task.FromResult(Ok());
        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string a, string m, CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool>());
        public ILLMClient CreateClient(string a, string m, int mt = 4096, double t = 0.2, bool it = false, string? e = null)
            => throw new NotSupportedException();
    }

    // 必败：SendAsync 抛异常（端点应归一为 500，不崩）。
    private sealed class ThrowingGateway : PrdAgent.Infrastructure.LlmGateway.ILlmGateway
    {
        public Task<GatewayResponse> SendAsync(GatewayRequest r, CancellationToken ct = default)
            => throw new InvalidOperationException("stub upstream boom");
        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest r, [EnumeratorCancellation] CancellationToken ct = default)
        { await Task.Yield(); throw new InvalidOperationException("boom"); }
        public Task<GatewayRawResponse> SendRawWithResolutionAsync(GatewayRawRequest r, GatewayModelResolution res, CancellationToken ct = default)
            => throw new InvalidOperationException("boom");
        public Task<GatewayModelResolution> ResolveModelAsync(string a, string m, string? e = null, CancellationToken ct = default)
            => Task.FromResult(Ok());
        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string a, string m, CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool>());
        public ILLMClient CreateClient(string a, string m, int mt = 4096, double t = 0.2, bool it = false, string? e = null)
            => throw new NotSupportedException();
    }

    // 回显 appCallerCode 到 Content，用于并发不串扰断言。
    private sealed class EchoGateway : PrdAgent.Infrastructure.LlmGateway.ILlmGateway
    {
        public Task<GatewayResponse> SendAsync(GatewayRequest r, CancellationToken ct = default)
            => Task.FromResult(GatewayResponse.Ok(r.AppCallerCode, Ok()));
        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest r, [EnumeratorCancellation] CancellationToken ct = default)
        { await Task.Yield(); yield return GatewayStreamChunk.Text(r.AppCallerCode); yield return new GatewayStreamChunk { Type = GatewayChunkType.Done }; }
        public Task<GatewayRawResponse> SendRawWithResolutionAsync(GatewayRawRequest r, GatewayModelResolution res, CancellationToken ct = default)
            => Task.FromResult(new GatewayRawResponse { Success = true, StatusCode = 200, Content = r.AppCallerCode });
        public Task<GatewayModelResolution> ResolveModelAsync(string a, string m, string? e = null, CancellationToken ct = default)
            => Task.FromResult(Ok());
        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string a, string m, CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool>());
        public ILLMClient CreateClient(string a, string m, int mt = 4096, double t = 0.2, bool it = false, string? e = null)
            => throw new NotSupportedException();
    }
}
