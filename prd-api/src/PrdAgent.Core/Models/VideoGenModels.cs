namespace PrdAgent.Core.Models;

/// <summary>
/// 视频生成任务状态（纯 OpenRouter 直出模式）
/// 历史：原本有 Scripting / Editing 阶段（分镜流程），2026-04-27 砍掉 Remotion 后简化
/// </summary>
public static class VideoGenRunStatus
{
    /// <summary>用户已提交，等待 worker 拾取</summary>
    public const string Queued = "Queued";

    /// <summary>正在调 OpenRouter 提交 + 轮询视频结果</summary>
    public const string Rendering = "Rendering";

    /// <summary>视频已就绪</summary>
    public const string Completed = "Completed";

    /// <summary>任务失败</summary>
    public const string Failed = "Failed";

    /// <summary>用户取消</summary>
    public const string Cancelled = "Cancelled";
}

/// <summary>
/// 视频生成任务（MongoDB 文档模型）
/// 流程：用户输入 prompt → OpenRouter 视频大模型生成 → VideoAssetUrl 落 COS
/// </summary>
public class VideoGenRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string AppKey { get; set; } = "video-agent";
    public string Status { get; set; } = VideoGenRunStatus.Queued;

    // ─── 输入 ───
    /// <summary>用户视频描述 prompt（OpenRouter 直接消费）</summary>
    public string DirectPrompt { get; set; } = string.Empty;

    /// <summary>任务标题（可选，用于列表展示）</summary>
    public string? ArticleTitle { get; set; }

    // ─── OpenRouter 参数 ───

    /// <summary>选择的模型 id（如 alibaba/wan-2.6、google/veo-3.1）；空则由模型池决定</summary>
    public string? DirectVideoModel { get; set; }

    /// <summary>宽高比：16:9 / 9:16 / 1:1 等</summary>
    public string? DirectAspectRatio { get; set; }

    /// <summary>分辨率：480p / 720p / 1080p 等</summary>
    public string? DirectResolution { get; set; }

    /// <summary>时长（秒）</summary>
    public int? DirectDuration { get; set; }

    // ─── OpenRouter 调用结果 ───

    /// <summary>OpenRouter 返回的 jobId（用于轮询）</summary>
    public string? DirectVideoJobId { get; set; }

    /// <summary>OpenRouter 返回的成本（美元）</summary>
    public double? DirectVideoCost { get; set; }

    /// <summary>最终视频 URL（落 COS 后）</summary>
    public string? VideoAssetUrl { get; set; }

    // ─── 进度追踪 ───
    public string CurrentPhase { get; set; } = "queued";
    public int PhaseProgress { get; set; }

    /// <summary>总时长（兼容旧前端字段，与 DirectDuration 一致）</summary>
    public double TotalDurationSeconds { get; set; }

    // ─── 元数据 ───
    public string OwnerAdminId { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public bool CancelRequested { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
}

/// <summary>
/// 创建视频生成任务请求
/// </summary>
public class CreateVideoGenRunRequest
{
    /// <summary>用户 prompt（必填）</summary>
    public string? DirectPrompt { get; set; }

    /// <summary>任务标题（可选）</summary>
    public string? ArticleTitle { get; set; }

    /// <summary>模型 id（默认 alibaba/wan-2.6，按秒价升序见前端 OPENROUTER_VIDEO_MODELS）</summary>
    public string? DirectVideoModel { get; set; }

    /// <summary>宽高比（默认 16:9）</summary>
    public string? DirectAspectRatio { get; set; }

    /// <summary>分辨率（默认 720p）</summary>
    public string? DirectResolution { get; set; }

    /// <summary>时长秒数（默认 5）</summary>
    public int? DirectDuration { get; set; }

    // ─── 兼容字段（旧前端可能传，后端忽略或自动转化） ───

    /// <summary>已废弃：原 Remotion 路径用，现在如果只传 articleMarkdown 没传 directPrompt，自动当 prompt 用</summary>
    public string? ArticleMarkdown { get; set; }

    /// <summary>已废弃：原 PRD 模式用</summary>
    public List<string>? AttachmentIds { get; set; }
}
