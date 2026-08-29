using System.Text.Json.Nodes;
using System.Net.Http.Headers;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// OpenRouter 视频生成 API 客户端
/// 走 ILlmGateway.SendRawWithResolutionAsync，利用平台管理中配好的 ApiKey + BaseUrl，
/// 不依赖 IConfiguration / 环境变量。
/// </summary>
public class OpenRouterVideoClient : IOpenRouterVideoClient
{
    private readonly ILlmGateway _gateway;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ISafeOutboundUrlValidator _urlValidator;
    private readonly ILogger<OpenRouterVideoClient> _logger;
    private readonly ILLMRequestContextAccessor? _contextAccessor;
    private readonly ILlmRequestLogWriter? _logWriter;
    private readonly string? _openRouterReferer;
    // 缓存 SubmitAsync 阶段的解析结果，供同一 Scoped 实例的轮询调用复用（避免每次 poll 都查一次 DB）
    private GatewayModelResolution? _submitResolution;
    private string? _submitAppCallerCode;

    public OpenRouterVideoClient(
        ILlmGateway gateway,
        IHttpClientFactory httpClientFactory,
        ISafeOutboundUrlValidator urlValidator,
        ILogger<OpenRouterVideoClient> logger,
        ILLMRequestContextAccessor? contextAccessor = null,
        ILlmRequestLogWriter? logWriter = null,
        IConfiguration? configuration = null)
    {
        _gateway = gateway;
        _httpClientFactory = httpClientFactory;
        _urlValidator = urlValidator;
        _logger = logger;
        _contextAccessor = contextAccessor;
        _logWriter = logWriter;
        _openRouterReferer = OpenRouterAttribution.ResolveReferer(configuration);
    }

