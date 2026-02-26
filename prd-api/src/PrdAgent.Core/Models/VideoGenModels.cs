namespace PrdAgent.Core.Models;

/// <summary>
/// 视频生成任务状态
/// </summary>
public static class VideoGenRunStatus
{
    public const string Queued = "Queued";
    public const string Scripting = "Scripting";
    public const string Producing = "Producing";
    public const string Rendering = "Rendering";
    public const string Packaging = "Packaging";
    public const string Completed = "Completed";
    public const string Failed = "Failed";
    public const string Cancelled = "Cancelled";
}

/// <summary>
/// 视频生成任务（MongoDB 文档模型）
/// </summary>
public class VideoGenRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string AppKey { get; set; } = "video-agent";
    public string Status { get; set; } = VideoGenRunStatus.Queued;

    // 输入
    public string ArticleMarkdown { get; set; } = string.Empty;
    public string? ArticleTitle { get; set; }

    // 阶段一产出
    public List<VideoGenScene> Scenes { get; set; } = new();
    public double TotalDurationSeconds { get; set; }
    public string? ScriptMarkdown { get; set; }

    // 阶段二/三产出
    public string? VideoAssetUrl { get; set; }
    public string? SrtContent { get; set; }
    public string? NarrationDoc { get; set; }

    // 进度追踪
    public string CurrentPhase { get; set; } = "scripting";
    public int PhaseProgress { get; set; }

    // 元数据
    public string OwnerAdminId { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
    public bool CancelRequested { get; set; }
    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }
}

/// <summary>
/// 视频场景（镜头）定义
/// </summary>
public class VideoGenScene
{
    public int Index { get; set; }
    public string Topic { get; set; } = string.Empty;
    public string Narration { get; set; } = string.Empty;
    public string VisualDescription { get; set; } = string.Empty;
    public double DurationSeconds { get; set; }
    public string SceneType { get; set; } = "concept";
}

/// <summary>
/// 创建视频生成任务请求
/// </summary>
public class CreateVideoGenRunRequest
{
    public string? ArticleMarkdown { get; set; }
    public string? ArticleTitle { get; set; }
}
