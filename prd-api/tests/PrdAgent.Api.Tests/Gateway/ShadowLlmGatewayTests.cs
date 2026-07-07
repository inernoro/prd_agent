using System.Runtime.CompilerServices;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 影子网关单测（纯函数级，无 Mongo / 无 HTTP）：
/// ① caller 永远拿 inproc 权威结果；② 比对记录逐字段正确（含 critical/warning 分级）；
/// ③ http 影子抛异常不影响 caller，且记 HttpOk=false；④ 默认 resolve-only 不触发 http send（不 2x 打模型）。
/// 不打 Integration/Manual trait → CI 默认 dotnet test 真跑。
/// </summary>
public class ShadowLlmGatewayTests
{
    // ── resolve 比对数据驱动：一致 / model 漂移 / protocol 漂移 / platform 漂移 / http 失败 ──
    public static IEnumerable<object[]> ResolveCells() => new List<object[]>
    {
        // name, httpModel, httpProtocol, httpPlatform, httpThrows, expectAllMatch, expectCritical, expectMismatchField
        new object[] { "match", "m1", "openai", "openai", false, true, false, (string?)null },
        new object[] { "model-drift", "m2", "openai", "openai", false, false, true, "actualModel" },
        new object[] { "protocol-drift", "m1", "claude", "openai", false, false, true, "protocol" },
        new object[] { "platform-drift", "m1", "openai", "azure", false, false, false, "platformType" },
        new object[] { "http-throws", "m1", "openai", "openai", true, false, false, (string?)null },
    };

    [Theory]
    [MemberData(nameof(ResolveCells))]
    public async Task ResolveModel_ShadowComparison_IsCorrect(
        string name, string httpModel, string httpProtocol, string httpPlatform,
        bool httpThrows, bool expectAllMatch, bool expectCritical, string? expectMismatchField)
    {
        var inproc = new FakeGateway(Res("m1", "openai", "openai"));
        var http = new FakeGateway(Res(httpModel, httpProtocol, httpPlatform)) { ThrowOnResolve = httpThrows };
        var writer = new CapturingWriter();
        var shadow = new ShadowLlmGateway(inproc, http, NullLogger<ShadowLlmGateway>.Instance, writer);

        var result = await shadow.ResolveModelAsync("demo.app::chat", "chat");

        // ① caller 永远拿 inproc 权威
        result.ActualModel.ShouldBe("m1", $"[{name}] caller 必须拿 inproc 结果");

        var cmp = await writer.WaitForRecordAsync();
        cmp.Kind.ShouldBe("resolve");
        cmp.AllMatch.ShouldBe(expectAllMatch, $"[{name}] AllMatch");
        cmp.HasCritical.ShouldBe(expectCritical, $"[{name}] HasCritical");
        if (httpThrows)
        {
            cmp.HttpOk.ShouldBeFalse($"[{name}] http 失败应 HttpOk=false");
            cmp.HttpError.ShouldNotBeNullOrEmpty();
        }
        if (expectMismatchField != null)
            cmp.Mismatches.ShouldContain(m => m.Field == expectMismatchField, $"[{name}] 期望 {expectMismatchField} 不一致");
    }

    // ② send：caller 拿 inproc；④ 默认（sample=0）不触发 http send，只 http resolve
    [Fact]
    public async Task Send_ResolveOnly_DoesNotDoubleHitModel()
    {
        var inproc = new FakeGateway(Res("m1", "openai", "openai"));
        var http = new FakeGateway(Res("m1", "openai", "openai"));
        var writer = new CapturingWriter();
        var shadow = new ShadowLlmGateway(inproc, http, NullLogger<ShadowLlmGateway>.Instance, writer, fullSamplePercent: 0);

        var resp = await shadow.SendAsync(Req());
        resp.Success.ShouldBeTrue();
        resp.Content.ShouldBe("inproc-content");

        await writer.WaitForRecordAsync();
        http.SendCount.ShouldBe(0, "resolve-only 默认绝不重发 http send（不 2x 打模型）");
        http.ResolveCount.ShouldBeGreaterThanOrEqualTo(1, "应做免费 http resolve 比对");
    }

