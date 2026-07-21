using System.Diagnostics;
using System.Runtime.CompilerServices;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using CoreGateway = PrdAgent.Core.Interfaces.LlmGateway;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 网关模式路由器（影子 + 灰度翻 http 统一入口）：
///
/// 1. **灰度翻 http（allowlist 权威路由）**：命中 <c>httpAllowlist</c> 的 appCallerCode 直接走 http 网关并**返回 http
///    结果**（真正切到跨进程）。按入口逐个加白名单 = 逐个灰度翻，其余入口不受影响。
/// 2. **逻辑模型硬边界**：显式选择逻辑模型时，无论 allowlist 和全局 Mode 如何，都由独立 http Gateway 权威解析与发送；
///    禁止 MAP inproc 用同名旧模型池接管。
/// 3. **影子比对（非 allowlist、非逻辑模型）**：未命中白名单的旧请求交给 inproc（**权威**，原样返回调用方），
///    同时**后台**对 http 网关做比对，落 llmshadow_comparisons，为后续把该入口加进白名单积累一致性证据。
///
/// 成本护栏：影子默认只比**解析**（inproc 解析 vs http <c>/gw/v1/resolve</c>，纯 DB、零额外大模型调用），覆盖
/// compute-then-send / 选A给B 这类最高风险分歧。仅当 <c>fullSamplePercent &gt; 0</c> 时，才对采样的非流式 send
/// 真发 http 做完整内容/finish/token 比对（有界成本）。流式（chat 主链路）只做免费 resolve 比对，绝不 2x 打大模型。
///
/// server-authority：所有影子后台调用用 <see cref="CancellationToken.None"/>（调用方断开不取消）；影子任何失败
/// 一律吞掉 + Warning，**caller 永远拿 inproc 结果**（白名单命中除外，那是有意切 http）。主流程零影响。
///
/// 同时实现 Infrastructure + Core 两个 ILlmGateway（与 HttpLlmGatewayClient 一致），使 Program.cs 的 Core 桥接强转成立。
/// </summary>
public sealed class ShadowLlmGateway : ILlmGateway, CoreGateway.ILlmGateway
{
    private readonly ILlmGateway _inproc;   // 权威（非白名单）
    private readonly ILlmGateway _http;     // 影子 / 白名单命中时的权威
    private readonly ILogger<ShadowLlmGateway> _logger;
    private readonly ILlmShadowComparisonWriter? _writer;
    private readonly int _fullSamplePercent;
    private readonly ILLMRequestContextAccessor? _ctx;
    private readonly IReadOnlySet<string> _httpAllowlist;
    private readonly IReadOnlySet<string> _fullSampleAllowlist;
    private readonly string? _releaseCommit;
    private readonly string _internalTenantId;

    public ShadowLlmGateway(
        ILlmGateway inproc,
        ILlmGateway http,
        ILogger<ShadowLlmGateway> logger,
        ILlmShadowComparisonWriter? writer = null,
        int fullSamplePercent = 0,
        ILLMRequestContextAccessor? ctx = null,
        IReadOnlySet<string>? httpAllowlist = null,
        IReadOnlySet<string>? fullSampleAllowlist = null,
        string? releaseCommit = null,
        IConfiguration? configuration = null)
    {
        _inproc = inproc;
        _http = http;
        _logger = logger;
        _writer = writer;
        _fullSamplePercent = Math.Clamp(fullSamplePercent, 0, 100);
        _ctx = ctx;
        _httpAllowlist = httpAllowlist ?? new HashSet<string>();
        _fullSampleAllowlist = fullSampleAllowlist ?? new HashSet<string>();
        _releaseCommit = NormalizeCommit(releaseCommit);
        _internalTenantId = configuration?["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } tenantId
            ? tenantId
            : GatewayTenantDefaults.InternalTenantId;
    }

    /// <summary>该 appCallerCode 是否已灰度翻 http（白名单命中 → http 权威）。</summary>
    private bool RouteToHttp(string appCallerCode) => _httpAllowlist.Contains(appCallerCode);

    private bool ContextRequiresLogicalModel(out string? logicalModelPublicId)
    {
        var current = _ctx?.Current;
        logicalModelPublicId = current?.LogicalModelPublicId?.Trim();
        return current?.ModelResolutionType == ModelResolutionType.LogicalModel;
    }

    /// <summary>
    /// 逻辑模型属于独立 Gateway 的配置域。即使 MAP 仍处于 inproc/shadow 迁移期，
    /// 只要应用显式选择了逻辑模型，就不能再让 MAP 内旧模型池解释同名 key。
    /// 这里用应用当前可见目录识别逻辑模型；目录查询失败时不把普通旧模型误判成逻辑模型。
    /// </summary>
    private async Task<bool> IsDeclaredLogicalModelAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel,
        string? pinnedPlatformId,
        string? pinnedModelId,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(expectedModel)
            || !string.IsNullOrWhiteSpace(pinnedPlatformId)
            || !string.IsNullOrWhiteSpace(pinnedModelId))
            return false;

