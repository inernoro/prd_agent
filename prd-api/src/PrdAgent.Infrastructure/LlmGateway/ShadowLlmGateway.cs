using System.Diagnostics;
using System.Runtime.CompilerServices;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using CoreGateway = PrdAgent.Core.Interfaces.LlmGateway;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 影子网关：把请求交给 inproc（进程内 LlmGateway，**权威**，结果原样返回调用方），同时**后台**对跨进程
/// http 网关做比对，落 llmshadow_comparisons。用于灰度翻 http 前积累逐字段一致性证据。
///
/// 成本护栏：默认只比**解析**（inproc 解析 vs http <c>/gw/v1/resolve</c>，纯 DB、零额外大模型调用），覆盖
/// compute-then-send / 选A给B 这类最高风险分歧。仅当 <c>fullSamplePercent &gt; 0</c> 时，才对采样的非流式 send
/// 真发 http 做完整内容/finish/token 比对（有界成本）。流式（chat 主链路）只做免费 resolve 比对，绝不 2x 打大模型。
///
/// server-authority：所有影子后台调用用 <see cref="CancellationToken.None"/>（调用方断开不取消）；影子任何失败
/// 一律吞掉 + Warning，**caller 永远拿 inproc 结果**，主流程零影响。
///
/// 同时实现 Infrastructure + Core 两个 ILlmGateway（与 HttpLlmGatewayClient 一致），使 Program.cs 的 Core 桥接强转成立。
/// </summary>
public sealed class ShadowLlmGateway : ILlmGateway, CoreGateway.ILlmGateway
{
    private readonly ILlmGateway _inproc;   // 权威
    private readonly ILlmGateway _http;     // 影子
    private readonly ILogger<ShadowLlmGateway> _logger;
    private readonly ILlmShadowComparisonWriter? _writer;
    private readonly int _fullSamplePercent;
    private readonly ILLMRequestContextAccessor? _ctx;

    public ShadowLlmGateway(
        ILlmGateway inproc,
        ILlmGateway http,
        ILogger<ShadowLlmGateway> logger,
        ILlmShadowComparisonWriter? writer = null,
        int fullSamplePercent = 0,
        ILLMRequestContextAccessor? ctx = null)
    {
        _inproc = inproc;
        _http = http;
        _logger = logger;
        _writer = writer;
        _fullSamplePercent = Math.Clamp(fullSamplePercent, 0, 100);
        _ctx = ctx;
    }

    // ─────────────────────── 主路径（inproc 权威 + 后台影子比对）───────────────────────

    public async Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
    {
        var inproc = await _inproc.SendAsync(request, ct);
        if (SampleHit())
            FireFullSendCompare(request, inproc);            // 采样：完整 send 比对（2x 打模型，有界）
        else
            FireResolveCompare(request.AppCallerCode, request.ModelType, request.ExpectedModel, inproc.Resolution, "send");
        return inproc;
    }

