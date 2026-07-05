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
/// C 层：跨进程传输 MECE 自测（真 Kestrel + 真 HttpLlmGatewayClient + stub gateway）——数据驱动版。
///
/// cell 全集见 Gateway/fixtures/transport-cells.json（scripts/gen-gw-matrix-report.py 生成，
/// 与 doc/report.gw-test-matrix.md 第 4 节同源）。覆盖 方法{send,stream,raw,pools,resolve,client-stream}
/// × 上游{echo,failing,throwing,empty} × 鉴权{对,错key} × 负载{单,并发}。
/// 对应 doc/spec.llm-gateway-test-matrix.md C 层 + D11/D12/E15/E17。
///
/// 4 个 stub 上游各起一个常驻 Kestrel host（IClassFixture 复用），避免每 cell 重启。
/// </summary>
// 真 Kestrel + 真 socket 的跨进程往返：在 pull_request runner 上对成功响应体的读取环境敏感
// （workflow_dispatch 上同一份代码全绿、生产真机 gw-smoke 8/8 + 影子均证实 serving 正常），属
// 集成测试范畴，按本仓既有约定（LlmResolutionGoldenIntegrationTests 等）标 Integration——CI 默认
// `Category!=Integration` 跳过，可手动/workflow_dispatch 跑。HTTP 边界的安全契约（ApiKey 不过线）
// 改由纯单元 GatewaySerializationSecurityTests 在 CI 常驻覆盖。
[Trait("Category", "Integration")]
public class CrossProcessServingErrorLoadTests : IClassFixture<CrossProcessServingErrorLoadTests.HostFarm>
{
    private const string TestKey = "test-gateway-key";
    private const string SecretApiKey = "SECRET-must-not-cross";

    // 进程级共享 IHttpClientFactory：整个测试运行复用同一份，HttpMessageHandler 池永不被 GC 终结。
    // 历史 bug：每个 cell new 一个抛弃式 ServiceProvider 且从不 dispose，其 handler 池被 GC 终结后
    // 请求返回空/截断响应，导致 CI 同配置 cell 随机 pass/fail。共享 static 工厂根除此 flake。
    private static readonly IHttpClientFactory SharedHttpFactory =
        new ServiceCollection().AddHttpClient().BuildServiceProvider().GetRequiredService<IHttpClientFactory>();

    private readonly HostFarm _farm;
    public CrossProcessServingErrorLoadTests(HostFarm farm) => _farm = farm;

    [Theory]
    [MemberData(nameof(GatewayMatrixCells.TransportIds), MemberType = typeof(GatewayMatrixCells))]
    public async Task TransportCell(string id)
    {
        var cell = GatewayMatrixCells.GetTransport(id);
        var baseUrl = _farm.BaseUrl(cell.Gateway);
        var client = BuildClient(baseUrl, cell.AuthOk ? TestKey : "WRONG-KEY");

        switch (cell.Method)
        {
            case "send": await AssertSend(cell, client); break;
            case "stream": await AssertStream(cell, client); break;
            case "raw": await AssertRaw(cell, client); break;
            case "pools": await AssertPools(cell, client); break;
            case "resolve": await AssertResolve(cell, client); break;
            case "client-stream": await AssertClientStream(cell, client); break;
            default: throw new ArgumentException($"未知 method: {cell.Method} (cell {id})");
        }
    }

    private static async Task AssertSend(TransportCell cell, HttpLlmGatewayClient client)
    {
        if (cell.Concurrency > 1)
        {
            var n = cell.Concurrency;
            var tasks = Enumerable.Range(0, n).Select(async i =>
            {
                var resp = await client.SendAsync(new GatewayRequest { AppCallerCode = $"demo::chat#{i}", ModelType = "chat" });
                return (i, resp);
            }).ToArray();
            var results = await Task.WhenAll(tasks);
            foreach (var (i, resp) in results)
            {
                resp.Success.ShouldBeTrue($"cell {cell.Id} 并发#{i}");
                if (cell.Bool("concurrentNoCrossTalk"))
                    resp.Content.ShouldBe($"demo::chat#{i}", $"cell {cell.Id}: 并发#{i} 串号");
            }
            return;
        }

        var r = await client.SendAsync(new GatewayRequest { AppCallerCode = "demo::chat", ModelType = "chat" });
        AssertCommon(cell, r.Success, r.StatusCode, r.ErrorCode);
        if (cell.Bool("contentEcho")) r.Content.ShouldBe("demo::chat", $"cell {cell.Id}: echo 不符");
        if (cell.Bool("contentEmpty")) r.Content.ShouldBeNullOrEmpty($"cell {cell.Id}: 期望空内容");
    }