    // ③ http 影子全程抛异常 → caller 仍拿到 inproc 成功结果
    [Fact]
    public async Task HttpShadowFailure_NeverBreaksCaller()
    {
        var inproc = new FakeGateway(Res("m1", "openai", "openai"));
        var http = new FakeGateway(Res("m1", "openai", "openai")) { ThrowOnResolve = true, ThrowOnSend = true };
        var writer = new CapturingWriter();
        var shadow = new ShadowLlmGateway(inproc, http, NullLogger<ShadowLlmGateway>.Instance, writer);

        var resp = await shadow.SendAsync(Req());
        resp.Success.ShouldBeTrue("http 影子失败绝不能影响 caller");
        resp.Content.ShouldBe("inproc-content");

        var cmp = await writer.WaitForRecordAsync();
        cmp.HttpOk.ShouldBeFalse();
    }

    [Fact]
    public async Task ShadowComparison_RecordsReleaseCommit()
    {
        var inproc = new FakeGateway(Res("m1", "openai", "openai"));
        var http = new FakeGateway(Res("m1", "openai", "openai"));
        var writer = new CapturingWriter();
        var shadow = new ShadowLlmGateway(
            inproc,
            http,
            NullLogger<ShadowLlmGateway>.Instance,
            writer,
            releaseCommit: "sha-ABCDEF1234");

        await shadow.ResolveModelAsync("demo.app::chat", "chat");

        var cmp = await writer.WaitForRecordAsync();
        cmp.ReleaseCommit.ShouldBe("abcdef1234");
    }

    // ② stream：inproc chunk 原样透传给 caller；流末做一次 resolve 比对（chat 主链路覆盖）
    [Fact]
    public async Task Stream_PassesThroughInproc_AndComparesResolve()
    {
        var inproc = new FakeGateway(Res("m1", "openai", "openai"));
        var http = new FakeGateway(Res("m1", "openai", "openai"));
        var writer = new CapturingWriter();
        var shadow = new ShadowLlmGateway(inproc, http, NullLogger<ShadowLlmGateway>.Instance, writer);

        var chunks = new List<GatewayStreamChunk>();
        await foreach (var c in shadow.StreamAsync(Req()))
            chunks.Add(c);

        chunks.Select(c => c.Type).ShouldBe(new[] { GatewayChunkType.Start, GatewayChunkType.Text, GatewayChunkType.Done });
        string.Concat(chunks.Where(c => c.Type == GatewayChunkType.Text).Select(c => c.Content)).ShouldBe("hi");

        var cmp = await writer.WaitForRecordAsync();
        cmp.Kind.ShouldBe("stream");
        cmp.AllMatch.ShouldBeTrue();
        http.SendCount.ShouldBe(0, "流式只做免费 resolve 比对，绝不重发 http 流");
    }

    [Fact]
    public async Task Raw_DefaultSampleZero_DoesNotDoubleHitModel()
    {
        var inproc = new FakeGateway(Res("m1", "openai", "openai")) { RawContent = "raw-inproc" };
        var http = new FakeGateway(Res("m1", "openai", "openai")) { RawContent = "raw-http" };
        var writer = new CapturingWriter();
        var shadow = new ShadowLlmGateway(inproc, http, NullLogger<ShadowLlmGateway>.Instance, writer, fullSamplePercent: 0);

        var resp = await shadow.SendRawWithResolutionAsync(RawReq(), Res("m1", "openai", "openai"));

        resp.Success.ShouldBeTrue();
        resp.Content.ShouldBe("raw-inproc", "默认 raw 仍以 inproc 为权威");
        http.RawCount.ShouldBe(0, "ShadowFullSamplePercent=0 时 raw 不应 2x 打模型");
        await Task.Delay(200);
        writer.Records.ShouldBeEmpty("默认 raw 不落 shadow 记录，避免 resolve-only 伪装成真实 raw 样本");
    }

    [Fact]
    public async Task Raw_FullSample_WritesRawComparison()
    {
        var inproc = new FakeGateway(Res("m1", "openai", "openai")) { RawContent = "raw-inproc" };
        var http = new FakeGateway(Res("m1", "openai", "openai")) { RawContent = "raw-http" };
        var writer = new CapturingWriter();
        var shadow = new ShadowLlmGateway(inproc, http, NullLogger<ShadowLlmGateway>.Instance, writer, fullSamplePercent: 100);

        var resp = await shadow.SendRawWithResolutionAsync(RawReq(), Res("m1", "openai", "openai"));

        resp.Content.ShouldBe("raw-inproc", "采样命中也不能改变调用方返回");
        var cmp = await writer.WaitForRecordAsync();
        cmp.Kind.ShouldBe("raw");
        cmp.AppCallerCode.ShouldBe("demo.app::generation");
        cmp.ModelType.ShouldBe("generation");
        cmp.HttpOk.ShouldBeTrue();
        cmp.AllMatch.ShouldBeTrue();
        cmp.InprocTextChars.ShouldBe("raw-inproc".Length);
        cmp.HttpTextChars.ShouldBe("raw-http".Length);
        http.RawCount.ShouldBe(1, "raw 采样命中时应产生真实 http raw 样本");
    }