    public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
        GatewayRequest request, [EnumeratorCancellation] CancellationToken ct = default)
    {
        GatewayModelResolution? startResolution = null;
        await foreach (var chunk in _inproc.StreamAsync(request, ct))
        {
            if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                startResolution = chunk.Resolution;
            yield return chunk;
        }
        // 流式只做免费 resolve 比对（不重发 http 流，绝不 2x 打大模型）。
        FireResolveCompare(request.AppCallerCode, request.ModelType, request.ExpectedModel, startResolution, "stream");
    }

    public async Task<GatewayModelResolution> ResolveModelAsync(
        string appCallerCode, string modelType, string? expectedModel = null, CancellationToken ct = default)
    {
        var inproc = await _inproc.ResolveModelAsync(appCallerCode, modelType, expectedModel, ct);
        FireResolveCompare(appCallerCode, modelType, expectedModel, inproc, "resolve");
        return inproc;
    }

    public async Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
        string appCallerCode, string modelType, CancellationToken ct = default)
    {
        var inproc = await _inproc.GetAvailablePoolsAsync(appCallerCode, modelType, ct);
        FirePoolsCompare(appCallerCode, modelType, inproc);
        return inproc;
    }

    /// <summary>
    /// raw（生图/视频）走预解析 resolution，比对会 2x 打模型且不在本波 chat 范围内 → 纯透传 inproc，不影子。
    /// </summary>
    public Task<GatewayRawResponse> SendRawWithResolutionAsync(
        GatewayRawRequest request, GatewayModelResolution resolution, CancellationToken ct = default)
        => _inproc.SendRawWithResolutionAsync(request, resolution, ct);

    /// <summary>
    /// 返回绑定到 <c>this</c>（影子）的客户端，使 chat 的 <c>StreamGenerateAsync → ShadowLlmGateway.StreamAsync</c>，
    /// 每条消息做免费 resolve 比对（chat 主链路覆盖）。
    /// </summary>
    public Core.Interfaces.ILLMClient CreateClient(
        string appCallerCode, string modelType, int maxTokens = 4096, double temperature = 0.2,
        bool includeThinking = false, string? expectedModel = null)
        => new GatewayLLMClient(
            this, appCallerCode, modelType,
            platformId: null, platformName: null, enablePromptCache: true,
            maxTokens: maxTokens, temperature: temperature, includeThinking: includeThinking,
            contextAccessor: _ctx, expectedModel: expectedModel);

    // ─────────────────────── 后台比对（fire-and-forget，全隔离）───────────────────────

    private bool SampleHit() => _fullSamplePercent > 0 && Random.Shared.Next(100) < _fullSamplePercent;

    private void SafeRun(Func<Task> work) => _ = Task.Run(async () =>
    {
        try { await work(); }
        catch (Exception ex) { _logger.LogWarning(ex, "[ShadowLlmGateway] 影子比对后台任务异常（已隔离，不影响主流程）"); }
    });

    private void FireResolveCompare(
        string appCallerCode, string modelType, string? expectedModel, GatewayModelResolution? inprocResolution, string kind)
    {
        if (_writer == null) return;
        var requestId = _ctx?.Current?.RequestId;
        SafeRun(async () =>
        {
            var sw = Stopwatch.StartNew();
            GatewayModelResolution? httpResolution = null;
            string? httpErr = null;
            try { httpResolution = await _http.ResolveModelAsync(appCallerCode, modelType, expectedModel, CancellationToken.None); }
            catch (Exception ex) { httpErr = ex.Message; }
            sw.Stop();
            var cmp = BuildResolveComparison(kind, requestId, appCallerCode, modelType, inprocResolution, httpResolution, httpErr, sw.ElapsedMilliseconds);
            await _writer!.RecordAsync(cmp, CancellationToken.None);
        });
    }

    private void FireFullSendCompare(GatewayRequest request, GatewayResponse inproc)
    {
        if (_writer == null) return;
        var requestId = _ctx?.Current?.RequestId;
        SafeRun(async () =>
        {
            var sw = Stopwatch.StartNew();
            GatewayResponse? http = null;
            string? httpErr = null;
            try { http = await _http.SendAsync(request, CancellationToken.None); }
            catch (Exception ex) { httpErr = ex.Message; }
            sw.Stop();
            var cmp = BuildResolveComparison("send", requestId, request.AppCallerCode, request.ModelType,
                inproc.Resolution, http?.Resolution, httpErr, sw.ElapsedMilliseconds);
            if (http != null)
            {
                cmp.InprocTextChars = inproc.Content?.Length;
                cmp.HttpTextChars = http.Content?.Length;
                cmp.InprocOutputTokens = inproc.TokenUsage?.OutputTokens;
                cmp.HttpOutputTokens = http.TokenUsage?.OutputTokens;
                cmp.TextMatches = string.Equals(inproc.Content ?? "", http.Content ?? "", StringComparison.Ordinal);
                if (cmp.TextMatches == false)
                {
                    cmp.Mismatches.Add(new FieldMismatch
                    {
                        Field = "content",
                        Inproc = $"{inproc.Content?.Length ?? 0} chars",
                        Http = $"{http.Content?.Length ?? 0} chars",
                        Severity = "warning",
                    });
                    cmp.AllMatch = false;
                }
            }
            await _writer!.RecordAsync(cmp, CancellationToken.None);
        });
    }

    private void FirePoolsCompare(string appCallerCode, string modelType, List<AvailableModelPool> inproc)
    {
        if (_writer == null) return;
        var requestId = _ctx?.Current?.RequestId;
        SafeRun(async () =>
        {
            var sw = Stopwatch.StartNew();
            List<AvailableModelPool>? http = null;
            string? httpErr = null;
            try { http = await _http.GetAvailablePoolsAsync(appCallerCode, modelType, CancellationToken.None); }
            catch (Exception ex) { httpErr = ex.Message; }
            sw.Stop();
            var cmp = new LlmShadowComparison
            {
                Kind = "pools", RequestId = requestId, AppCallerCode = appCallerCode, ModelType = modelType,
                ShadowDurationMs = sw.ElapsedMilliseconds, HttpOk = httpErr == null && http != null, HttpError = httpErr,
            };
            if (cmp.HttpOk)
            {
                var a = string.Join(",", inproc.Select(p => p.Id).OrderBy(x => x));
                var b = string.Join(",", http!.Select(p => p.Id).OrderBy(x => x));
                if (inproc.Count != http.Count)
                    cmp.Mismatches.Add(new FieldMismatch { Field = "poolCount", Inproc = inproc.Count.ToString(), Http = http.Count.ToString(), Severity = "warning" });
                if (!string.Equals(a, b, StringComparison.Ordinal))
                    cmp.Mismatches.Add(new FieldMismatch { Field = "poolIds", Inproc = a, Http = b, Severity = "warning" });
            }
            cmp.AllMatch = cmp.HttpOk && cmp.Mismatches.Count == 0;
            await _writer!.RecordAsync(cmp, CancellationToken.None);
        });
    }

    private static ResolveSnapshot Snap(GatewayModelResolution? r) => new()
    {
        Success = r?.Success ?? false,
        ActualModel = r?.ActualModel,
        Protocol = r?.Protocol,
        PlatformType = r?.PlatformType,
        ResolutionType = r?.ResolutionType,
        ModelGroupId = r?.ModelGroupId,
        IsFallback = r?.IsFallback ?? false,
    };

    private static LlmShadowComparison BuildResolveComparison(
        string kind, string? requestId, string appCallerCode, string modelType,
        GatewayModelResolution? inproc, GatewayModelResolution? http, string? httpErr, long ms)
    {
        var cmp = new LlmShadowComparison
        {
            Kind = kind, RequestId = requestId, AppCallerCode = appCallerCode, ModelType = modelType,
            ShadowDurationMs = ms, HttpOk = httpErr == null && http != null, HttpError = httpErr,
            Inproc = Snap(inproc), Http = Snap(http),
        };

        if (cmp.HttpOk && inproc != null && http != null)
        {
            void Compare(string field, string? a, string? b, bool critical)
            {
                if (!string.Equals(a ?? "", b ?? "", StringComparison.OrdinalIgnoreCase))
                    cmp.Mismatches.Add(new FieldMismatch { Field = field, Inproc = a, Http = b, Severity = critical ? "critical" : "warning" });
            }
            // model / protocol 漂移 = critical（直接阻断翻 http）；其余 = warning。
            Compare("actualModel", inproc.ActualModel, http.ActualModel, critical: true);
            Compare("protocol", inproc.Protocol, http.Protocol, critical: true);
            Compare("platformType", inproc.PlatformType, http.PlatformType, critical: false);
            Compare("resolutionType", inproc.ResolutionType, http.ResolutionType, critical: false);
            Compare("modelGroupId", inproc.ModelGroupId, http.ModelGroupId, critical: false);
            if (inproc.IsFallback != http.IsFallback)
                cmp.Mismatches.Add(new FieldMismatch { Field = "isFallback", Inproc = inproc.IsFallback.ToString(), Http = http.IsFallback.ToString(), Severity = "warning" });
        }

        cmp.HasCritical = cmp.Mismatches.Any(m => m.Severity == "critical");
        cmp.AllMatch = cmp.HttpOk && cmp.Mismatches.Count == 0;
        return cmp;
    }
}