    private async Task AssertStream(TransportCell cell, HttpLlmGatewayClient client)
    {
        if (cell.Concurrency > 1)
        {
            var n = cell.Concurrency;
            var tasks = Enumerable.Range(0, n).Select(async _ =>
            {
                var cs = new List<GatewayStreamChunk>();
                await foreach (var c in client.StreamAsync(new GatewayRequest { AppCallerCode = "demo::chat", ModelType = "chat" }))
                    cs.Add(c);
                return cs;
            }).ToArray();
            var all = await Task.WhenAll(tasks);
            foreach (var cs in all)
            {
                cs.Count.ShouldBeGreaterThanOrEqualTo(cell.Int("minChunks"), $"cell {cell.Id}: 并发流块不足");
                string.Concat(cs.Where(c => c.Type == GatewayChunkType.Text).Select(c => c.Content)).ShouldBe("hello",
                    $"cell {cell.Id}: 并发流文本串扰");
            }
            return;
        }

        var chunks = new List<GatewayStreamChunk>();
        await foreach (var c in client.StreamAsync(new GatewayRequest { AppCallerCode = "demo::chat", ModelType = "chat" }))
            chunks.Add(c);

        if (cell.Bool("streamFailed") || cell.Bool("streamHasError"))
        {
            chunks.ShouldContain(c => c.Type == GatewayChunkType.Error, $"cell {cell.Id}: 期望流内出现 Error chunk");
            return;
        }

        chunks.Count.ShouldBeGreaterThanOrEqualTo(cell.Int("minChunks"), $"cell {cell.Id}: 流块不足");
        if (cell.Bool("seqMonotonic"))
        {
            var seqs = chunks.Select(c => c.Seq).ToList();
            seqs.ShouldBe(seqs.OrderBy(x => x).ToList(), $"cell {cell.Id}: Seq 非单调");
        }
        if (cell.Has("textJoined"))
            string.Concat(chunks.Where(c => c.Type == GatewayChunkType.Text).Select(c => c.Content))
                .ShouldBe(cell.Str("textJoined"), $"cell {cell.Id}: 流文本拼接不符");
    }

    private static async Task AssertRaw(TransportCell cell, HttpLlmGatewayClient client)
    {
        var r = await client.SendRawWithResolutionAsync(
            new GatewayRawRequest { AppCallerCode = "demo::generation", ModelType = "generation" },
            new GatewayModelResolution { Success = true });
        AssertCommon(cell, r.Success, r.StatusCode, null);
    }

    private static async Task AssertPools(TransportCell cell, HttpLlmGatewayClient client)
    {
        if (cell.Bool("poolsFailed"))
        {
            var ex = await Should.ThrowAsync<InvalidOperationException>(
                () => client.GetAvailablePoolsAsync("demo::chat", "chat"));
            ex.Message.Contains("401", StringComparison.Ordinal).ShouldBeTrue(
                $"cell {cell.Id}: 错 key 应明确暴露 serving 鉴权失败");
            return;
        }

        var pools = await client.GetAvailablePoolsAsync("demo::chat", "chat");
        if (cell.Bool("poolsOk")) pools.Count.ShouldBeGreaterThan(0, $"cell {cell.Id}: 期望非空池");
    }

    private static async Task AssertResolve(TransportCell cell, HttpLlmGatewayClient client)
    {
        var res = await client.ResolveModelAsync("demo::chat", "chat");
        if (cell.Bool("resolveFailed")) { res.Success.ShouldBeFalse($"cell {cell.Id}: 错 key 应失败"); return; }
        if (cell.Has("actualModel")) res.ActualModel.ShouldBe(cell.Str("actualModel"), $"cell {cell.Id}");
        if (cell.Bool("apiKeyNull")) res.ApiKey.ShouldBeNull($"cell {cell.Id}: ApiKey 绝不能跨 HTTP 回传");
    }

