namespace PrdAgent.Core.Interfaces;

/// <summary>
/// OpenRouter 视频生成 API 封装（走 ILlmGateway.SendRawWithResolutionAsync）
/// 文档：https://openrouter.ai/docs/guides/overview/multimodal/video-generation
/// 端点：
///   - POST /videos          提交任务
///   - GET  /videos/{jobId}  轮询状态
///
/// AppCallerCode 决定走哪个模型池（通过 Gateway 解析），ApiKey 来自平台配置，
/// 不依赖 IConfiguration / 环境变量。
/// </summary>
public interface IOpenRouterVideoClient
{
    /// <summary>提交视频生成任务，返回 OpenRouter jobId</summary>
    Task<OpenRouterVideoSubmitResult> SubmitAsync(OpenRouterVideoSubmitRequest request, CancellationToken ct = default);

    /// <summary>查询任务状态</summary>
    Task<OpenRouterVideoStatus> GetStatusAsync(string appCallerCode, string jobId, CancellationToken ct = default);
}

public class OpenRouterVideoSubmitRequest
{
    /// <summary>AppCallerCode（决定走哪个模型池）</summary>
    public string AppCallerCode { get; set; } = string.Empty;

    /// <summary>模型 id 偏好（如 alibaba/wan-2.6）；留空由 Gateway 从池中自动选择</summary>
    public string? Model { get; set; }

    /// <summary>视频描述 prompt</summary>
    public string Prompt { get; set; } = string.Empty;

    /// <summary>宽高比：16:9, 9:16, 1:1, 4:3, 3:4, 21:9, 9:21</summary>
    public string? AspectRatio { get; set; }

    /// <summary>分辨率：480p, 720p, 1080p, 1K, 2K, 4K</summary>
    public string? Resolution { get; set; }

    /// <summary>时长（秒）</summary>
    public int? DurationSeconds { get; set; }

    /// <summary>是否生成音频</summary>
    public bool? GenerateAudio { get; set; }

    /// <summary>随机种子</summary>
    public int? Seed { get; set; }

    /// <summary>用户上下文（可选，用于日志追踪）</summary>
    public string? UserId { get; set; }

    /// <summary>请求 ID（可选，用于日志追踪）</summary>
    public string? RequestId { get; set; }
}

public class OpenRouterVideoSubmitResult
{
    public bool Success { get; set; }
    public string? JobId { get; set; }
    public string? ErrorMessage { get; set; }
    /// <summary>估算成本（若 API 返回）</summary>
    public double? Cost { get; set; }
    /// <summary>实际使用的模型 id（Gateway 解析结果）</summary>
    public string? ActualModel { get; set; }
}

public class OpenRouterVideoStatus
{
    /// <summary>OpenRouter 原始 status：pending / in_progress / completed / failed / cancelled / expired</summary>
    public string Status { get; set; } = "pending";

    /// <summary>生成完成后的 MP4 下载 URL</summary>
    public string? VideoUrl { get; set; }

    /// <summary>失败时的错误信息</summary>
    public string? ErrorMessage { get; set; }

    /// <summary>最终费用</summary>
    public double? Cost { get; set; }

    public bool IsCompleted => Status == "completed";
    public bool IsFailed => Status is "failed" or "cancelled" or "expired";
    public bool IsTerminal => IsCompleted || IsFailed;
}
