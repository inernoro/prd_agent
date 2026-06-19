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
    private readonly ILogger<OpenRouterVideoClient> _logger;
    // 缓存 SubmitAsync 阶段的解析结果，供同一 Scoped 实例的轮询调用复用（避免每次 poll 都查一次 DB）
    private GatewayModelResolution? _submitResolution;
    private string? _submitAppCallerCode;

    public OpenRouterVideoClient(ILlmGateway gateway, ILogger<OpenRouterVideoClient> logger)
    {
        _gateway = gateway;
        _logger = logger;
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

        var body = new JsonObject
        {
            ["model"] = resolution.ActualModel,
            ["prompt"] = request.Prompt
        };
        // 图生视频：把首帧图作为 first_frame 传给视频模型（OpenRouter /videos frame_images 协议）
        if (!string.IsNullOrWhiteSpace(request.FirstFrameImageUrl))
        {
            body["frame_images"] = new JsonArray
            {
                new JsonObject
                {
                    ["type"] = "image_url",
                    ["image_url"] = new JsonObject { ["url"] = request.FirstFrameImageUrl },
                    ["frame_type"] = "first_frame"
                }
            };
        }
        if (!string.IsNullOrWhiteSpace(request.AspectRatio)) body["aspect_ratio"] = request.AspectRatio;
        if (!string.IsNullOrWhiteSpace(request.Resolution)) body["resolution"] = request.Resolution;
        if (request.DurationSeconds.HasValue) body["duration"] = request.DurationSeconds.Value;
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
            Context = new GatewayRequestContext
            {
                RequestId = request.RequestId,
                UserId = request.UserId,
                QuestionText = request.Prompt
            }
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

        double? cost = ReadCost(doc);

        // 缓存解析结果供后续轮询复用（同一 Scoped 实例负责 submit + N 次 poll）
        _submitResolution = resolution;
        _submitAppCallerCode = request.AppCallerCode;

        return new OpenRouterVideoSubmitResult
        {
            Success = true,
            JobId = jobId,
            Cost = cost,
            ActualModel = resolution.ActualModel
        };
    }

    public async Task<OpenRouterVideoStatus> GetStatusAsync(string appCallerCode, string jobId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(jobId))
        {
            return new OpenRouterVideoStatus { Status = "failed", ErrorMessage = "jobId 不能为空" };
        }

        // 优先复用 SubmitAsync 已算好的解析结果，避免每次轮询都查一次 DB
        // 仅在 appCallerCode 匹配时复用缓存，防止跨上下文重用错误的解析结果
        var statusResolution = (_submitResolution?.Success == true && _submitAppCallerCode == appCallerCode)
            ? _submitResolution
            : await _gateway.ResolveModelAsync(appCallerCode, ModelTypes.VideoGen, null, ct);
        if (!statusResolution.Success)
            return new OpenRouterVideoStatus { Status = "failed", ErrorMessage = statusResolution.ErrorMessage };

        var rawResp = await _gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = appCallerCode,
            ModelType = ModelTypes.VideoGen,
            EndpointPath = $"/videos/{Uri.EscapeDataString(jobId)}",
            HttpMethod = "GET",
            TimeoutSeconds = 30
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

    public async Task<OpenRouterVideoDownload> DownloadVideoBytesAsync(string appCallerCode, string jobId, int urlIndex = 0, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(jobId))
            return new OpenRouterVideoDownload { Success = false, ErrorMessage = "jobId 不能为空" };

        // 复用已有 resolution，避免重复查 DB
        var resolution = (_submitResolution?.Success == true && _submitAppCallerCode == appCallerCode)
            ? _submitResolution
            : await _gateway.ResolveModelAsync(appCallerCode, ModelTypes.VideoGen, null, ct);
        if (!resolution.Success)
            return new OpenRouterVideoDownload { Success = false, ErrorMessage = resolution.ErrorMessage };

        // OpenRouter 视频下载端点：GET /videos/{jobId}/content?index={i}
        // 通过 Gateway 走，自动注入 ApiKey + base URL
        var rawResp = await _gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = appCallerCode,
            ModelType = ModelTypes.VideoGen,
            EndpointPath = $"/videos/{Uri.EscapeDataString(jobId)}/content?index={urlIndex}",
            HttpMethod = "GET",
            TimeoutSeconds = 120, // 视频文件可能较大
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
