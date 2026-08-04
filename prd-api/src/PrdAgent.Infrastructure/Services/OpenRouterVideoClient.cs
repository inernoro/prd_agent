using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;

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
    private readonly ILogger<OpenRouterVideoClient> _logger;
    private readonly ILLMRequestContextAccessor? _contextAccessor;
    private readonly ILlmRequestLogWriter? _logWriter;
    // 缓存 SubmitAsync 阶段的解析结果，供同一 Scoped 实例的轮询调用复用（避免每次 poll 都查一次 DB）
    private GatewayModelResolution? _submitResolution;
    private string? _submitAppCallerCode;

    public OpenRouterVideoClient(
        ILlmGateway gateway,
        IHttpClientFactory httpClientFactory,
        ILogger<OpenRouterVideoClient> logger,
        ILLMRequestContextAccessor? contextAccessor = null,
        ILlmRequestLogWriter? logWriter = null)
    {
        _gateway = gateway;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _contextAccessor = contextAccessor;
        _logWriter = logWriter;
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
                ErrorMessage = (resolution.ErrorMessage ?? "未配置可用的视频生成模型池。")
                    + "\n请在「模型池管理」中创建一个类型为「视频生成」的模型池，添加 OpenRouter 视频模型（如 alibaba/wan-2.6）。"
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
                ErrorMessage = QuotaOrUpstreamMessage(rawResp)
            };
        }

        var doc = JsonNode.Parse(rawResp.Content)?.AsObject();
        var jobId = doc?["id"]?.GetValue<string>() ?? doc?["generation_id"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(jobId))
        {
            return new OpenRouterVideoSubmitResult
            {
                Success = false,
                ErrorMessage = "OpenRouter 响应缺少 id 字段"
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

        // 缓存解析结果供后续轮询复用（同一 Scoped 实例负责 submit + N 次 poll）
        _submitResolution = resolution;
        _submitAppCallerCode = request.AppCallerCode;

        return new OpenRouterVideoSubmitResult
        {
            Success = true,
            JobId = jobId,
            Cost = cost,
            ActualModel = resolution.ActualModel,
            ActualDurationSeconds = actualDuration,
        };
    }

    public async Task<OpenRouterVideoStatus> GetStatusAsync(
        string appCallerCode,
        string jobId,
        string? expectedModel = null,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(jobId))
        {
            return new OpenRouterVideoStatus { Status = "failed", ErrorMessage = "jobId 不能为空" };
        }

        // 优先复用 SubmitAsync 已算好的解析结果，避免每次轮询都查一次 DB
        // 仅在 appCallerCode 匹配时复用缓存，防止跨上下文重用错误的解析结果
        var statusResolution = (_submitResolution?.Success == true && _submitAppCallerCode == appCallerCode)
            ? _submitResolution
            : await _gateway.ResolveModelAsync(appCallerCode, ModelTypes.VideoGen, expectedModel, ct: ct);
        if (!statusResolution.Success)
            return new OpenRouterVideoStatus { Status = "failed", ErrorMessage = statusResolution.ErrorMessage };

        var statusBody = IsVolcengineVideoResolution(statusResolution)
            ? new JsonObject
            {
                ["_gateway_operation"] = "status",
                ["task_id"] = jobId
            }
            : null;

        var rawResp = await _gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
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
                ErrorMessage = QuotaOrUpstreamMessage(rawResp)
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
            ErrorMessage = errMsg,
            Cost = ReadCost(doc)
        };
    }

    public async Task<OpenRouterVideoDownload> DownloadVideoBytesAsync(
        string appCallerCode,
        string jobId,
        int urlIndex = 0,
        string? expectedModel = null,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(jobId))
            return new OpenRouterVideoDownload { Success = false, ErrorMessage = "jobId 不能为空" };

        // 复用已有 resolution，避免重复查 DB
        var resolution = (_submitResolution?.Success == true && _submitAppCallerCode == appCallerCode)
            ? _submitResolution
            : await _gateway.ResolveModelAsync(appCallerCode, ModelTypes.VideoGen, expectedModel, ct: ct);
        if (!resolution.Success)
            return new OpenRouterVideoDownload { Success = false, ErrorMessage = resolution.ErrorMessage };

        if (IsVolcengineVideoResolution(resolution))
        {
            var status = await GetStatusAsync(appCallerCode, jobId, expectedModel, ct);
            if (!status.IsCompleted || string.IsNullOrWhiteSpace(status.VideoUrl))
            {
                return new OpenRouterVideoDownload
                {
                    Success = false,
                    ErrorMessage = status.ErrorMessage ?? $"视频任务尚未完成，status={status.Status}"
                };
            }

            return await DownloadSignedVideoUrlAsync(status.VideoUrl, ct);
        }

        // OpenRouter 视频下载端点：GET /videos/{jobId}/content?index={i}
        // 通过 Gateway 走，自动注入 ApiKey + base URL
        var rawResp = await _gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
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
            // 诊断信息进 error（随 run 落库，跨副本可读）：标称类型 + 二进制/文本长度，便于定位下载落空原因
            var diag = $"ct={rawResp.ContentType}, binLen={rawResp.BinaryContent?.Length ?? 0}, textLen={rawResp.Content?.Length ?? 0}";
            // 与 submit/status 一致：额度耗尽时用 Gateway 友好文案(LLM_QUOTA_EXCEEDED)，其余保留 code/状态，再附诊断（Bugbot review）
            return new OpenRouterVideoDownload
            {
                Success = false,
                ErrorMessage = $"{QuotaOrUpstreamMessage(rawResp)} ({diag})",
            };
        }

        return new OpenRouterVideoDownload
        {
            Success = true,
            Bytes = rawResp.BinaryContent,
            ContentType = "video/mp4",
        };
    }

    private async Task<OpenRouterVideoDownload> DownloadSignedVideoUrlAsync(string videoUrl, CancellationToken ct)
    {
        if (!Uri.TryCreate(videoUrl, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https"))
        {
            return new OpenRouterVideoDownload
            {
                Success = false,
                ErrorMessage = "视频结果 URL 非法，无法下载。"
            };
        }

        try
        {
            using var http = _httpClientFactory.CreateClient();
            http.Timeout = TimeSpan.FromSeconds(120);
            using var resp = await http.GetAsync(uri, ct);
            var bytes = await resp.Content.ReadAsByteArrayAsync(ct);
            if (!resp.IsSuccessStatusCode || bytes.Length == 0)
            {
                return new OpenRouterVideoDownload
                {
                    Success = false,
                    ErrorMessage = $"视频签名 URL 下载失败: HTTP {(int)resp.StatusCode}"
                };
            }

            return new OpenRouterVideoDownload
            {
                Success = true,
                Bytes = bytes,
                ContentType = resp.Content.Headers.ContentType?.MediaType ?? "video/mp4",
            };
        }
        catch (Exception ex)
        {
            return new OpenRouterVideoDownload
            {
                Success = false,
                ErrorMessage = $"视频签名 URL 下载异常: {ex.Message}"
            };
        }
    }

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

    private static string? ExtractErrorMessage(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        try
        {
            var doc = JsonNode.Parse(body)?.AsObject();
            if (doc == null) return null;
            var err = doc["error"];
            if (err is JsonObject errObj)
            {
                return errObj["message"]?.GetValue<string>() ?? errObj.ToJsonString();
            }
            return err?.ToString();
        }
        catch
        {
            return Truncate(body, 200);
        }
    }

    // 额度用尽时优先用 Gateway 已构造的中文友好文案(LLM_QUOTA_EXCEEDED)，让「动起来」等视频路径与拆分镜
    // 走同一套额度提示 + admin 告警；其余错误保留 /videos 端点特定的上游 message 解析（Bugbot review）。
    private static string QuotaOrUpstreamMessage(GatewayRawResponse rawResp)
    {
        if (rawResp.ErrorCode == "LLM_QUOTA_EXCEEDED" && !string.IsNullOrWhiteSpace(rawResp.ErrorMessage))
            return rawResp.ErrorMessage!;
        return ExtractErrorMessage(rawResp.Content ?? string.Empty)
            ?? rawResp.ErrorMessage
            ?? rawResp.ErrorCode
            ?? $"HTTP {rawResp.StatusCode}";
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max] + "…";
}