        try
        {
            var key = expectedModel.Trim();
            var pools = await _inproc.GetAvailablePoolsAsync(appCallerCode, modelType, ct);
            return pools.Any(pool =>
                string.Equals(pool.ResolutionType, "LogicalModel", StringComparison.OrdinalIgnoreCase)
                && (string.Equals(pool.Code, key, StringComparison.OrdinalIgnoreCase)
                    || pool.Models.Any(model => string.Equals(model.ModelId, key, StringComparison.OrdinalIgnoreCase))));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "[ShadowLlmGateway] 识别逻辑模型目录失败 appCaller={AppCallerCode} model={ExpectedModel}",
                appCallerCode, expectedModel);
            return false;
        }
    }

    // S2 传输观测标记：ShadowLlmGateway 本身不构建/写日志，返回的权威结果由底层网关落库并打真实传输标记——
    // 白名单命中走 _http（HttpLlmGatewayClient 打 "http"），否则走 _inproc（LlmGateway 打 "inproc"）。
    // 有意**不**把返回结果统一改写成 GatewayTransports.Shadow：日志应如实反映请求实际在何处执行
    // （inproc/http），而非 MAP 当前处于 shadow 模式这一编排事实。GatewayTransports.Shadow 保留给
    // 未来若需要标注影子后台探针自身的日志；当前后台 http 探针经 _http 已被打成 "http"。

    // ─────────────────────── 主路径（白名单→http 权威 / 否则 inproc 权威 + 后台影子）───────────────────────

    public async Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
    {
        if (ContextRequiresLogicalModel(out var requiredLogicalModel))
        {
            requiredLogicalModel = FirstNonBlank(requiredLogicalModel, request.GetEffectiveExpectedModel());
            if (string.IsNullOrWhiteSpace(requiredLogicalModel))
            {
                return GatewayResponse.Fail(
                    "LOGICAL_MODEL_ID_REQUIRED",
                    "当前业务任务声明为逻辑模型，但缺少逻辑模型公开标识，已拒绝退回旧模型池。",
                    422);
            }

            return await _http.SendAsync(WithExpectedLogicalModel(request, requiredLogicalModel), ct);
        }

        if (RouteToHttp(request.AppCallerCode))
            return await _http.SendAsync(request, ct);       // 已灰度：http 权威
        // 关键：在 inproc 改写 request.RequestBody["model"] 为其选中的实际模型**之前**捕获有效期望模型。
        // 否则影子 http 探针拿到的是 inproc 的答案当输入 → 永远 match，影子比对形同虚设（评审 P2）。
        var expectedModel = request.GetEffectiveExpectedModel();
        var inproc = await _inproc.SendAsync(request, ct);
        if (SampleHit(request.AppCallerCode))
            FireFullSendCompare(request, inproc, expectedModel);  // 采样：完整 send 比对（2x 打模型，有界）
        else
            FireResolveCompare(request.AppCallerCode, request.ModelType, expectedModel, request.PinnedPlatformId, request.PinnedModelId, inproc.Resolution, "send");
        return inproc;
    }

    public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
        GatewayRequest request, [EnumeratorCancellation] CancellationToken ct = default)
    {
        if (ContextRequiresLogicalModel(out var requiredLogicalModel))
        {
            requiredLogicalModel = FirstNonBlank(requiredLogicalModel, request.GetEffectiveExpectedModel());
            if (string.IsNullOrWhiteSpace(requiredLogicalModel))
                throw new InvalidOperationException("当前业务任务声明为逻辑模型，但缺少逻辑模型公开标识，已拒绝退回旧模型池。");

            await foreach (var chunk in _http.StreamAsync(
                               WithExpectedLogicalModel(request, requiredLogicalModel), ct))
            {
                yield return chunk;
            }
            yield break;
        }

        if (RouteToHttp(request.AppCallerCode))
        {
            await foreach (var chunk in _http.StreamAsync(request, ct))  // 已灰度：http 权威流
                yield return chunk;
            yield break;
        }
        // 同 send：inproc 流会改写 request.RequestBody["model"]，必须在开流**之前**捕获原始有效期望模型，
        // 否则影子探针拿到 inproc 选中的模型当输入 → 永远 match（评审 P2）。
        var expectedModel = request.GetEffectiveExpectedModel();
        GatewayModelResolution? startResolution = null;
        try
        {
            await foreach (var chunk in _inproc.StreamAsync(request, ct))
            {
                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                    startResolution = chunk.Resolution;
                yield return chunk;
            }
        }
        finally
        {
            if (startResolution != null)
                FireResolveCompare(request.AppCallerCode, request.ModelType, expectedModel, request.PinnedPlatformId, request.PinnedModelId, startResolution, "stream");
        }
    }

    public async Task<GatewayModelResolution> ResolveModelAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        string? pinnedPlatformId = null,
        string? pinnedModelId = null,
        CancellationToken ct = default)
    {
        if (ContextRequiresLogicalModel(out var requiredLogicalModel))
        {
            requiredLogicalModel = FirstNonBlank(requiredLogicalModel, expectedModel);
            if (string.IsNullOrWhiteSpace(requiredLogicalModel))
            {
                return new GatewayModelResolution
                {
                    Success = false,
                    ResolutionType = "NotFound",
                    ErrorMessage = "当前业务任务声明为逻辑模型，但缺少逻辑模型公开标识，已拒绝退回旧模型池。",
                };
            }

            return await _http.ResolveRequiredLogicalModelAsync(
                appCallerCode,
                modelType,
                requiredLogicalModel,
                ct);
        }

        if (RouteToHttp(appCallerCode))
            return await _http.ResolveModelAsync(appCallerCode, modelType, expectedModel, pinnedPlatformId, pinnedModelId, ct);

        if (await IsDeclaredLogicalModelAsync(
                appCallerCode, modelType, expectedModel, pinnedPlatformId, pinnedModelId, ct))
        {
            try
            {
                return await _http.ResolveModelAsync(
                    appCallerCode, modelType, expectedModel, pinnedPlatformId, pinnedModelId, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex,
                    "[ShadowLlmGateway] 逻辑模型必须由独立 Gateway 解析，拒绝退回 MAP 旧模型池 appCaller={AppCallerCode} model={ExpectedModel}",
                    appCallerCode, expectedModel);
                return new GatewayModelResolution
                {
                    Success = false,
                    ResolutionType = "NotFound",
                    ExpectedModel = expectedModel,
                    ErrorMessage = $"逻辑模型 {expectedModel?.Trim()} 的独立 Gateway 暂不可用，已拒绝退回旧模型池。",
                };
            }
        }

        var inproc = await _inproc.ResolveModelAsync(appCallerCode, modelType, expectedModel, pinnedPlatformId, pinnedModelId, ct);
        FireResolveCompare(appCallerCode, modelType, expectedModel, pinnedPlatformId, pinnedModelId, inproc, "resolve");
        return inproc;
    }

    public async Task<GatewayModelResolution> ResolveRequiredLogicalModelAsync(
        string appCallerCode,
        string modelType,
        string logicalModelPublicId,
        CancellationToken ct = default)
    {
        // 调用方已经在业务任务中持久化了逻辑模型身份时，不再依赖后台作用域重新查询目录
        // 来猜测它是不是逻辑模型。独立 Gateway 是唯一权威，且其默认接口实现会校验返回
        // LogicalModelPublicId 与 required 完全一致，失败时不会退回 MAP 同名旧池。
        return await _http.ResolveRequiredLogicalModelAsync(
            appCallerCode,
            modelType,
            logicalModelPublicId,
            ct);
    }

    public async Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
        string appCallerCode, string modelType, CancellationToken ct = default)
    {
        if (RouteToHttp(appCallerCode))
            return await _http.GetAvailablePoolsAsync(appCallerCode, modelType, ct);
        var inproc = await _inproc.GetAvailablePoolsAsync(appCallerCode, modelType, ct);
        FirePoolsCompare(appCallerCode, modelType, inproc);
        return inproc;
    }

    /// <summary>
    /// raw（生图/视频/ASR）走预解析 resolution。白名单命中走 http 权威；否则透传 inproc 权威。
    /// 当 ShadowFullSamplePercent 命中时，后台额外发一次 http raw 并落 kind=raw 证据，供 S5/S6 发布门
    /// 验证 multipart/raw 真实跨进程样本；默认 0% 时不双发，避免无意增加图片/ASR/视频成本。
    /// </summary>
    public async Task<GatewayRawResponse> SendRawWithResolutionAsync(
        GatewayRawRequest request, GatewayModelResolution resolution, CancellationToken ct = default)
    {
        if (ContextRequiresLogicalModel(out var contextLogicalModel))
        {
            var requiredLogicalModel = FirstNonBlank(
                contextLogicalModel,
                request.RequiredLogicalModelPublicId,
                resolution.LogicalModelPublicId,
                request.ExpectedModel,
                resolution.ExpectedModel);
            if (string.IsNullOrWhiteSpace(requiredLogicalModel))
            {
                return GatewayRawResponse.Fail(
                    "LOGICAL_MODEL_ID_REQUIRED",
                    "当前业务任务声明为逻辑模型，但缺少逻辑模型公开标识，已拒绝退回旧模型池。",
                    422);
            }

            if (!resolution.Success
                || !string.Equals(
                    requiredLogicalModel,
                    resolution.LogicalModelPublicId?.Trim(),
                    StringComparison.OrdinalIgnoreCase))
            {
                resolution = await _http.ResolveRequiredLogicalModelAsync(
                    request.AppCallerCode,
                    request.ModelType,
                    requiredLogicalModel,
                    ct);
                if (!resolution.Success)
                {
                    return GatewayRawResponse.Fail(
                        "LOGICAL_MODEL_RESOLVE_FAILED",
                        resolution.ErrorMessage ?? $"逻辑模型 {requiredLogicalModel} 解析失败。",
                        503);
                }
            }

            return await _http.SendRawWithResolutionAsync(request, resolution, ct);
        }

        if (RouteToHttp(request.AppCallerCode) || !string.IsNullOrWhiteSpace(resolution.LogicalModelPublicId))
            return await _http.SendRawWithResolutionAsync(request, resolution, ct);

        var inproc = await _inproc.SendRawWithResolutionAsync(request, resolution, ct);
        if (SampleHit(request.AppCallerCode))
            FireRawCompare(request, resolution, inproc);
        return inproc;
    }

    /// <summary>
    /// Runtime profile 测试是管理侧连通性验证，目标就是证明 llmgw-serve 能代表 MAP 触达上游；
    /// shadow 模式下直接以 http 网关为权威，避免继续在 MAP 进程内直连。
    /// </summary>
    public Task<GatewayRawResponse> TestUpstreamProfileAsync(
        GatewayUpstreamProfileTestRequest request,
        CancellationToken ct = default)
        => _http.TestUpstreamProfileAsync(request, ct);

    /// <summary>
    /// 返回绑定到 <c>this</c>（影子）的客户端，使 chat 的 <c>StreamGenerateAsync → ShadowLlmGateway.StreamAsync</c>，
    /// 每条消息做免费 resolve 比对（chat 主链路覆盖）。
    /// </summary>
    public Core.Interfaces.ILLMClient CreateClient(
        string appCallerCode, string modelType, int maxTokens = 4096, double temperature = 0.2,
        bool includeThinking = false, string? expectedModel = null, string? pinnedPlatformId = null, string? pinnedModelId = null)
        => new GatewayLLMClient(
            this, appCallerCode, modelType,
            platformId: null, platformName: null, enablePromptCache: true,
            maxTokens: maxTokens, temperature: temperature, includeThinking: includeThinking,
            contextAccessor: _ctx, expectedModel: expectedModel, pinnedPlatformId: pinnedPlatformId, pinnedModelId: pinnedModelId);

    // ─────────────────────── 后台比对（fire-and-forget，全隔离）───────────────────────

    private bool SampleHit(string appCallerCode)
        => _ctx?.Current?.ForceFullShadowSample == true
           || _fullSampleAllowlist.Contains(appCallerCode)
           || (_fullSamplePercent > 0 && Random.Shared.Next(100) < _fullSamplePercent);

    private void SafeRun(Func<Task> work) => _ = Task.Run(async () =>
    {
        try { await work(); }
        catch (Exception ex) { _logger.LogWarning(ex, "[ShadowLlmGateway] 影子比对后台任务异常（已隔离，不影响主流程）"); }
    });

    private void FireResolveCompare(
        string appCallerCode,
        string modelType,
        string? expectedModel,
        string? pinnedPlatformId,
        string? pinnedModelId,
        GatewayModelResolution? inprocResolution,
        string kind)
    {
        if (_writer == null) return;
        var requestId = _ctx?.Current?.RequestId;
        var tenantId = _ctx?.Current?.TenantId ?? _internalTenantId;
        SafeRun(async () =>
        {
            var sw = Stopwatch.StartNew();
            GatewayModelResolution? httpResolution = null;
            string? httpErr = null;
            try { httpResolution = await _http.ResolveModelAsync(appCallerCode, modelType, expectedModel, pinnedPlatformId, pinnedModelId, CancellationToken.None); }
            catch (Exception ex) { httpErr = ex.Message; }
            sw.Stop();
            var cmp = BuildResolveComparison(tenantId, kind, requestId, appCallerCode, modelType, inprocResolution, httpResolution, httpErr, sw.ElapsedMilliseconds, _releaseCommit);
            await _writer!.RecordAsync(cmp, CancellationToken.None);
        });
    }

    private void FireFullSendCompare(GatewayRequest request, GatewayResponse inproc, string? expectedModel)
    {
        if (_writer == null) return;
        var requestId = _ctx?.Current?.RequestId;
        var tenantId = request.Context?.TenantId ?? _ctx?.Current?.TenantId ?? _internalTenantId;
        // 构造**私有副本**用于 http 全量比对，绝不改调用方仍持有的 request.RequestBody：
        //   - inproc 已把 body["model"] 改写为其选中模型；这里在副本上把 model 恢复成原始有效期望模型
        //     （有则写回、无则移除），让 http 独立解析（与 resolve 探针同根，评审 P2）。
        //   - 用 DeepClone 而非原地改写：后台任务改调用方对象会与调用方复用/读取 body 竞态（Cursor Bugbot）。
        var clonedBody = request.RequestBody?.DeepClone().AsObject();
        if (clonedBody != null)
        {
            if (expectedModel != null) clonedBody["model"] = expectedModel;
            else clonedBody.Remove("model");
        }
        var shadowReq = new GatewayRequest
        {
            AppCallerCode = request.AppCallerCode,
            ModelType = request.ModelType,
            ExpectedModel = request.ExpectedModel,
            PinnedPlatformId = request.PinnedPlatformId,
            PinnedModelId = request.PinnedModelId,
            RequestBody = clonedBody,
            RequestBodyRaw = request.RequestBodyRaw,
            Stream = request.Stream,
            EnablePromptCache = request.EnablePromptCache,
            TimeoutSeconds = request.TimeoutSeconds,
            IncludeThinking = request.IncludeThinking,
            Context = request.Context,
        };
        SafeRun(async () =>
        {
            var sw = Stopwatch.StartNew();
            GatewayResponse? http = null;
            string? httpErr = null;
            try { http = await _http.SendAsync(shadowReq, CancellationToken.None); }
            catch (Exception ex) { httpErr = ex.Message; }
            sw.Stop();
            var cmp = BuildResolveComparison(tenantId, "send", requestId, request.AppCallerCode, request.ModelType,
                inproc.Resolution, http?.Resolution, httpErr, sw.ElapsedMilliseconds, _releaseCommit);
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

    private void FireRawCompare(
        GatewayRawRequest request,
        GatewayModelResolution resolution,
        GatewayRawResponse inproc)
    {
        if (_writer == null) return;
        var requestId = _ctx?.Current?.RequestId;
        var tenantId = request.Context?.TenantId ?? _ctx?.Current?.TenantId ?? _internalTenantId;
        var shadowReq = CloneRawRequest(request);
        SafeRun(async () =>
        {
            var sw = Stopwatch.StartNew();
            GatewayRawResponse? http = null;
            string? httpErr = null;
            try
            {
                http = await _http.SendRawWithResolutionAsync(shadowReq, resolution, CancellationToken.None);
                if (http.Success == false)
                    httpErr = http.ErrorMessage ?? http.ErrorCode ?? $"HTTP raw failed with status {http.StatusCode}";
            }
            catch (Exception ex) { httpErr = ex.Message; }
            sw.Stop();

            var cmp = BuildResolveComparison(
                tenantId,
                "raw",
                requestId,
                request.AppCallerCode,
                request.ModelType,
                inproc.Resolution ?? resolution,
                http?.Resolution,
                httpErr,
                sw.ElapsedMilliseconds,
                _releaseCommit);

            cmp.InprocTextChars = RawSize(inproc);
            cmp.HttpTextChars = http == null ? null : RawSize(http);
            cmp.InprocFinishReason = inproc.Success ? "success" : inproc.ErrorCode ?? "failed";
            cmp.HttpFinishReason = http == null ? null : http.Success ? "success" : http.ErrorCode ?? "failed";

            if (http != null && inproc.Success != http.Success)
            {
                cmp.Mismatches.Add(new FieldMismatch
                {
                    Field = "rawSuccess",
                    Inproc = inproc.Success.ToString(),
                    Http = http.Success.ToString(),
                    Severity = "warning",
                });
            }

            cmp.HasCritical = cmp.Mismatches.Any(m => m.Severity == "critical");
            cmp.AllMatch = cmp.HttpOk && (inproc.Resolution ?? resolution) != null && http?.Resolution != null && cmp.Mismatches.Count == 0;
            await _writer!.RecordAsync(cmp, CancellationToken.None);
        });
    }

    private static GatewayRawRequest CloneRawRequest(GatewayRawRequest request) => new()
    {
        CanonicalImageRequest = request.CanonicalImageRequest,
        RequiredLogicalModelPublicId = request.RequiredLogicalModelPublicId,
        AppCallerCode = request.AppCallerCode,
        ModelType = request.ModelType,
        EndpointPath = request.EndpointPath,
        ExpectedModel = request.ExpectedModel,
        PinnedPlatformId = request.PinnedPlatformId,
        PinnedModelId = request.PinnedModelId,
        RequestBody = request.RequestBody?.DeepClone().AsObject(),
        IsMultipart = request.IsMultipart,
        MultipartFields = request.MultipartFields == null
            ? null
            : new Dictionary<string, object>(request.MultipartFields, StringComparer.Ordinal),
        MultipartFiles = request.MultipartFiles == null
            ? null
            : new Dictionary<string, (string FileName, byte[] Content, string MimeType)>(request.MultipartFiles, StringComparer.Ordinal),
        MultipartFileRefs = request.MultipartFileRefs == null
            ? null
            : new Dictionary<string, MultipartFileRef>(request.MultipartFileRefs, StringComparer.Ordinal),
        HttpMethod = request.HttpMethod,
        ExtraHeaders = request.ExtraHeaders == null
            ? null
            : new Dictionary<string, string>(request.ExtraHeaders, StringComparer.Ordinal),
        TimeoutSeconds = request.TimeoutSeconds,
        ExpectBinaryResponse = request.ExpectBinaryResponse,
        Context = request.Context,
    };

    private static GatewayRequest WithExpectedLogicalModel(GatewayRequest request, string logicalModelPublicId)
        => new()
        {
            AppCallerCode = request.AppCallerCode,
            ModelType = request.ModelType,
            ExpectedModel = logicalModelPublicId,
            PinnedPlatformId = null,
            PinnedModelId = null,
            RequestBody = request.RequestBody?.DeepClone().AsObject(),
            RequestBodyRaw = request.RequestBodyRaw,
            Stream = request.Stream,
            EnablePromptCache = request.EnablePromptCache,
            TimeoutSeconds = request.TimeoutSeconds,
            IncludeThinking = request.IncludeThinking,
            Context = request.Context,
        };

    private static string? FirstNonBlank(params string?[] values)
        => values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))?.Trim();

    private static int RawSize(GatewayRawResponse response)
        => response.BinaryContent?.Length ?? response.Content?.Length ?? 0;

    private void FirePoolsCompare(string appCallerCode, string modelType, List<AvailableModelPool> inproc)
    {
        if (_writer == null) return;
        var requestId = _ctx?.Current?.RequestId;
        var tenantId = _ctx?.Current?.TenantId ?? _internalTenantId;
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
                TenantId = tenantId,
                Kind = "pools", RequestId = requestId, AppCallerCode = appCallerCode, ModelType = modelType,
                ReleaseCommit = _releaseCommit,
                ShadowDurationMs = sw.ElapsedMilliseconds, HttpOk = httpErr == null && http != null, HttpError = httpErr,
            };
            if (cmp.HttpOk)
            {
                var httpPools = http ?? [];
                var a = string.Join(",", inproc.Select(p => p.Id).OrderBy(x => x));
                var b = string.Join(",", httpPools.Select(p => p.Id).OrderBy(x => x));
                if (inproc.Count != httpPools.Count)
                    cmp.Mismatches.Add(new FieldMismatch { Field = "poolCount", Inproc = inproc.Count.ToString(), Http = httpPools.Count.ToString(), Severity = "warning" });
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
        string tenantId, string kind, string? requestId, string appCallerCode, string modelType,
        GatewayModelResolution? inproc, GatewayModelResolution? http, string? httpErr, long ms,
        string? releaseCommit)
    {
        var cmp = new LlmShadowComparison
        {
            TenantId = tenantId,
            Kind = kind, RequestId = requestId, AppCallerCode = appCallerCode, ModelType = modelType,
            ReleaseCommit = releaseCommit,
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
        else if (cmp.HttpOk && (inproc == null || http == null))
        {
            // 一边缺解析（典型：inproc 流因错误/早退从未 yield Start chunk → startResolution=null，
            // 但后台 http resolve 成功）。此时没有可比字段，**绝不能**算 all-match（否则虚高影子证据，
            // T10 会被骗过——Cursor Bugbot）。标一条 presence 不一致，让记录说明「为什么不是 match」。
            cmp.Mismatches.Add(new FieldMismatch
            {
                Field = "resolutionPresence",
                Inproc = inproc == null ? "missing" : "present",
                Http = http == null ? "missing" : "present",
                Severity = "warning",
            });
        }

        cmp.HasCritical = cmp.Mismatches.Any(m => m.Severity == "critical");
        // all-match 必须**两边解析都在**且零不一致；缺一边一律不算 match。
        cmp.AllMatch = cmp.HttpOk && inproc != null && http != null && cmp.Mismatches.Count == 0;
        return cmp;
    }

    private static string? NormalizeCommit(string? value)
    {
        var trimmed = (value ?? string.Empty).Trim();
        if (trimmed.StartsWith("sha-", StringComparison.OrdinalIgnoreCase))
            trimmed = trimmed[4..];
        return string.IsNullOrWhiteSpace(trimmed) ? null : trimmed.ToLowerInvariant();
    }
}