    public async Task<OpenRouterVideoSubmitResult> SubmitAsync(OpenRouterVideoSubmitRequest request, CancellationToken ct = default)
    {
        // 预解析模型池，拿到实际模型 id（用户未指定时由池决定）
        var resolution = await _gateway.ResolveModelAsync(
            appCallerCode: request.AppCallerCode,
            modelType: ModelTypes.VideoGen,
            expectedModel: request.Model,
            ct: ct);

        if (!resolution.Success || string.IsNullOrWhiteSpace(resolution.ActualModel))
        {
            return new OpenRouterVideoSubmitResult
            {
                Success = false,
                ErrorMessage = VideoGenerationUserError.ServiceUnavailable()
            };
        }

        var actualDuration = VideoModelCapabilities.NormalizeDuration(
            resolution.ActualModel,
            request.DurationSeconds);
        if (request.DurationSeconds.HasValue && actualDuration != request.DurationSeconds)
        {
            _logger.LogInformation(
                "视频时长已按模型能力调整: model={Model}, requested={Requested}s, actual={Actual}s",
                resolution.ActualModel,
                request.DurationSeconds,
                actualDuration);
        }

        var body = new JsonObject
        {
            ["model"] = resolution.ActualModel,
            ["prompt"] = request.Prompt
        };
        var frameImages = new JsonArray();
        if (!string.IsNullOrWhiteSpace(request.FirstFrameImageUrl))
        {
            frameImages.Add(new JsonObject
            {
                ["type"] = "image_url",
                ["image_url"] = new JsonObject { ["url"] = request.FirstFrameImageUrl },
                ["frame_type"] = "first_frame"
            });
        }
        if (!string.IsNullOrWhiteSpace(request.LastFrameImageUrl))
        {
            frameImages.Add(new JsonObject
            {
                ["type"] = "image_url",
                ["image_url"] = new JsonObject { ["url"] = request.LastFrameImageUrl },
                ["frame_type"] = "last_frame"
            });
        }
        foreach (var url in request.ReferenceImageUrls?.Where(url => !string.IsNullOrWhiteSpace(url)).Take(9) ?? [])
        {
            frameImages.Add(new JsonObject
            {
                ["type"] = "image_url",
                ["image_url"] = new JsonObject { ["url"] = url },
                ["frame_type"] = "reference_image"
            });
        }
        if (frameImages.Count > 0) body["frame_images"] = frameImages;
        if (!string.IsNullOrWhiteSpace(request.AspectRatio)) body["aspect_ratio"] = request.AspectRatio;
        if (!string.IsNullOrWhiteSpace(request.Resolution)) body["resolution"] = request.Resolution;
        if (actualDuration.HasValue) body["duration"] = actualDuration.Value;
        if (request.GenerateAudio.HasValue) body["generate_audio"] = request.GenerateAudio.Value;
        if (request.Seed.HasValue) body["seed"] = request.Seed.Value;

        var rawResp = await _gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = request.AppCallerCode,
            ModelType = ModelTypes.VideoGen,
            EndpointPath = "/videos",
            RequestBody = body,
            HttpMethod = "POST",
            TimeoutSeconds = 60,
            Context = BuildContext(request.RequestId, request.UserId, request.Prompt, providerTaskId: null)
        }, resolution, ct);

        if (!rawResp.Success || string.IsNullOrWhiteSpace(rawResp.Content))
        {
            _logger.LogWarning("OpenRouter 视频提交失败 status={Status} errCode={Code} body={Body}",
                rawResp.StatusCode, rawResp.ErrorCode, Truncate(rawResp.Content ?? string.Empty, 500));
            return new OpenRouterVideoSubmitResult
            {
                Success = false,
                ErrorMessage = VideoGenerationUserError.FromGateway(rawResp)
            };
        }

        var doc = JsonNode.Parse(rawResp.Content)?.AsObject();
        var jobId = doc?["id"]?.GetValue<string>() ?? doc?["generation_id"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(jobId))
        {
            return new OpenRouterVideoSubmitResult
            {
                Success = false,
                ErrorMessage = VideoGenerationUserError.ServiceUnavailable()
            };
        }

        if (!string.IsNullOrWhiteSpace(rawResp.LogId) && _logWriter is not null)
        {
            await _logWriter.BindProviderTaskAsync(
                rawResp.LogId,
                jobId,
                fallbackLogicalRequestId: jobId,
                ct: ct);
        }

        double? cost = ReadCost(doc);

        // 发送阶段可能切换到备用 Offering；后续轮询必须跟随真正成功的路由，
        // 不能继续使用提交前的首选解析结果。
        var effectiveResolution = rawResp.Resolution ?? resolution;
        _submitResolution = effectiveResolution;
        _submitAppCallerCode = request.AppCallerCode;

        return new OpenRouterVideoSubmitResult
        {
            Success = true,
            JobId = jobId,
            Cost = cost,
            ActualModel = effectiveResolution.ActualModel,
            OfferingId = effectiveResolution.OfferingId,
            ActualDurationSeconds = actualDuration,
        };
    }

    public Task<OpenRouterVideoStatus> GetStatusAsync(
        string appCallerCode,
        string jobId,
        string? expectedModel = null,
        CancellationToken ct = default)
        => GetStatusForOfferingAsync(appCallerCode, jobId, expectedModel, null, ct);

    public async Task<OpenRouterVideoStatus> GetStatusForOfferingAsync(
        string appCallerCode,
        string jobId,
        string? expectedModel,
        string? offeringId,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(jobId))
        {
            return new OpenRouterVideoStatus { Status = "failed", ErrorMessage = "jobId 不能为空" };
        }

        // 优先复用 SubmitAsync 已算好的解析结果，避免每次轮询都查一次 DB
        // 仅在 appCallerCode 匹配时复用缓存，防止跨上下文重用错误的解析结果
        var statusResolution = (_submitResolution?.Success == true
                                && _submitAppCallerCode == appCallerCode
                                && (string.IsNullOrWhiteSpace(offeringId)
                                    || string.Equals(_submitResolution.OfferingId, offeringId, StringComparison.Ordinal)))
            ? _submitResolution
            : !string.IsNullOrWhiteSpace(offeringId)
                ? await _gateway.ResolveOfferingAsync(appCallerCode, ModelTypes.VideoGen, offeringId, ct)
                : await _gateway.ResolveModelAsync(appCallerCode, ModelTypes.VideoGen, expectedModel, ct: ct);
        if (!statusResolution.Success)
            return new OpenRouterVideoStatus { Status = "failed", ErrorMessage = VideoGenerationUserError.ServiceUnavailable() };

        var statusBody = IsVolcengineVideoResolution(statusResolution)
            ? new JsonObject
            {
                ["_gateway_operation"] = "status",
                ["task_id"] = jobId
            }
            : null;

        var rawResp = await _gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            RequiredOfferingId = offeringId,
            AppCallerCode = appCallerCode,
            ModelType = ModelTypes.VideoGen,
            EndpointPath = $"/videos/{Uri.EscapeDataString(jobId)}",
            RequestBody = statusBody,
            HttpMethod = "GET",
            TimeoutSeconds = 30,
            Context = BuildContext(requestId: null, userId: null, questionText: null, providerTaskId: jobId)
        }, statusResolution, ct);

        if (!rawResp.Success || string.IsNullOrWhiteSpace(rawResp.Content))
        {
            return new OpenRouterVideoStatus
            {
                Status = "failed",
                ErrorMessage = VideoGenerationUserError.FromGateway(rawResp)
            };
        }

        var doc = JsonNode.Parse(rawResp.Content)?.AsObject();
        var status = doc?["status"]?.GetValue<string>()?.ToLowerInvariant() ?? "pending";

        string? videoUrl = null;
        if (doc?["unsigned_urls"] is JsonArray urls && urls.Count > 0)
        {
            videoUrl = urls[0]?.GetValue<string>();
        }

        string? errMsg = null;
        if (doc?["error"] is JsonNode errNode)
        {
            errMsg = errNode is JsonObject errObj
                ? errObj["message"]?.GetValue<string>() ?? errObj.ToJsonString()
                : errNode.ToString();
        }

        return new OpenRouterVideoStatus
        {
            Status = status,
            VideoUrl = videoUrl,
            ErrorMessage = string.IsNullOrWhiteSpace(errMsg)
                ? null
                : VideoGenerationUserError.FromDiagnostic(errMsg),
            Cost = ReadCost(doc)
        };
    }

    public Task<OpenRouterVideoDownload> DownloadVideoBytesAsync(
        string appCallerCode,
        string jobId,
        int urlIndex = 0,
        string? expectedModel = null,
        CancellationToken ct = default)
        => DownloadVideoBytesForOfferingAsync(appCallerCode, jobId, urlIndex, expectedModel, null, ct);

    public async Task<OpenRouterVideoDownload> DownloadVideoBytesForOfferingAsync(
        string appCallerCode,
        string jobId,
        int urlIndex,
        string? expectedModel,
        string? offeringId,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(jobId))
            return new OpenRouterVideoDownload { Success = false, ErrorMessage = "jobId 不能为空" };

        // 复用已有 resolution，避免重复查 DB
        var resolution = (_submitResolution?.Success == true
                          && _submitAppCallerCode == appCallerCode
                          && (string.IsNullOrWhiteSpace(offeringId)
                              || string.Equals(_submitResolution.OfferingId, offeringId, StringComparison.Ordinal)))
            ? _submitResolution
            : !string.IsNullOrWhiteSpace(offeringId)
                ? await _gateway.ResolveOfferingAsync(appCallerCode, ModelTypes.VideoGen, offeringId, ct)
                : await _gateway.ResolveModelAsync(appCallerCode, ModelTypes.VideoGen, expectedModel, ct: ct);
        if (!resolution.Success)
            return new OpenRouterVideoDownload { Success = false, ErrorMessage = VideoGenerationUserError.DownloadUnavailable() };

        if (IsVolcengineVideoResolution(resolution))
        {
            var status = await GetStatusForOfferingAsync(appCallerCode, jobId, expectedModel, offeringId, ct);
            if (!status.IsCompleted || string.IsNullOrWhiteSpace(status.VideoUrl))
            {
                return new OpenRouterVideoDownload
                {
                    Success = false,
                    ErrorMessage = status.ErrorMessage ?? "视频仍在生成中，请稍后重试"
                };
            }

            return await DownloadSignedVideoUrlAsync(status.VideoUrl, ct);
        }

        return await DownloadOpenRouterVideoBytesWithResolutionAsync(
            appCallerCode,
            jobId,
            urlIndex,
            offeringId,
            resolution,
            ct);
    }

    private async Task<OpenRouterVideoDownload> DownloadOpenRouterVideoBytesWithResolutionAsync(
        string appCallerCode,
        string jobId,
        int urlIndex,
        string? offeringId,
        GatewayModelResolution resolution,
        CancellationToken ct)
    {
        // OpenRouter 视频下载端点：GET /videos/{jobId}/content?index={i}
        // 通过 Gateway 走，自动注入 ApiKey + base URL。
        var rawResp = await _gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            RequiredOfferingId = offeringId,
            AppCallerCode = appCallerCode,
            ModelType = ModelTypes.VideoGen,
            EndpointPath = $"/videos/{Uri.EscapeDataString(jobId)}/content?index={urlIndex}",
            HttpMethod = "GET",
            TimeoutSeconds = 120, // 视频文件可能较大
            Context = BuildContext(requestId: null, userId: null, questionText: null, providerTaskId: jobId),
            // OpenRouter 此端点回 mp4 字节，却把 Content-Type 标成 application/json，
            // 不强制二进制会被按字符串读取损坏 → binaryContent 为空 → 误判「HTTP 200 下载失败」。
            ExpectBinaryResponse = true,
        }, resolution, ct);

        if (!rawResp.Success || rawResp.BinaryContent == null || rawResp.BinaryContent.Length == 0)
        {
            var diag = $"ct={rawResp.ContentType}, binLen={rawResp.BinaryContent?.Length ?? 0}, textLen={rawResp.Content?.Length ?? 0}";
            _logger.LogWarning(
                "视频下载失败 status={Status} errorCode={ErrorCode} diagnostic={Diagnostic}",
                rawResp.StatusCode,
                rawResp.ErrorCode,
                diag);
            return new OpenRouterVideoDownload
            {
                Success = false,
                ErrorMessage = VideoGenerationUserError.DownloadUnavailable(),
            };
        }

        return new OpenRouterVideoDownload
        {
            Success = true,
            Bytes = rawResp.BinaryContent,
            ContentType = "video/mp4",
        };
    }

    public async Task<OpenRouterVideoStream> OpenVideoStreamForOfferingAsync(
        string appCallerCode,
        string jobId,
        int urlIndex,
        string? expectedModel,
        string? offeringId,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(jobId))
            return OpenRouterVideoStream.Fail("视频任务标识为空，请返回视频页面重新打开任务");

        var resolution = (_submitResolution?.Success == true
                          && _submitAppCallerCode == appCallerCode
                          && (string.IsNullOrWhiteSpace(offeringId)
                              || string.Equals(_submitResolution.OfferingId, offeringId, StringComparison.Ordinal)))
            ? _submitResolution
            : !string.IsNullOrWhiteSpace(offeringId)
                ? await _gateway.ResolveOfferingAsync(appCallerCode, ModelTypes.VideoGen, offeringId, ct)
                : await _gateway.ResolveModelAsync(appCallerCode, ModelTypes.VideoGen, expectedModel, ct: ct);
        if (!resolution.Success)
            return OpenRouterVideoStream.Fail(VideoGenerationUserError.DownloadUnavailable());

        if (IsVolcengineVideoResolution(resolution))
        {
            var status = await GetStatusForOfferingAsync(appCallerCode, jobId, expectedModel, offeringId, ct);
            if (!status.IsCompleted || string.IsNullOrWhiteSpace(status.VideoUrl))
                return OpenRouterVideoStream.Fail(status.ErrorMessage ?? "视频仍在生成中，请稍后重试");
            return await OpenHttpVideoStreamAsync(status.VideoUrl, null, appCallerCode, ct);
        }

        if (string.IsNullOrWhiteSpace(resolution.ApiUrl) || string.IsNullOrWhiteSpace(resolution.ApiKey))
        {
            // HTTP LLMGW 拓扑不会把上游 ApiKey 回传给 MAP。复用已经解析好的 resolution
            // 让 Serving 注入密钥并获取二进制，避免下载阶段再次解析或要求 MAP 持有明文 Key。
            var downloaded = await DownloadOpenRouterVideoBytesWithResolutionAsync(
                appCallerCode,
                jobId,
                urlIndex,
                offeringId,
                resolution,
                ct);
            if (!downloaded.Success || downloaded.Bytes is not { Length: > 0 })
                return OpenRouterVideoStream.Fail(downloaded.ErrorMessage ?? VideoGenerationUserError.DownloadUnavailable());

            var buffered = new MemoryStream(downloaded.Bytes, writable: false);
            return OpenRouterVideoStream.Ok(
                buffered,
                downloaded.ContentType ?? "video/mp4",
                downloaded.Bytes.LongLength,
                buffered);
        }

        var endpoint = BuildEndpointFromPath(
            resolution.ApiUrl,
            $"/videos/{Uri.EscapeDataString(jobId)}/content?index={urlIndex}");
        return await OpenHttpVideoStreamAsync(endpoint, resolution.ApiKey, appCallerCode, ct);
    }

    private async Task<OpenRouterVideoStream> OpenHttpVideoStreamAsync(
        string videoUrl,
        string? apiKey,
        string appCallerCode,
        CancellationToken ct)
    {
        try
        {
            var opened = await SendSafeVideoGetAsync(videoUrl, apiKey, appCallerCode, ct);
            if (!opened.Response.IsSuccessStatusCode)
            {
                _logger.LogWarning(
                    "视频流打开失败 status={StatusCode} host={Host}",
                    (int)opened.Response.StatusCode,
                    opened.Uri.Host);
                opened.Dispose();
                return OpenRouterVideoStream.Fail("视频已经生成，但下载服务暂时不可用，请稍后重试");
            }

            var stream = await opened.Response.Content.ReadAsStreamAsync(ct);
            var upstreamContentType = opened.Response.Content.Headers.ContentType?.MediaType;
            return OpenRouterVideoStream.Ok(
                stream,
                upstreamContentType?.StartsWith("video/", StringComparison.OrdinalIgnoreCase) == true
                    ? upstreamContentType
                    : "video/mp4",
                opened.Response.Content.Headers.ContentLength,
                opened);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "视频流连接或地址校验异常");
            return OpenRouterVideoStream.Fail("视频下载连接中断，请稍后重试");
        }
    }

    private static string BuildEndpointFromPath(string apiUrl, string endpointPath)
    {
        var baseUrl = apiUrl.TrimEnd('/');
        var hasVersionSuffix = System.Text.RegularExpressions.Regex.IsMatch(
            baseUrl,
            @"/(api/)?v\d+$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (hasVersionSuffix)
        {
            if (endpointPath.StartsWith("/v1/", StringComparison.OrdinalIgnoreCase))
                endpointPath = endpointPath[3..];
            return $"{baseUrl}{(endpointPath.StartsWith('/') ? "" : "/")}{endpointPath}";
        }
        return $"{baseUrl}/v1{(endpointPath.StartsWith('/') ? "" : "/")}{endpointPath}";
    }

    private sealed class SafeVideoResponse : IDisposable
    {
        private readonly HttpClient _http;
        private readonly HttpRequestMessage _request;

        public SafeVideoResponse(
            HttpClient http,
            HttpRequestMessage request,
            HttpResponseMessage response,
            Uri uri)
        {
            _http = http;
            _request = request;
            Response = response;
            Uri = uri;
        }

        public HttpResponseMessage Response { get; }
        public Uri Uri { get; }

        public void Dispose()
        {
            Response.Dispose();
            _request.Dispose();
            _http.Dispose();
        }
    }

    private async Task<OpenRouterVideoDownload> DownloadSignedVideoUrlAsync(string videoUrl, CancellationToken ct)
    {
        try
        {
            using var opened = await SendSafeVideoGetAsync(videoUrl, null, string.Empty, ct);
            var bytes = await opened.Response.Content.ReadAsByteArrayAsync(ct);
            if (!opened.Response.IsSuccessStatusCode || bytes.Length == 0)
            {
                return new OpenRouterVideoDownload
                {
                    Success = false,
                    ErrorMessage = "视频已经生成，但下载服务暂时不可用，请稍后重试"
                };
            }

            return new OpenRouterVideoDownload
            {
                Success = true,
                Bytes = bytes,
                ContentType = opened.Response.Content.Headers.ContentType?.MediaType ?? "video/mp4",
            };
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "视频签名地址下载或安全校验失败");
            return new OpenRouterVideoDownload
            {
                Success = false,
                ErrorMessage = "视频下载地址不可用，请稍后重试或重新生成"
            };
        }
    }

    private async Task<SafeVideoResponse> SendSafeVideoGetAsync(
        string videoUrl,
        string? apiKey,
        string appCallerCode,
        CancellationToken ct)
    {
        var isProviderReturnedUrl = string.IsNullOrWhiteSpace(apiKey);
        var current = isProviderReturnedUrl
            ? await _urlValidator.EnsureSafeHttpUrlAsync(videoUrl, "视频下载地址", ct)
            : Uri.TryCreate(videoUrl, UriKind.Absolute, out var configuredEndpoint)
              && configuredEndpoint.Scheme is "http" or "https"
                ? configuredEndpoint
                : throw new InvalidOperationException("视频下载地址格式无效");
        // 供应商返回的 URL 使用禁止自动重定向且带 DNS 绑定校验的专用客户端。
        // 管理员配置的 Gateway 端点保持既有客户端，以兼容受控内网部署。
        var http = _httpClientFactory.CreateClient(isProviderReturnedUrl ? "SafeOutbound" : string.Empty);
        http.Timeout = TimeSpan.FromSeconds(120);

        try
        {
            for (var redirectCount = 0; redirectCount <= 5; redirectCount++)
            {
                var request = new HttpRequestMessage(HttpMethod.Get, current);
                if (!string.IsNullOrWhiteSpace(apiKey))
                    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
                if (current.Host.Equals("openrouter.ai", StringComparison.OrdinalIgnoreCase))
                {
                    OpenRouterAttribution.Apply(request, current.ToString(), appCallerCode, _openRouterReferer);
                }

                var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
                if (!IsRedirect(response.StatusCode) || response.Headers.Location is null)
                    return new SafeVideoResponse(http, request, response, current);

                // 认证下载端点不跨地址转发凭据；供应商签名 URL 的每一跳都重新做 DNS/IP 校验。
                if (!string.IsNullOrWhiteSpace(apiKey) || redirectCount == 5)
                {
                    response.Dispose();
                    request.Dispose();
                    throw new InvalidOperationException("视频下载地址重定向不可用");
                }

                var redirected = response.Headers.Location.IsAbsoluteUri
                    ? response.Headers.Location
                    : new Uri(current, response.Headers.Location);
                response.Dispose();
                request.Dispose();
                current = await _urlValidator.EnsureSafeHttpUrlAsync(
                    redirected.ToString(),
                    "视频下载重定向地址",
                    ct);
            }
        }
        catch
        {
            http.Dispose();
            throw;
        }

        http.Dispose();
        throw new InvalidOperationException("视频下载地址重定向次数过多");
    }

    private static bool IsRedirect(System.Net.HttpStatusCode statusCode)
        => statusCode is System.Net.HttpStatusCode.MovedPermanently
            or System.Net.HttpStatusCode.Redirect
            or System.Net.HttpStatusCode.RedirectMethod
            or System.Net.HttpStatusCode.TemporaryRedirect
            or System.Net.HttpStatusCode.PermanentRedirect;

    private GatewayRequestContext BuildContext(
        string? requestId,
        string? userId,
        string? questionText,
        string? providerTaskId)
    {
        var current = _contextAccessor?.Current;
        return new GatewayRequestContext
        {
            TenantId = current?.TenantId,
            TeamId = current?.TeamId,
            ServiceKeyId = current?.ServiceKeyId,
            ClientCode = current?.ClientCode,
            Environment = current?.Environment,
            ServiceKeyPrefix = current?.ServiceKeyPrefix,
            RequestId = requestId,
            SessionId = current?.SessionId,
            RunId = current?.RunId,
            LogicalRequestId = current?.LogicalRequestId
                ?? current?.RunId
                ?? current?.SessionId
                ?? requestId
                ?? providerTaskId,
            ProviderTaskId = providerTaskId,
            GroupId = current?.GroupId,
            UserId = userId ?? current?.UserId,
            ViewRole = current?.ViewRole,
            DocumentChars = current?.DocumentChars,
            DocumentHash = current?.DocumentHash,
            QuestionText = questionText,
            SystemPromptText = current?.SystemPromptRedacted,
            GatewayTransport = current?.GatewayTransport,
            IsHealthProbe = current?.IsHealthProbe,
        };
    }
    private static bool IsVolcengineVideoResolution(GatewayModelResolution resolution)
        => resolution.IsExchange
           && string.Equals(resolution.ExchangeTransformerType, "volcengine-video", StringComparison.OrdinalIgnoreCase);

    private static double? ReadCost(JsonObject? doc)
    {
        if (doc?["usage"] is JsonObject usage && usage["cost"] is JsonNode costNode)
        {
            try { return costNode.GetValue<double>(); } catch { /* ignore */ }
        }
        return null;
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max] + "…";
}