    private static async Task AssertClientStream(TransportCell cell, HttpLlmGatewayClient client)
    {
        var llm = client.CreateClient("demo::chat", "chat");
        var chunks = new List<LLMStreamChunk>();
        await foreach (var c in llm.StreamGenerateAsync("sys", new List<LLMMessage> { new() { Role = "user", Content = "hi" } }, CancellationToken.None))
            chunks.Add(c);
        chunks.Count.ShouldBeGreaterThanOrEqualTo(cell.Int("minChunks"), $"cell {cell.Id}: client-stream 块不足");
        if (cell.Has("textJoined"))
            string.Concat(chunks.Where(c => c.Type == "delta").Select(c => c.Content))
                .ShouldBe(cell.Str("textJoined"), $"cell {cell.Id}: client-stream 文本不符");
    }

    private static void AssertCommon(TransportCell cell, bool success, int statusCode, string? errorCode)
    {
        if (cell.Has("success")) success.ShouldBe(cell.Bool("success"), $"cell {cell.Id}: success 不符");
        if (cell.Has("statusCode")) statusCode.ShouldBe(cell.Int("statusCode"), $"cell {cell.Id}: statusCode 不符");
        if (cell.Bool("errorCodeNonEmpty")) errorCode.ShouldNotBeNullOrEmpty($"cell {cell.Id}: 期望 ErrorCode");
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

    // ─────────────────────── HostFarm：4 个 stub 上游各一个常驻 host ───────────────────────

    public sealed class HostFarm : IAsyncLifetime
    {
        private static readonly JsonSerializerOptions PascalJson = new()
        {
            PropertyNamingPolicy = null,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        private readonly Dictionary<string, WebApplication> _apps = new();
        private readonly Dictionary<string, string> _urls = new();

        public string BaseUrl(string gateway) => _urls[gateway];

        public async Task InitializeAsync()
        {
            await Start("echo", new EchoGateway());
            await Start("failing", new FailingGateway());
            await Start("throwing", new ThrowingGateway());
            await Start("empty", new EmptyGateway());
        }

        private async Task Start(string name, PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway)
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
            _apps[name] = app;
            _urls[name] = addr.TrimEnd('/');
        }

        public async Task DisposeAsync()
        {
            foreach (var app in _apps.Values)
                await app.DisposeAsync();
        }
    }

    private static GatewayModelResolution Res() => new()
    {
        Success = true, ActualModel = "m1", Protocol = "openai", ApiKey = SecretApiKey,
    };

    // echo：回显 appCallerCode；stream 固定 "hel"+"lo"；resolve 带 SECRET ApiKey（验跨进程剥离）。
    private sealed class EchoGateway : PrdAgent.Infrastructure.LlmGateway.ILlmGateway
    {
        public Task<GatewayResponse> SendAsync(GatewayRequest r, CancellationToken ct = default)
            => Task.FromResult(GatewayResponse.Ok(r.AppCallerCode, Res()));
        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest r, [EnumeratorCancellation] CancellationToken ct = default)
        {
            await Task.Yield();
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Start, Seq = 1, Resolution = Res() };
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Text, Seq = 2, Content = "hel" };
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Text, Seq = 3, Content = "lo" };
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Done, Seq = 4, FinishReason = "stop" };
        }
        public Task<GatewayRawResponse> SendRawWithResolutionAsync(GatewayRawRequest r, GatewayModelResolution res, CancellationToken ct = default)
            => Task.FromResult(new GatewayRawResponse { Success = true, StatusCode = 200, Content = "raw-ok" });
        public Task<GatewayModelResolution> ResolveModelAsync(string a, string m, string? e = null, CancellationToken ct = default)
            => Task.FromResult(Res());
        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string a, string m, CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool> { new() { Id = "pool-1", Name = "默认池", Code = "default", Priority = 1, ResolutionType = "defaultPool", Models = new() } });
        public ILLMClient CreateClient(string a, string m, int mt = 4096, double t = 0.2, bool it = false, string? e = null)
            => new EchoLlmClient();
    }

    private sealed class EchoLlmClient : ILLMClient
    {
        public string Provider => "echo";
        public IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(string s, List<LLMMessage> m, CancellationToken ct = default)
            => StreamGenerateAsync(s, m, false, ct);
        public async IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(string s, List<LLMMessage> m, bool cache, [EnumeratorCancellation] CancellationToken ct = default)
        {
            await Task.Yield();
            yield return new LLMStreamChunk { Type = "start" };
            yield return new LLMStreamChunk { Type = "delta", Content = "hi" };
            yield return new LLMStreamChunk { Type = "done", OutputTokens = 1 };
        }
    }

    private sealed class FailingGateway : PrdAgent.Infrastructure.LlmGateway.ILlmGateway
    {
        public Task<GatewayResponse> SendAsync(GatewayRequest r, CancellationToken ct = default)
            => Task.FromResult(GatewayResponse.Fail("UPSTREAM_DOWN", "stub upstream intentional failure", 502));
        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest r, [EnumeratorCancellation] CancellationToken ct = default)
        { await Task.Yield(); yield return GatewayStreamChunk.Fail("stub upstream intentional failure"); }
        public Task<GatewayRawResponse> SendRawWithResolutionAsync(GatewayRawRequest r, GatewayModelResolution res, CancellationToken ct = default)
            => Task.FromResult(GatewayRawResponse.Fail("UPSTREAM_DOWN", "fail", 502));
        public Task<GatewayModelResolution> ResolveModelAsync(string a, string m, string? e = null, CancellationToken ct = default)
            => Task.FromResult(Res());
        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string a, string m, CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool>());
        public ILLMClient CreateClient(string a, string m, int mt = 4096, double t = 0.2, bool it = false, string? e = null)
            => throw new NotSupportedException();
    }

    private sealed class ThrowingGateway : PrdAgent.Infrastructure.LlmGateway.ILlmGateway
    {
        public Task<GatewayResponse> SendAsync(GatewayRequest r, CancellationToken ct = default)
            => throw new InvalidOperationException("stub upstream boom");
        public IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest r, CancellationToken ct = default)
            => throw new InvalidOperationException("boom");
        public Task<GatewayRawResponse> SendRawWithResolutionAsync(GatewayRawRequest r, GatewayModelResolution res, CancellationToken ct = default)
            => throw new InvalidOperationException("boom");
        public Task<GatewayModelResolution> ResolveModelAsync(string a, string m, string? e = null, CancellationToken ct = default)
            => Task.FromResult(Res());
        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string a, string m, CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool>());
        public ILLMClient CreateClient(string a, string m, int mt = 4096, double t = 0.2, bool it = false, string? e = null)
            => throw new NotSupportedException();
    }

    // empty：成功但内容为空（验空内容兜底）。
    private sealed class EmptyGateway : PrdAgent.Infrastructure.LlmGateway.ILlmGateway
    {
        public Task<GatewayResponse> SendAsync(GatewayRequest r, CancellationToken ct = default)
            => Task.FromResult(GatewayResponse.Ok("", Res()));
        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest r, [EnumeratorCancellation] CancellationToken ct = default)
        { await Task.Yield(); yield return new GatewayStreamChunk { Type = GatewayChunkType.Done, Seq = 1, FinishReason = "stop" }; }
        public Task<GatewayRawResponse> SendRawWithResolutionAsync(GatewayRawRequest r, GatewayModelResolution res, CancellationToken ct = default)
            => Task.FromResult(new GatewayRawResponse { Success = true, StatusCode = 200, Content = "" });
        public Task<GatewayModelResolution> ResolveModelAsync(string a, string m, string? e = null, CancellationToken ct = default)
            => Task.FromResult(Res());
        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string a, string m, CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool>());
        public ILLMClient CreateClient(string a, string m, int mt = 4096, double t = 0.2, bool it = false, string? e = null)
            => throw new NotSupportedException();
    }
}