    [Fact]
    public async Task Raw_FullSampleAllowlist_WritesRawComparison_WhenGlobalSampleIsZero()
    {
        var inproc = new FakeGateway(Res("m1", "openai", "openai")) { RawContent = "raw-inproc" };
        var http = new FakeGateway(Res("m1", "openai", "openai")) { RawContent = "raw-http" };
        var writer = new CapturingWriter();
        var shadow = new ShadowLlmGateway(
            inproc,
            http,
            NullLogger<ShadowLlmGateway>.Instance,
            writer,
            fullSamplePercent: 0,
            fullSampleAllowlist: new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "demo.app::generation"
            });

        var resp = await shadow.SendRawWithResolutionAsync(RawReq(), Res("m1", "openai", "openai"));

        resp.Content.ShouldBe("raw-inproc", "强制采样只影响证据，不改变调用方返回");
        var cmp = await writer.WaitForRecordAsync();
        cmp.Kind.ShouldBe("raw");
        cmp.AppCallerCode.ShouldBe("demo.app::generation");
        cmp.HttpOk.ShouldBeTrue();
        cmp.AllMatch.ShouldBeTrue();
        http.RawCount.ShouldBe(1, "allowlist 命中应在全局采样为 0 时仍产生确定性的 raw http 样本");
    }

    [Fact]
    public async Task Raw_HttpFailure_IsRecordedWithoutBreakingCaller()
    {
        var inproc = new FakeGateway(Res("m1", "openai", "openai")) { RawContent = "raw-inproc" };
        var http = new FakeGateway(Res("m1", "openai", "openai")) { ThrowOnRaw = true };
        var writer = new CapturingWriter();
        var shadow = new ShadowLlmGateway(inproc, http, NullLogger<ShadowLlmGateway>.Instance, writer, fullSamplePercent: 100);

        var resp = await shadow.SendRawWithResolutionAsync(RawReq(), Res("m1", "openai", "openai"));

        resp.Success.ShouldBeTrue("http raw 影子失败绝不能影响 caller");
        resp.Content.ShouldBe("raw-inproc");
        var cmp = await writer.WaitForRecordAsync();
        cmp.Kind.ShouldBe("raw");
        cmp.HttpOk.ShouldBeFalse("release gate 的 httpFail 必须能挡住 raw serving/upstream 失败");
        cmp.HttpError.ShouldNotBeNullOrEmpty();
        cmp.AllMatch.ShouldBeFalse();
    }

    // ── 灰度翻 http：白名单命中 → http 权威（返回 http 结果，不比对）；未命中 → inproc 权威 ──
    [Fact]
    public async Task Allowlist_Hit_RoutesToHttpAuthoritative()
    {
        var inproc = new FakeGateway(Res("m-inproc", "openai", "openai")) { Content = "inproc-content" };
        var http = new FakeGateway(Res("m-http", "openai", "openai")) { Content = "http-content" };
        var writer = new CapturingWriter();
        var shadow = new ShadowLlmGateway(inproc, http, NullLogger<ShadowLlmGateway>.Instance, writer,
            httpAllowlist: new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "demo.app::chat" });

        // send：白名单命中 → 拿 http 结果
        var resp = await shadow.SendAsync(Req());
        resp.Content.ShouldBe("http-content", "白名单命中应走 http 权威");
        resp.Resolution!.ActualModel.ShouldBe("m-http");

        // resolve：白名单命中 → http model
        var res = await shadow.ResolveModelAsync("demo.app::chat", "chat");
        res.ActualModel.ShouldBe("m-http");

        // 白名单命中不落比对记录（它已经是 http 权威，不是影子）
        await Task.Delay(200);
        writer.Records.ShouldBeEmpty("白名单命中是真正切 http，不应产生影子比对记录");
        inproc.SendCount.ShouldBe(0, "白名单命中不应再走 inproc");
    }

    [Fact]
    public async Task Allowlist_Miss_StaysInprocAndCompares()
    {
        var inproc = new FakeGateway(Res("m-inproc", "openai", "openai")) { Content = "inproc-content" };
        var http = new FakeGateway(Res("m-http", "openai", "openai")) { Content = "http-content" };
        var writer = new CapturingWriter();
        var shadow = new ShadowLlmGateway(inproc, http, NullLogger<ShadowLlmGateway>.Instance, writer,
            httpAllowlist: new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "other.app::chat" });

        var resp = await shadow.SendAsync(Req());  // demo.app::chat 不在白名单
        resp.Content.ShouldBe("inproc-content", "未命中白名单应走 inproc 权威");

        var cmp = await writer.WaitForRecordAsync();   // 未命中仍做影子比对
        cmp.HasCritical.ShouldBeTrue("inproc=m-inproc vs http=m-http → model critical 不一致");
    }

    // CreateClient 绑定到 shadow（使 chat 走 shadow.StreamAsync）
    [Fact]
    public void CreateClient_BindsToShadow()
    {
        var shadow = new ShadowLlmGateway(
            new FakeGateway(Res("m1", "openai", "openai")),
            new FakeGateway(Res("m1", "openai", "openai")),
            NullLogger<ShadowLlmGateway>.Instance);
        var client = shadow.CreateClient("demo.app::chat", "chat");
        client.ShouldBeOfType<GatewayLLMClient>();
    }

    // ─────────────────────── helpers ───────────────────────

    private static GatewayModelResolution Res(string model, string protocol, string platform) => new()
    {
        Success = true, ActualModel = model, Protocol = protocol, PlatformType = platform,
        ActualPlatformId = "plat-1", ResolutionType = "DedicatedPool",
    };

    private static GatewayRequest Req() => new() { AppCallerCode = "demo.app::chat", ModelType = "chat" };
    private static GatewayRawRequest RawReq() => new() { AppCallerCode = "demo.app::generation", ModelType = "generation" };

    private sealed class CapturingWriter : ILlmShadowComparisonWriter
    {
        private readonly TaskCompletionSource<LlmShadowComparison> _tcs =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        public List<LlmShadowComparison> Records { get; } = new();

        public Task RecordAsync(LlmShadowComparison comparison, CancellationToken ct = default)
        {
            Records.Add(comparison);
            _tcs.TrySetResult(comparison);
            return Task.CompletedTask;
        }

        public async Task<LlmShadowComparison> WaitForRecordAsync()
        {
            var done = await Task.WhenAny(_tcs.Task, Task.Delay(TimeSpan.FromSeconds(5)));
            done.ShouldBe(_tcs.Task, "5s 内未收到影子比对记录（后台任务未触发？）");
            return await _tcs.Task;
        }
    }

    private sealed class FakeGateway : ILlmGateway
    {
        private readonly GatewayModelResolution _res;
        public FakeGateway(GatewayModelResolution res) => _res = res;

        public bool ThrowOnResolve { get; init; }
        public bool ThrowOnSend { get; init; }
        public bool ThrowOnRaw { get; init; }
        public string Content { get; init; } = "inproc-content";
        public string RawContent { get; init; } = "raw";
        public int SendCount;
        public int RawCount;
        public int ResolveCount;

        public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
        {
            Interlocked.Increment(ref SendCount);
            if (ThrowOnSend) throw new InvalidOperationException("stub http send boom");
            return Task.FromResult(GatewayResponse.Ok(Content, _res));
        }

        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
            GatewayRequest request, [EnumeratorCancellation] CancellationToken ct = default)
        {
            await Task.Yield();
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Start, Resolution = _res, Seq = 1 };
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Text, Content = "hi", Seq = 2 };
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Done, FinishReason = "stop", Seq = 3 };
        }

        public Task<GatewayModelResolution> ResolveModelAsync(
            string appCallerCode, string modelType, string? expectedModel = null,
            string? pinnedPlatformId = null, string? pinnedModelId = null, CancellationToken ct = default)
        {
            Interlocked.Increment(ref ResolveCount);
            if (ThrowOnResolve) throw new InvalidOperationException("stub http resolve boom");
            return Task.FromResult(_res);
        }

        public Task<GatewayRawResponse> SendRawWithResolutionAsync(
            GatewayRawRequest request, GatewayModelResolution resolution, CancellationToken ct = default)
        {
            Interlocked.Increment(ref RawCount);
            if (ThrowOnRaw) throw new InvalidOperationException("stub http raw boom");
            return Task.FromResult(new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = RawContent,
                Resolution = _res,
            });
        }

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
            string appCallerCode, string modelType, CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool> { new() { Id = "pool-1" } });

        public ILLMClient CreateClient(
            string appCallerCode, string modelType, int maxTokens = 4096, double temperature = 0.2,
            bool includeThinking = false, string? expectedModel = null,
            string? pinnedPlatformId = null, string? pinnedModelId = null)
            => throw new NotSupportedException();
    }
}
